import crypto from 'crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Client } from 'pg';
import { FRANCHISE_MAP } from '../data/franchises.ts';
import { formatSpokenPrice } from '../data/rulesets.ts';
import { createDedicatedClient, db } from '../db/index.ts';
import { auctionEvents, auctionRooms, schedulerLeases } from '../db/schema.ts';
import {
  decideAIRTMCounterBid,
  decideAIRTMFinalMatch,
  decideAIRTMOffer,
  selectNextAIBidder,
} from '../engine/aiEngine.ts';
import {
  closeCurrentLot,
  nominateNextPlayer,
  placeBid,
  respondToRtmFinalMatch,
  respondToRtmOffer,
  submitRtmCounter,
} from '../engine/auctionStateMachine.ts';
import type { AuctionState, Player } from '../engine/types.ts';
import { getMergedPlayerMap } from './adminService.ts';
import { pruneExpiredSessions } from './authService.ts';
import { SERVER_CONFIG } from './config.ts';
import { publishRoomUpdate } from './pubsub.ts';
import { pruneExpiredRateLimitBuckets } from './rateLimitService.ts';
import {
  deriveRoomStatus,
  reconcileDisconnectedParticipantsForRoom,
  type CommittedRoomMutation,
} from './roomRepository.ts';

// Stable 64-bit integer advisory lock key derived for IPL Auction Arena scheduler
const SCHEDULER_ADVISORY_LOCK_KEY = 7102027001;
const SCHEDULER_LEASE_KEY = 'auction_room_scheduler';

export type SchedulerBroadcastCallback = (mutation: CommittedRoomMutation) => void;

/**
 * Processes a single room tick transactionally using FOR UPDATE SKIP LOCKED.
 * Preserves the exact auction rules, AI cadence (NORMAL/FAST/BLITZ), Going Once / Twice,
 * 3-stage RTM AI/timeouts, and SOLD/UNSOLD transitions (including overdue post-restart recovery).
 */
export async function tickSingleRoom(
  roomId: string,
  playerMap: Record<string, Player>,
  nowMs = Date.now()
): Promise<CommittedRoomMutation | null> {
  const now = new Date(nowMs);

  const committed = await db.transaction(async (tx): Promise<CommittedRoomMutation | null> => {
    const lockRes = await tx.execute(
      sql`SELECT id FROM auction_rooms WHERE id = ${roomId} FOR UPDATE SKIP LOCKED`
    );
    if (!lockRes.rows || lockRes.rows.length === 0) {
      return null; // Locked by another concurrent transaction; skip cleanly
    }

    const found = await tx.select().from(auctionRooms).where(eq(auctionRooms.id, roomId)).limit(1);
    const room = found[0];
    if (!room || room.status === 'EXPIRED' || room.status === 'COMPLETED') {
      return null;
    }

    // Expire overdue rooms cleanly
    if (room.expiresAt <= now) {
      await tx
        .update(auctionRooms)
        .set({ status: 'EXPIRED', updatedAt: now })
        .where(eq(auctionRooms.id, room.id));
      return null;
    }

    let state: AuctionState = room.auctionStateJson;
    const { phase } = state;
    let goingOnceSent = room.goingOnceSent;
    let goingTwiceSent = room.goingTwiceSent;
    let lastAiBidAt = room.lastAiBidAt;
    let lotTransitionAt = room.lotTransitionAt;

    let nextState: AuctionState | null = null;
    let wsEventType: string | null = null;
    let auditEventType: string | null = null;
    let auditFranchiseId: string | null = null;
    let auditPlayerId: string | null = state.currentPlayerId;
    let auditPayload: Record<string, unknown> = {};
    let shouldPersistAuditEvent = true;

    // 1) Post-SOLD / post-UNSOLD transition (also recovers overdue transitions after restart!)
    if ((phase === 'SOLD' || phase === 'UNSOLD') && lotTransitionAt && nowMs >= lotTransitionAt) {
      lotTransitionAt = null;
      goingOnceSent = false;
      goingTwiceSent = false;
      lastAiBidAt = nowMs;
      nextState = nominateNextPlayer(state, playerMap, nowMs);
      wsEventType = 'lot:next';
      auditEventType = nextState.phase === 'COMPLETED' ? 'AUCTION_COMPLETED' : 'PLAYER_NOMINATED';
      auditPlayerId = nextState.currentPlayerId;
      auditPayload = { phase: nextState.phase };
    }
    // 2) 3-stage RTM automated AI decisions & timeouts
    else if (
      (phase === 'RTM_OFFER' || phase === 'RTM_COUNTER' || phase === 'RTM_FINAL_MATCH') &&
      state.rtmState
    ) {
      const rtm = state.rtmState;
      const player = playerMap[rtm.playerId];
      const remainingMs = state.countdownEndsAt ? state.countdownEndsAt - nowMs : 0;
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

      if (player) {
        if (phase === 'RTM_OFFER') {
          const rtmTeam = state.teams[rtm.rtmFranchiseId];
          if (rtmTeam.controllerType === 'AI' && nowMs - state.updatedAt >= 1200) {
            const useRtm = decideAIRTMOffer(
              state,
              rtm.rtmFranchiseId,
              player,
              rtm.initialBidCr,
              playerMap
            );
            nextState = respondToRtmOffer(state, useRtm, playerMap, nowMs);
            if (nextState.phase === 'SOLD') {
              lotTransitionAt = nowMs + 4800;
              wsEventType = 'lot:sold';
              auditEventType = 'AI_RTM_DECLINED_SOLD';
            } else {
              wsEventType = 'rtm:update';
              auditEventType = 'AI_RTM_ACCEPTED';
            }
            auditFranchiseId = rtm.rtmFranchiseId;
            auditPlayerId = player.id;
            auditPayload = { useRtm };
          } else if (remainingSec <= 0) {
            nextState = respondToRtmOffer(state, false, playerMap, nowMs);
            lotTransitionAt = nowMs + 4800;
            wsEventType = 'lot:sold';
            auditEventType = 'RTM_OFFER_TIMEOUT_SOLD';
            auditFranchiseId = rtm.rtmFranchiseId;
            auditPlayerId = player.id;
          }
        } else if (phase === 'RTM_COUNTER') {
          const winTeam = state.teams[rtm.winningFranchiseId];
          if (winTeam.controllerType === 'AI' && nowMs - state.updatedAt >= 1200) {
            const counterCr = decideAIRTMCounterBid(
              state,
              rtm.winningFranchiseId,
              player,
              rtm.initialBidCr,
              playerMap
            );
            nextState = submitRtmCounter(state, counterCr, playerMap, nowMs);
            if (nextState.phase === 'SOLD') {
              lotTransitionAt = nowMs + 4800;
              wsEventType = 'lot:sold';
              auditEventType = 'AI_RTM_COUNTER_SKIPPED_SOLD';
            } else {
              wsEventType = 'rtm:update';
              auditEventType = 'AI_RTM_COUNTER_SUBMITTED';
            }
            auditFranchiseId = rtm.winningFranchiseId;
            auditPlayerId = player.id;
            auditPayload = { counterCr };
          } else if (remainingSec <= 0) {
            nextState = submitRtmCounter(state, null, playerMap, nowMs);
            lotTransitionAt = nowMs + 4800;
            wsEventType = 'lot:sold';
            auditEventType = 'RTM_COUNTER_TIMEOUT_SOLD';
            auditFranchiseId = rtm.winningFranchiseId;
            auditPlayerId = player.id;
          }
        } else if (phase === 'RTM_FINAL_MATCH') {
          const rtmTeam = state.teams[rtm.rtmFranchiseId];
          const counterCr = rtm.counterBidCr ?? rtm.initialBidCr;
          if (rtmTeam.controllerType === 'AI' && nowMs - state.updatedAt >= 1200) {
            const match = decideAIRTMFinalMatch(
              state,
              rtm.rtmFranchiseId,
              player,
              counterCr,
              playerMap
            );
            nextState = respondToRtmFinalMatch(state, match, playerMap, nowMs);
            lotTransitionAt = nowMs + 4800;
            wsEventType = 'lot:sold';
            auditEventType = match ? 'AI_RTM_FINAL_MATCHED' : 'AI_RTM_FINAL_DECLINED';
            auditFranchiseId = rtm.rtmFranchiseId;
            auditPlayerId = player.id;
            auditPayload = { match, counterCr };
          } else if (remainingSec <= 0) {
            nextState = respondToRtmFinalMatch(state, false, playerMap, nowMs);
            lotTransitionAt = nowMs + 4800;
            wsEventType = 'lot:sold';
            auditEventType = 'RTM_FINAL_TIMEOUT_SOLD';
            auditFranchiseId = rtm.rtmFranchiseId;
            auditPlayerId = player.id;
          }
        }
      }

      if (!nextState && remainingSec !== state.countdownRemainingSec) {
        nextState = { ...state, countdownRemainingSec: remainingSec };
        wsEventType = 'timer:tick';
        shouldPersistAuditEvent = false;
      }
    }
    // 3) Live bidding phases: OPENING_BID / BIDDING / COUNTDOWN
    else if (
      (phase === 'OPENING_BID' || phase === 'BIDDING' || phase === 'COUNTDOWN') &&
      state.countdownEndsAt
    ) {
      // Hold countdown & AI bidding while auctioneer introduces "The next player is..."
      if (state.biddingOpensAt && nowMs < state.biddingOpensAt) {
        return null;
      }

      const remainingMs = state.countdownEndsAt - nowMs;
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      const aiCooldownMs =
        state.auctionSpeed === 'BLITZ' ? 750 : state.auctionSpeed === 'FAST' ? 1050 : 1400;

      // AI bid check
      if (remainingMs > 800 && nowMs - lastAiBidAt >= aiCooldownMs) {
        const decision = selectNextAIBidder(state, playerMap);
        lastAiBidAt = nowMs;
        if (decision && state.currentPlayerId) {
          const player = playerMap[state.currentPlayerId];
          if (player) {
            const result = placeBid(state, decision.franchiseId, player, {
              proposedAmountCr: decision.bidAmountCr,
              isAI: true,
              aiReason: decision.reason,
              now: nowMs,
            });
            if (result.accepted) {
              nextState = result.state;
              goingOnceSent = false;
              goingTwiceSent = false;
              wsEventType = 'bid:placed';
              auditEventType = 'AI_BID_PLACED';
              auditFranchiseId = decision.franchiseId;
              auditPlayerId = player.id;
              auditPayload = {
                amountCr: result.state.currentBidCr,
                reason: decision.reason,
              };
            }
          }
        }
        // Persist updated lastAiBidAt even if no AI decided to bid so cooldown stays accurate across restarts
        if (!nextState) {
          await tx
            .update(auctionRooms)
            .set({ lastAiBidAt })
            .where(eq(auctionRooms.id, room.id));
        }
      }

      // Countdown expiration -> Close Lot (SOLD / UNSOLD / RTM_OFFER)
      if (!nextState && remainingSec <= 0) {
        nextState = closeCurrentLot(state, playerMap, nowMs);
        if (nextState.phase === 'RTM_OFFER') {
          wsEventType = 'rtm:offer';
          auditEventType = 'RTM_OFFER_OPENED';
        } else {
          const delayMs = nextState.auctionSpeed === 'BLITZ' ? 3800 : 5400;
          lotTransitionAt = nowMs + delayMs;
          wsEventType = nextState.phase === 'SOLD' ? 'lot:sold' : 'lot:unsold';
          auditEventType = nextState.phase === 'SOLD' ? 'PLAYER_SOLD' : 'PLAYER_UNSOLD';
          auditFranchiseId = nextState.currentBidderId;
        }
        auditPlayerId = state.currentPlayerId;
        auditPayload = {
          finalBidCr: state.currentBidCr,
          phase: nextState.phase,
        };
      }

      // Going Once / Going Twice / Timer Tick
      if (!nextState) {
        let updatedState = state;
        let changed = false;
        if (remainingSec !== state.countdownRemainingSec) {
          updatedState = {
            ...updatedState,
            countdownRemainingSec: remainingSec,
            phase:
              remainingSec <= state.ruleset.goingOnceAtSeconds ? 'COUNTDOWN' : updatedState.phase,
          };
          changed = true;
        }

        if (
          updatedState.hasOpeningBid &&
          remainingSec <= updatedState.ruleset.goingOnceAtSeconds &&
          remainingSec > updatedState.ruleset.goingTwiceAtSeconds &&
          !goingOnceSent
        ) {
          goingOnceSent = true;
          const leader = updatedState.currentBidderId
            ? FRANCHISE_MAP[updatedState.currentBidderId].shortName
            : 'Current bidder';
          nextState = {
            ...updatedState,
            lastAnnouncement: `${leader} is with ${formatSpokenPrice(updatedState.currentBidCr)}, going once!`,
          };
          wsEventType = 'call:going_once';
          auditEventType = 'GOING_ONCE';
          auditFranchiseId = updatedState.currentBidderId;
        } else if (
          updatedState.hasOpeningBid &&
          remainingSec <= updatedState.ruleset.goingTwiceAtSeconds &&
          !goingTwiceSent
        ) {
          goingTwiceSent = true;
          nextState = {
            ...updatedState,
            lastAnnouncement: 'Going twice!',
          };
          wsEventType = 'call:going_twice';
          auditEventType = 'GOING_TWICE';
          auditFranchiseId = updatedState.currentBidderId;
        } else if (changed) {
          nextState = updatedState;
          wsEventType = 'timer:tick';
          shouldPersistAuditEvent = false;
        }
      }
    }

    if (!nextState || !wsEventType) {
      return null;
    }

    const nextVersion = room.stateVersion + 1;
    const nextStatus = deriveRoomStatus(nextState.phase);

    await tx
      .update(auctionRooms)
      .set({
        status: nextStatus,
        auctionStateJson: nextState,
        stateVersion: nextVersion,
        goingOnceSent,
        goingTwiceSent,
        lastAiBidAt,
        lotTransitionAt,
        updatedAt: now,
      })
      .where(eq(auctionRooms.id, room.id));

    if (shouldPersistAuditEvent && auditEventType) {
      await tx.insert(auctionEvents).values({
        id: `evt_${crypto.randomBytes(8).toString('hex')}`,
        roomId: room.id,
        eventType: auditEventType,
        actorId: 'scheduler',
        franchiseId: auditFranchiseId,
        playerId: auditPlayerId,
        requestId: null,
        eventPayloadJson: auditPayload,
        stateVersion: nextVersion,
        createdAt: now,
      });
    }

    return {
      roomId: room.id,
      roomCode: room.roomCode,
      state: nextState,
      stateVersion: nextVersion,
      eventType: wsEventType,
    };
  });

  if (committed) {
    await publishRoomUpdate(committed.roomCode, committed.eventType, committed.stateVersion);
  }
  return committed;
}

/**
 * Multi-instance-safe auction scheduler coordinator.
 * Uses a PostgreSQL session advisory lock (`pg_try_advisory_lock`) on a dedicated client
 * so strictly ONE worker across all running server instances drives room countdowns,
 * AI bids, RTM transitions, and lot closings at any moment.
 * If the leader crashes, PostgreSQL releases the advisory lock immediately for automatic failover.
 */
export class AuctionSchedulerWorker {
  private lockClient: Client | null = null;
  private holdsLock = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private running = false;
  private lastCleanupAt = 0;
  private lastLockAttemptAt = 0;
  private onBroadcast: SchedulerBroadcastCallback;
  private instanceId: string;
  private advisoryLockKey: number;

  constructor(
    onBroadcast: SchedulerBroadcastCallback,
    instanceId = SERVER_CONFIG.INSTANCE_ID,
    advisoryLockKey = SCHEDULER_ADVISORY_LOCK_KEY
  ) {
    this.onBroadcast = onBroadcast;
    this.instanceId = instanceId;
    this.advisoryLockKey = advisoryLockKey;
  }

  get isLeader(): boolean {
    return this.holdsLock;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, SERVER_CONFIG.SCHEDULER_TICK_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.releaseAdvisoryLock();
  }

  async acquireAdvisoryLock(): Promise<boolean> {
    if (this.holdsLock && this.lockClient) {
      return true;
    }
    const now = Date.now();
    // Avoid hammering DB if connection failed recently
    if (now - this.lastLockAttemptAt < 2000) {
      return false;
    }
    this.lastLockAttemptAt = now;

    try {
      if (!this.lockClient) {
        const client = createDedicatedClient();
        client.on('error', () => {
          this.holdsLock = false;
          this.lockClient = null;
        });
        client.on('end', () => {
          this.holdsLock = false;
          this.lockClient = null;
        });
        await client.connect();
        this.lockClient = client;
      }

      const res = await this.lockClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [this.advisoryLockKey]
      );
      this.holdsLock = Boolean(res.rows[0]?.locked);

      if (this.holdsLock) {
        await this.refreshLeaseRow();
      }
      return this.holdsLock;
    } catch (error) {
      console.warn(
        '[Scheduler] Advisory lock attempt failed:',
        error instanceof Error ? error.message : String(error)
      );
      this.holdsLock = false;
      if (this.lockClient) {
        try {
          await this.lockClient.end();
        } catch {
          // ignore
        }
        this.lockClient = null;
      }
      return false;
    }
  }

  async releaseAdvisoryLock(): Promise<void> {
    const client = this.lockClient;
    this.holdsLock = false;
    this.lockClient = null;
    if (!client) return;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [this.advisoryLockKey]);
    } catch {
      // ignore
    }
    try {
      await client.end();
    } catch {
      // ignore
    }
  }

  private async refreshLeaseRow(): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SERVER_CONFIG.SCHEDULER_LEASE_MS);
    try {
      await db
        .insert(schedulerLeases)
        .values({
          leaseKey: SCHEDULER_LEASE_KEY,
          ownerId: this.instanceId,
          expiresAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schedulerLeases.leaseKey,
          set: {
            ownerId: this.instanceId,
            expiresAt,
            updatedAt: now,
          },
        });
    } catch {
      // Non-fatal observability lease update
    }
  }

  /**
   * Executes one full scheduler pass across all active rooms if this instance holds the advisory lock.
   * Exposed publicly so automated tests can run deterministic ticks & verify multi-instance contention.
   */
  async tick(nowMs = Date.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const hasLock = await this.acquireAdvisoryLock();
      if (!hasLock) return 0;

      const activeRooms = await db
        .select({ id: auctionRooms.id, status: auctionRooms.status })
        .from(auctionRooms)
        .where(inArray(auctionRooms.status, ['LOBBY', 'ACTIVE', 'PAUSED']));

      if (activeRooms.length === 0) {
        await this.maybeRunHousekeeping(nowMs);
        return 0;
      }

      const playerMap = await getMergedPlayerMap();
      let processed = 0;

      for (const r of activeRooms) {
        // Reconcile disconnected participants / host re-election
        const reconciled = await reconcileDisconnectedParticipantsForRoom(r.id, nowMs);
        if (reconciled) {
          this.onBroadcast(reconciled);
          processed += 1;
        }

        if (r.status === 'ACTIVE') {
          const mutation = await tickSingleRoom(r.id, playerMap, nowMs);
          if (mutation) {
            this.onBroadcast(mutation);
            processed += 1;
          }
        }
      }

      await this.maybeRunHousekeeping(nowMs);
      return processed;
    } catch (error) {
      console.error('[Scheduler] Tick failed:', error);
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  private async maybeRunHousekeeping(nowMs: number): Promise<void> {
    if (nowMs - this.lastCleanupAt < 60_000) return;
    this.lastCleanupAt = nowMs;
    await this.refreshLeaseRow();
    // Mark expired rooms
    try {
      await db
        .update(auctionRooms)
        .set({ status: 'EXPIRED', updatedAt: new Date(nowMs) })
        .where(
          and(
            inArray(auctionRooms.status, ['LOBBY', 'ACTIVE', 'PAUSED']),
            lt(auctionRooms.expiresAt, new Date(nowMs))
          )
        );
    } catch {
      // ignore
    }
    await pruneExpiredRateLimitBuckets();
    await pruneExpiredSessions();
  }
}
