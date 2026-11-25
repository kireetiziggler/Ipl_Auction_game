import crypto from 'crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises.ts';
import { getRulesetById } from '../data/rulesets.ts';
import { db } from '../db/index.ts';
import { auctionEvents, auctionRooms, roomParticipants } from '../db/schema.ts';
import {
  applyRetentions,
  completeAuction,
  createInitialAuctionState,
  enterRetentionPhase,
  nominateNextPlayer,
  passOnCurrentPlayer,
  pauseAuction,
  placeBid,
  respondToRtmFinalMatch,
  respondToRtmOffer,
  resumeAuction,
  startAuction,
  submitRtmCounter,
} from '../engine/auctionStateMachine.ts';
import type {
  AIDifficulty,
  AuctionPhase,
  AuctionState,
  FranchiseId,
  GameMode,
  NominationMode,
  Player,
  SeasonRuleset,
} from '../engine/types.ts';
import { getMergedPlayerMap, getMergedPlayers } from './adminService.ts';
import type { AuthenticatedSession } from './authService.ts';
import { isValidFranchiseId, sanitizeText, SERVER_CONFIG } from './config.ts';
import { publishRoomUpdate } from './pubsub.ts';

export class RoomError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface CommittedRoomMutation {
  roomId: string;
  roomCode: string;
  state: AuctionState;
  stateVersion: number;
  eventType: string;
  franchiseId?: FranchiseId;
  idempotentReplay?: boolean;
  rejected?: boolean;
  error?: string;
}

export function deriveRoomStatus(phase: AuctionPhase): 'LOBBY' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' {
  if (phase === 'LOBBY') return 'LOBBY';
  if (phase === 'PAUSED') return 'PAUSED';
  if (phase === 'COMPLETED') return 'COMPLETED';
  return 'ACTIVE';
}

function generateRandomRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}

function findAvailableFranchise(
  state: AuctionState,
  takenFranchises: Set<string>,
  desired?: FranchiseId
): FranchiseId | null {
  if (
    desired &&
    !takenFranchises.has(desired) &&
    state.teams[desired]?.controllerType === 'AI'
  ) {
    return desired;
  }
  for (const fid of ALL_FRANCHISE_IDS) {
    if (!takenFranchises.has(fid) && state.teams[fid]?.controllerType === 'AI') {
      return fid;
    }
  }
  return null;
}

export async function getRoomByCode(roomCode: string): Promise<{
  id: string;
  roomCode: string;
  status: string;
  state: AuctionState;
  stateVersion: number;
  expiresAt: Date;
} | null> {
  const normalized = sanitizeText(roomCode, 12).toUpperCase();
  if (!normalized) return null;
  try {
    const rows = await db
      .select()
      .from(auctionRooms)
      .where(and(eq(auctionRooms.roomCode, normalized), gt(auctionRooms.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row || row.status === 'EXPIRED') return null;
    return {
      id: row.id,
      roomCode: row.roomCode,
      status: row.status,
      state: row.auctionStateJson,
      stateVersion: row.stateVersion,
      expiresAt: row.expiresAt,
    };
  } catch (error) {
    console.error('[RoomRepo] getRoomByCode failed:', error);
    throw new RoomError(500, 'Could not retrieve auction room.');
  }
}

export async function getActiveRoomsCount(): Promise<number> {
  try {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auctionRooms)
      .where(
        and(
          gt(auctionRooms.expiresAt, new Date()),
          sql`${auctionRooms.status} IN ('LOBBY', 'ACTIVE', 'PAUSED')`
        )
      );
    return result[0]?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function createMultiplayerRoom(
  session: AuthenticatedSession,
  params: {
    username?: unknown;
    franchiseId?: unknown;
    mode?: unknown;
    rulesetId?: unknown;
    customRuleset?: Partial<SeasonRuleset>;
    aiDifficulty?: unknown;
    nominationMode?: unknown;
    auctionSpeed?: unknown;
  }
): Promise<CommittedRoomMutation> {
  const hostName = sanitizeText(params.username, 40) || session.username || 'Franchise Owner';
  const franchiseId: FranchiseId = isValidFranchiseId(params.franchiseId)
    ? params.franchiseId
    : session.favoriteFranchise;
  const mode: GameMode =
    typeof params.mode === 'string' &&
    ['SOLO', 'MULTIPLAYER', 'QUICK', 'FULL', 'PRACTICE', 'TOURNAMENT'].includes(params.mode)
      ? (params.mode as GameMode)
      : 'MULTIPLAYER';
  const baseRuleset = getRulesetById(
    typeof params.rulesetId === 'string' ? params.rulesetId : 'sim-2026-mega'
  );
  const ruleset: SeasonRuleset = params.customRuleset
    ? { ...baseRuleset, ...params.customRuleset }
    : baseRuleset;
  const aiDifficulty: AIDifficulty =
    typeof params.aiDifficulty === 'string' &&
    ['EASY', 'NORMAL', 'HARD', 'EXPERT'].includes(params.aiDifficulty)
      ? (params.aiDifficulty as AIDifficulty)
      : 'NORMAL';
  const nominationMode: NominationMode =
    params.nominationMode === 'MANAGER_NOMINATION' ? 'MANAGER_NOMINATION' : 'SET_ORDER';
  const auctionSpeed: 'NORMAL' | 'FAST' | 'BLITZ' =
    typeof params.auctionSpeed === 'string' &&
    ['NORMAL', 'FAST', 'BLITZ'].includes(params.auctionSpeed)
      ? (params.auctionSpeed as 'NORMAL' | 'FAST' | 'BLITZ')
      : 'NORMAL';

  const players = await getMergedPlayers();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SERVER_CONFIG.ROOM_RETENTION_HOURS * 3_600_000);

  for (let attempt = 0; attempt < 6; attempt++) {
    const roomCode = generateRandomRoomCode();
    const roomId = `room_${crypto.randomBytes(8).toString('hex')}`;
    const state = createInitialAuctionState({
      roomId,
      roomCode,
      hostId: session.sessionId,
      hostName,
      hostFranchiseId: franchiseId,
      mode,
      ruleset,
      aiDifficulty,
      nominationMode,
      auctionSpeed,
      players,
    });

    try {
      await db.transaction(async (tx) => {
        await tx.insert(auctionRooms).values({
          id: roomId,
          roomCode,
          hostUserId: session.userId,
          hostSessionId: session.sessionId,
          status: 'LOBBY',
          gameMode: mode,
          rulesetId: ruleset.id,
          auctionStateJson: state,
          stateVersion: 1,
          goingOnceSent: false,
          goingTwiceSent: false,
          lastAiBidAt: now.getTime(),
          lotTransitionAt: null,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        });

        await tx.insert(roomParticipants).values({
          id: `prt_${crypto.randomBytes(8).toString('hex')}`,
          roomId,
          userId: session.userId,
          sessionId: session.sessionId,
          username: hostName,
          franchiseId,
          isHost: true,
          isConnected: true,
          isReady: false,
          joinedAt: now,
          lastSeenAt: now,
          disconnectedAt: null,
        });

        await tx.insert(auctionEvents).values({
          id: `evt_${crypto.randomBytes(8).toString('hex')}`,
          roomId,
          eventType: 'ROOM_CREATED',
          actorId: session.sessionId,
          franchiseId,
          playerId: null,
          requestId: null,
          eventPayloadJson: {
            roomCode,
            mode,
            rulesetId: ruleset.id,
            hostName,
          },
          stateVersion: 1,
          createdAt: now,
        });
      });

      return {
        roomId,
        roomCode,
        state,
        stateVersion: 1,
        eventType: 'room:created',
        franchiseId,
      };
    } catch (error) {
      const pgCode =
        (error as { code?: string; cause?: { code?: string } })?.code ||
        (error as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === '23505' && attempt < 5) {
        continue; // Retry rare 6-char room code collision
      }
      console.error('[RoomRepo] createMultiplayerRoom failed:', error);
      throw new RoomError(500, 'Could not create multiplayer room.');
    }
  }

  throw new RoomError(500, 'Could not allocate a unique room code.');
}

/**
 * Joins or reconnects an authenticated participant into an authoritative room inside a row-locked transaction.
 * Enforces max 10 human franchises, unique (room, session), unique (room, franchise), and full state recovery.
 */
export async function joinOrReconnectRoom(
  roomCodeInput: string,
  session: AuthenticatedSession,
  options?: { username?: unknown; desiredFranchiseId?: unknown }
): Promise<CommittedRoomMutation> {
  const roomCode = sanitizeText(roomCodeInput, 12).toUpperCase();
  const username = sanitizeText(options?.username, 40) || session.username || 'Franchise Owner';
  const desiredFranchise = isValidFranchiseId(options?.desiredFranchiseId)
    ? options?.desiredFranchiseId
    : undefined;
  const now = new Date();
  const nowMs = now.getTime();

  try {
    const result = await db.transaction(async (tx) => {
      // Acquire row-level lock on room
      await tx.execute(
        sql`SELECT id FROM auction_rooms WHERE room_code = ${roomCode} FOR UPDATE`
      );

      const roomsFound = await tx
        .select()
        .from(auctionRooms)
        .where(eq(auctionRooms.roomCode, roomCode))
        .limit(1);
      const room = roomsFound[0];
      if (!room || room.status === 'EXPIRED' || room.expiresAt <= now) {
        throw new RoomError(404, `Room ${roomCode} was not found or has expired.`);
      }

      const participants = await tx
        .select()
        .from(roomParticipants)
        .where(eq(roomParticipants.roomId, room.id))
        .orderBy(asc(roomParticipants.joinedAt));

      let state: AuctionState = room.auctionStateJson;
      const teams = { ...state.teams };

      // 1) Check reconnection by exact sessionId OR same authenticated userId
      const existing = participants.find(
        (p) =>
          p.sessionId === session.sessionId ||
          (session.userId !== null && p.userId === session.userId)
      );

      let assignedFranchise: FranchiseId;
      let eventType = 'PARTICIPANT_JOINED';
      let nextHostSessionId = room.hostSessionId;

      if (existing) {
        assignedFranchise = existing.franchiseId as FranchiseId;
        eventType = 'PARTICIPANT_RECONNECTED';
        const oldSessionId = existing.sessionId;

        await tx
          .update(roomParticipants)
          .set({
            sessionId: session.sessionId,
            username,
            isConnected: true,
            lastSeenAt: now,
            disconnectedAt: null,
          })
          .where(eq(roomParticipants.id, existing.id));

        if (teams[assignedFranchise]) {
          teams[assignedFranchise] = {
            ...teams[assignedFranchise],
            controllerType: 'HUMAN',
            ownerId: session.sessionId,
            ownerName: username,
            isConnected: true,
          };
        }

        // If this participant is still host and reconnected under a new session (same userId), keep hostId synced
        if (existing.isHost || state.hostId === oldSessionId) {
          nextHostSessionId = session.sessionId;
          state = { ...state, hostId: session.sessionId };
        }
      } else {
        if (participants.length >= 10) {
          throw new RoomError(409, 'All 10 franchises are already taken in this room.');
        }
        const taken = new Set(participants.map((p) => p.franchiseId));
        const target = findAvailableFranchise(state, taken, desiredFranchise);
        if (!target) {
          throw new RoomError(409, 'All 10 franchises are already taken in this room.');
        }

        assignedFranchise = target;
        await tx.insert(roomParticipants).values({
          id: `prt_${crypto.randomBytes(8).toString('hex')}`,
          roomId: room.id,
          userId: session.userId,
          sessionId: session.sessionId,
          username,
          franchiseId: assignedFranchise,
          isHost: false,
          isConnected: true,
          isReady: false,
          joinedAt: now,
          lastSeenAt: now,
          disconnectedAt: null,
        });

        teams[assignedFranchise] = {
          ...teams[assignedFranchise],
          controllerType: 'HUMAN',
          ownerId: session.sessionId,
          ownerName: username,
          isConnected: true,
          isReady: false,
        };
      }

      const nextVersion = room.stateVersion + 1;
      const nextState: AuctionState = {
        ...state,
        teams,
        updatedAt: nowMs,
      };
      const nextExpiresAt = new Date(nowMs + SERVER_CONFIG.ROOM_RETENTION_HOURS * 3_600_000);

      await tx
        .update(auctionRooms)
        .set({
          hostSessionId: nextHostSessionId,
          auctionStateJson: nextState,
          stateVersion: nextVersion,
          updatedAt: now,
          expiresAt: nextExpiresAt,
        })
        .where(eq(auctionRooms.id, room.id));

      await tx.insert(auctionEvents).values({
        id: `evt_${crypto.randomBytes(8).toString('hex')}`,
        roomId: room.id,
        eventType,
        actorId: session.sessionId,
        franchiseId: assignedFranchise,
        playerId: null,
        requestId: null,
        eventPayloadJson: { username, franchiseId: assignedFranchise },
        stateVersion: nextVersion,
        createdAt: now,
      });

      return {
        roomId: room.id,
        roomCode: room.roomCode,
        state: nextState,
        stateVersion: nextVersion,
        eventType: 'state:sync',
        franchiseId: assignedFranchise,
      };
    });

    await publishRoomUpdate(result.roomCode, result.eventType, result.stateVersion);
    return result;
  } catch (error) {
    if (error instanceof RoomError) throw error;
    const pgCode =
      (error as { code?: string; cause?: { code?: string } })?.code ||
      (error as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === '23505') {
      throw new RoomError(409, 'Franchise already claimed. Please pick another franchise.');
    }
    console.error('[RoomRepo] joinOrReconnectRoom failed:', error);
    throw new RoomError(500, 'Could not join multiplayer room.');
  }
}

export async function markParticipantDisconnected(
  roomCodeInput: string,
  sessionId: string
): Promise<CommittedRoomMutation | null> {
  const roomCode = sanitizeText(roomCodeInput, 12).toUpperCase();
  const now = new Date();
  const nowMs = now.getTime();

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM auction_rooms WHERE room_code = ${roomCode} FOR UPDATE`
      );
      const roomsFound = await tx
        .select()
        .from(auctionRooms)
        .where(eq(auctionRooms.roomCode, roomCode))
        .limit(1);
      const room = roomsFound[0];
      if (!room) return null;

      const participants = await tx
        .select()
        .from(roomParticipants)
        .where(eq(roomParticipants.roomId, room.id))
        .orderBy(asc(roomParticipants.joinedAt));

      const target = participants.find((p) => p.sessionId === sessionId);
      if (!target) return null;

      await tx
        .update(roomParticipants)
        .set({
          isConnected: false,
          disconnectedAt: now,
          lastSeenAt: now,
        })
        .where(eq(roomParticipants.id, target.id));

      const fid = target.franchiseId as FranchiseId;
      let nextState: AuctionState = {
        ...room.auctionStateJson,
        teams: {
          ...room.auctionStateJson.teams,
          [fid]: {
            ...room.auctionStateJson.teams[fid],
            isConnected: false,
          },
        },
        updatedAt: nowMs,
      };

      const nextVersion = room.stateVersion + 1;
      await tx
        .update(auctionRooms)
        .set({
          auctionStateJson: nextState,
          stateVersion: nextVersion,
          updatedAt: now,
        })
        .where(eq(auctionRooms.id, room.id));

      await tx.insert(auctionEvents).values({
        id: `evt_${crypto.randomBytes(8).toString('hex')}`,
        roomId: room.id,
        eventType: 'PARTICIPANT_DISCONNECTED',
        actorId: sessionId,
        franchiseId: fid,
        playerId: null,
        requestId: null,
        eventPayloadJson: { username: target.username },
        stateVersion: nextVersion,
        createdAt: now,
      });

      return {
        roomId: room.id,
        roomCode: room.roomCode,
        state: nextState,
        stateVersion: nextVersion,
        eventType: 'state:sync',
        franchiseId: fid,
      };
    });

    if (result) {
      await publishRoomUpdate(result.roomCode, result.eventType, result.stateVersion);
    }
    return result;
  } catch (error) {
    console.error('[RoomRepo] markParticipantDisconnected failed:', error);
    return null;
  }
}

export async function updateParticipantHeartbeat(roomCodeInput: string, sessionId: string): Promise<void> {
  const roomCode = sanitizeText(roomCodeInput, 12).toUpperCase();
  try {
    const roomsFound = await db
      .select({ id: auctionRooms.id })
      .from(auctionRooms)
      .where(eq(auctionRooms.roomCode, roomCode))
      .limit(1);
    if (!roomsFound[0]) return;
    await db
      .update(roomParticipants)
      .set({ lastSeenAt: new Date(), isConnected: true, disconnectedAt: null })
      .where(
        and(
          eq(roomParticipants.roomId, roomsFound[0].id),
          eq(roomParticipants.sessionId, sessionId)
        )
      );
  } catch {
    // Non-fatal heartbeat update
  }
}

export type RoomActionPayload =
  | { type: 'lobby:select_franchise'; franchiseId: FranchiseId }
  | { type: 'lobby:toggle_ready'; ready?: boolean }
  | {
      type: 'lobby:update_settings';
      settings: {
        aiDifficulty?: AIDifficulty;
        auctionSpeed?: 'NORMAL' | 'FAST' | 'BLITZ';
        rulesetId?: string;
        nominationMode?: NominationMode;
      };
    }
  | { type: 'lobby:enter_retention' }
  | { type: 'retention:confirm'; selections?: Partial<Record<FranchiseId, string[]>> }
  | { type: 'auction:start' }
  | { type: 'auction:bid'; amountCr?: number; requestId?: string }
  | { type: 'auction:pass' }
  | { type: 'auction:rtm_offer'; useRtm: boolean }
  | { type: 'auction:rtm_counter'; counterBidCr: number | null }
  | { type: 'auction:rtm_final'; matchCounter: boolean }
  | { type: 'auction:pause' }
  | { type: 'auction:resume' }
  | { type: 'auction:nominate'; playerId: string }
  | { type: 'auction:finish_now' };

/**
 * Executes any authoritative human room action inside a PostgreSQL transaction
 * with row-level lock (`FOR UPDATE`), strict participant/host authorization,
 * bid idempotency (`requestId`), optimistic `state_version` increment, and audit event insertion.
 * Publishes cross-instance NOTIFY only AFTER commit.
 */
export async function executeRoomAction(
  roomCodeInput: string,
  session: AuthenticatedSession,
  action: RoomActionPayload
): Promise<CommittedRoomMutation> {
  const roomCode = sanitizeText(roomCodeInput, 12).toUpperCase();
  const playerMap: Record<string, Player> = await getMergedPlayerMap();
  const now = new Date();
  const nowMs = now.getTime();

  const committed = await db.transaction(async (tx): Promise<CommittedRoomMutation> => {
    await tx.execute(
      sql`SELECT id FROM auction_rooms WHERE room_code = ${roomCode} FOR UPDATE`
    );

    const roomsFound = await tx
      .select()
      .from(auctionRooms)
      .where(eq(auctionRooms.roomCode, roomCode))
      .limit(1);
    const room = roomsFound[0];
    if (!room || room.status === 'EXPIRED' || room.expiresAt <= now) {
      throw new RoomError(404, `Room ${roomCode} was not found or has expired.`);
    }

    const participants = await tx
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, room.id));

    const actor = participants.find((p) => p.sessionId === session.sessionId);
    if (!actor) {
      throw new RoomError(403, 'You are not a participant in this room.');
    }

    const actorFranchise = actor.franchiseId as FranchiseId;
    const isHost = actor.isHost && room.hostSessionId === session.sessionId;
    let state: AuctionState = room.auctionStateJson;

    // Ensure actor's participant record stays fresh
    let goingOnceSent = room.goingOnceSent;
    let goingTwiceSent = room.goingTwiceSent;
    let lastAiBidAt = room.lastAiBidAt;
    let lotTransitionAt = room.lotTransitionAt;

    let nextState: AuctionState = state;
    let wsEventType = 'state:sync';
    let auditEventType = action.type.toUpperCase().replace(/:/g, '_');
    let auditPlayerId: string | null = state.currentPlayerId;
    let auditRequestId: string | null = null;
    let auditPayload: Record<string, unknown> = {};
    let assignedFranchise: FranchiseId | undefined;

    switch (action.type) {
      case 'lobby:select_franchise': {
        if (state.phase !== 'LOBBY') {
          throw new RoomError(400, 'Franchises can only be changed in the lobby.');
        }
        if (!isValidFranchiseId(action.franchiseId)) {
          throw new RoomError(400, 'Invalid franchise selected.');
        }
        if (action.franchiseId === actorFranchise) {
          return {
            roomId: room.id,
            roomCode: room.roomCode,
            state,
            stateVersion: room.stateVersion,
            eventType: 'franchise:assigned',
            franchiseId: actorFranchise,
          };
        }
        const alreadyTaken = participants.some((p) => p.franchiseId === action.franchiseId);
        if (alreadyTaken || state.teams[action.franchiseId].controllerType !== 'AI') {
          throw new RoomError(409, 'Franchise already claimed by another player.');
        }

        await tx
          .update(roomParticipants)
          .set({
            franchiseId: action.franchiseId,
            isReady: false,
            lastSeenAt: now,
          })
          .where(eq(roomParticipants.id, actor.id));

        const oldCfg = FRANCHISE_MAP[actorFranchise];
        const teams = { ...state.teams };
        teams[actorFranchise] = {
          ...teams[actorFranchise],
          controllerType: 'AI',
          ownerId: undefined,
          ownerName: `${oldCfg.ownerPersona} (AI)`,
          isReady: true,
          isConnected: true,
        };
        teams[action.franchiseId] = {
          ...teams[action.franchiseId],
          controllerType: 'HUMAN',
          ownerId: session.sessionId,
          ownerName: actor.username,
          isReady: false,
          isConnected: true,
        };
        nextState = { ...state, teams, updatedAt: nowMs };
        assignedFranchise = action.franchiseId;
        wsEventType = 'state:sync';
        auditPayload = { from: actorFranchise, to: action.franchiseId };
        break;
      }

      case 'lobby:toggle_ready': {
        if (state.phase !== 'LOBBY') {
          throw new RoomError(400, 'Ready status can only be toggled in the lobby.');
        }
        const t = state.teams[actorFranchise];
        const nextReady = action.ready ?? !t.isReady;
        await tx
          .update(roomParticipants)
          .set({ isReady: nextReady, lastSeenAt: now })
          .where(eq(roomParticipants.id, actor.id));
        nextState = {
          ...state,
          teams: {
            ...state.teams,
            [actorFranchise]: { ...t, isReady: nextReady },
          },
          updatedAt: nowMs,
        };
        auditPayload = { isReady: nextReady };
        break;
      }

      case 'lobby:update_settings': {
        if (state.phase !== 'LOBBY') {
          throw new RoomError(400, 'Settings can only be changed in the lobby.');
        }
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can update lobby settings.');
        }
        const s = action.settings || {};
        const nextRuleset = s.rulesetId ? getRulesetById(s.rulesetId) : state.ruleset;
        const teams = { ...state.teams };
        if (s.rulesetId) {
          for (const fid of ALL_FRANCHISE_IDS) {
            teams[fid] = {
              ...teams[fid],
              purseRemainingCr: nextRuleset.initialPurseCr,
              rtmRemaining: nextRuleset.allowRTM ? nextRuleset.rtmCardsPerTeam : 0,
            };
          }
        }
        const validDiff =
          s.aiDifficulty && ['EASY', 'NORMAL', 'HARD', 'EXPERT'].includes(s.aiDifficulty)
            ? s.aiDifficulty
            : state.aiDifficulty;
        const validSpeed =
          s.auctionSpeed && ['NORMAL', 'FAST', 'BLITZ'].includes(s.auctionSpeed)
            ? s.auctionSpeed
            : state.auctionSpeed;
        const validNom =
          s.nominationMode && ['SET_ORDER', 'MANAGER_NOMINATION'].includes(s.nominationMode)
            ? s.nominationMode
            : state.nominationMode;

        nextState = {
          ...state,
          ruleset: nextRuleset,
          teams,
          aiDifficulty: validDiff,
          auctionSpeed: validSpeed,
          nominationMode: validNom,
          updatedAt: nowMs,
        };
        auditPayload = {
          rulesetId: nextRuleset.id,
          aiDifficulty: validDiff,
          auctionSpeed: validSpeed,
          nominationMode: validNom,
        };
        break;
      }

      case 'lobby:enter_retention': {
        if (state.phase !== 'LOBBY') {
          throw new RoomError(400, 'Room is not in lobby phase.');
        }
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can open the retention desk.');
        }
        nextState = enterRetentionPhase(state, nowMs);
        wsEventType = 'retention:opened';
        break;
      }

      case 'retention:confirm': {
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can confirm retentions and start.');
        }
        if (state.phase !== 'RETENTION' && state.phase !== 'LOBBY' && state.phase !== 'READY') {
          throw new RoomError(400, 'Auction has already started.');
        }
        const withRetentions = applyRetentions(state, action.selections || {}, playerMap, nowMs);
        nextState = startAuction(withRetentions, playerMap, nowMs);
        lastAiBidAt = nowMs + 800;
        goingOnceSent = false;
        goingTwiceSent = false;
        lotTransitionAt = null;
        wsEventType = 'auction:started';
        auditPlayerId = nextState.currentPlayerId;
        break;
      }

      case 'auction:start': {
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can start the auction.');
        }
        if (state.phase !== 'LOBBY' && state.phase !== 'RETENTION' && state.phase !== 'READY') {
          throw new RoomError(400, 'Auction is already running or completed.');
        }
        const prepared = state.retentionsApplied
          ? state
          : applyRetentions(state, {}, playerMap, nowMs);
        nextState = startAuction(prepared, playerMap, nowMs);
        lastAiBidAt = nowMs + 800;
        goingOnceSent = false;
        goingTwiceSent = false;
        lotTransitionAt = null;
        wsEventType = 'auction:started';
        auditPlayerId = nextState.currentPlayerId;
        break;
      }

      case 'auction:bid': {
        const cleanReqId = sanitizeText(action.requestId, 64) || null;

        // Idempotency check: if this requestId was already committed in this room, return recorded state!
        if (cleanReqId) {
          if (state.processedRequestIds.includes(cleanReqId)) {
            return {
              roomId: room.id,
              roomCode: room.roomCode,
              state,
              stateVersion: room.stateVersion,
              eventType: 'bid:placed',
              franchiseId: actorFranchise,
              idempotentReplay: true,
            };
          }
          const existingEvt = await tx
            .select({ id: auctionEvents.id })
            .from(auctionEvents)
            .where(
              and(eq(auctionEvents.roomId, room.id), eq(auctionEvents.requestId, cleanReqId))
            )
            .limit(1);
          if (existingEvt.length > 0) {
            return {
              roomId: room.id,
              roomCode: room.roomCode,
              state,
              stateVersion: room.stateVersion,
              eventType: 'bid:placed',
              franchiseId: actorFranchise,
              idempotentReplay: true,
            };
          }
        }

        if (!state.currentPlayerId) {
          return {
            roomId: room.id,
            roomCode: room.roomCode,
            state,
            stateVersion: room.stateVersion,
            eventType: 'bid:rejected',
            rejected: true,
            error: 'No player is currently on the block.',
          };
        }

        const player = playerMap[state.currentPlayerId];
        if (!player) {
          return {
            roomId: room.id,
            roomCode: room.roomCode,
            state,
            stateVersion: room.stateVersion,
            eventType: 'bid:rejected',
            rejected: true,
            error: 'Current player record could not be found.',
          };
        }

        const bidResult = placeBid(state, actorFranchise, player, {
          proposedAmountCr: typeof action.amountCr === 'number' ? action.amountCr : undefined,
          requestId: cleanReqId || undefined,
          isAI: false,
          now: nowMs,
        });

        if (!bidResult.accepted) {
          return {
            roomId: room.id,
            roomCode: room.roomCode,
            state,
            stateVersion: room.stateVersion,
            eventType: 'bid:rejected',
            rejected: true,
            error: bidResult.error || 'Bid rejected.',
          };
        }

        nextState = bidResult.state;
        goingOnceSent = false;
        goingTwiceSent = false;
        lastAiBidAt = nowMs;
        wsEventType = 'bid:placed';
        auditEventType = 'BID_PLACED';
        auditRequestId = cleanReqId;
        auditPlayerId = player.id;
        auditPayload = {
          amountCr: nextState.currentBidCr,
          playerName: player.name,
          requestId: cleanReqId,
        };
        break;
      }

      case 'auction:pass': {
        nextState = passOnCurrentPlayer(state, actorFranchise, nowMs);
        auditEventType = 'TEAM_PASSED';
        auditPayload = { playerId: state.currentPlayerId };
        break;
      }

      case 'auction:rtm_offer': {
        if (
          state.phase !== 'RTM_OFFER' ||
          !state.rtmState ||
          state.rtmState.rtmFranchiseId !== actorFranchise
        ) {
          throw new RoomError(403, 'You are not authorized to respond to this RTM offer.');
        }
        nextState = respondToRtmOffer(state, Boolean(action.useRtm), playerMap, nowMs);
        if (nextState.phase === 'SOLD') {
          lotTransitionAt = nowMs + 4800;
          wsEventType = 'lot:sold';
          auditEventType = 'RTM_DECLINED_SOLD';
        } else {
          wsEventType = 'rtm:update';
          auditEventType = 'RTM_OFFER_ACCEPTED';
        }
        auditPayload = { useRtm: Boolean(action.useRtm) };
        break;
      }

      case 'auction:rtm_counter': {
        if (
          state.phase !== 'RTM_COUNTER' ||
          !state.rtmState ||
          state.rtmState.winningFranchiseId !== actorFranchise
        ) {
          throw new RoomError(403, 'You are not authorized to submit this RTM counter-bid.');
        }
        const counterVal = typeof action.counterBidCr === 'number' ? action.counterBidCr : null;
        nextState = submitRtmCounter(state, counterVal, playerMap, nowMs);
        if (nextState.phase === 'SOLD') {
          lotTransitionAt = nowMs + 4800;
          wsEventType = 'lot:sold';
          auditEventType = 'RTM_COUNTER_SKIPPED_SOLD';
        } else {
          wsEventType = 'rtm:update';
          auditEventType = 'RTM_COUNTER_SUBMITTED';
        }
        auditPayload = { counterBidCr: counterVal };
        break;
      }

      case 'auction:rtm_final': {
        if (
          state.phase !== 'RTM_FINAL_MATCH' ||
          !state.rtmState ||
          state.rtmState.rtmFranchiseId !== actorFranchise
        ) {
          throw new RoomError(403, 'You are not authorized to decide this RTM final match.');
        }
        nextState = respondToRtmFinalMatch(state, Boolean(action.matchCounter), playerMap, nowMs);
        lotTransitionAt = nowMs + 4800;
        wsEventType = 'lot:sold';
        auditEventType = action.matchCounter ? 'RTM_FINAL_MATCHED' : 'RTM_FINAL_DECLINED';
        auditPayload = { matchCounter: Boolean(action.matchCounter) };
        break;
      }

      case 'auction:pause': {
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can pause the auction.');
        }
        nextState = pauseAuction(state, nowMs);
        auditEventType = 'AUCTION_PAUSED';
        break;
      }

      case 'auction:resume': {
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can resume the auction.');
        }
        nextState = resumeAuction(state, nowMs);
        lastAiBidAt = nowMs;
        auditEventType = 'AUCTION_RESUMED';
        break;
      }

      case 'auction:nominate': {
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can manually nominate a player.');
        }
        if (!action.playerId || !playerMap[action.playerId]) {
          throw new RoomError(400, 'Invalid playerId for nomination.');
        }
        if (state.phase !== 'SOLD' && state.phase !== 'UNSOLD' && state.phase !== 'NOMINATION') {
          throw new RoomError(400, 'Cannot nominate while a lot is actively bidding.');
        }
        lotTransitionAt = null;
        goingOnceSent = false;
        goingTwiceSent = false;
        lastAiBidAt = nowMs + 500;
        nextState = nominateNextPlayer(state, playerMap, nowMs, action.playerId);
        wsEventType = 'lot:next';
        auditEventType = 'PLAYER_NOMINATED';
        auditPlayerId = nextState.currentPlayerId;
        break;
      }

      case 'auction:finish_now': {
        if (!isHost) {
          throw new RoomError(403, 'Only the room host can finish the auction.');
        }
        nextState = completeAuction(state, nowMs);
        lotTransitionAt = null;
        wsEventType = 'auction:completed';
        auditEventType = 'AUCTION_COMPLETED';
        break;
      }
    }

    const nextVersion = room.stateVersion + 1;
    const nextStatus = deriveRoomStatus(nextState.phase);
    const nextExpiresAt = new Date(nowMs + SERVER_CONFIG.ROOM_RETENTION_HOURS * 3_600_000);

    await tx
      .update(auctionRooms)
      .set({
        status: nextStatus,
        rulesetId: nextState.ruleset.id,
        auctionStateJson: nextState,
        stateVersion: nextVersion,
        goingOnceSent,
        goingTwiceSent,
        lastAiBidAt,
        lotTransitionAt,
        updatedAt: now,
        expiresAt: nextExpiresAt,
      })
      .where(eq(auctionRooms.id, room.id));

    await tx.insert(auctionEvents).values({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      roomId: room.id,
      eventType: auditEventType,
      actorId: session.sessionId,
      franchiseId: assignedFranchise ?? actorFranchise,
      playerId: auditPlayerId,
      requestId: auditRequestId,
      eventPayloadJson: auditPayload,
      stateVersion: nextVersion,
      createdAt: now,
    });

    return {
      roomId: room.id,
      roomCode: room.roomCode,
      state: nextState,
      stateVersion: nextVersion,
      eventType: wsEventType,
      franchiseId: assignedFranchise ?? actorFranchise,
    };
  });

  // Broadcast via PostgreSQL NOTIFY ONLY after DB commit succeeded and action wasn't rejected
  if (!committed.rejected && !committed.idempotentReplay) {
    await publishRoomUpdate(committed.roomCode, committed.eventType, committed.stateVersion);
  }

  return committed;
}

/**
 * Checks disconnected participants against grace period:
 * - Re-elects host safely to the earliest-joined connected participant if the host has been
 *   disconnected past the host failover window (or immediately if forceImmediateHostTransfer).
 * - In LOBBY phase, releases seats of participants disconnected longer than ROOM_RECONNECT_GRACE_SECONDS
 *   back to AI so rooms don't get deadlocked.
 */
export async function reconcileDisconnectedParticipantsForRoom(
  roomId: string,
  nowMs: number,
  options?: { graceSeconds?: number; hostTransferSeconds?: number }
): Promise<CommittedRoomMutation | null> {
  const graceMs = (options?.graceSeconds ?? SERVER_CONFIG.ROOM_RECONNECT_GRACE_SECONDS) * 1000;
  const hostTransferMs =
    (options?.hostTransferSeconds ?? Math.min(10, SERVER_CONFIG.ROOM_RECONNECT_GRACE_SECONDS)) *
    1000;
  const now = new Date(nowMs);

  const committed = await db.transaction(async (tx): Promise<CommittedRoomMutation | null> => {
    await tx.execute(sql`SELECT id FROM auction_rooms WHERE id = ${roomId} FOR UPDATE SKIP LOCKED`);
    const rows = await tx.select().from(auctionRooms).where(eq(auctionRooms.id, roomId)).limit(1);
    const room = rows[0];
    if (!room) return null;

    const participants = await tx
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, room.id))
      .orderBy(asc(roomParticipants.joinedAt));

    let state = room.auctionStateJson;
    let teams = { ...state.teams };
    let mutated = false;
    let nextHostSessionId = room.hostSessionId;
    let nextHostUserId = room.hostUserId;
    const notes: string[] = [];

    // 1) Host re-election if host is disconnected past hostTransferMs and another human is connected
    const currentHost = participants.find((p) => p.isHost);
    const connectedOthers = participants.filter((p) => p.isConnected && p.id !== currentHost?.id);

    if (
      currentHost &&
      !currentHost.isConnected &&
      currentHost.disconnectedAt &&
      nowMs - currentHost.disconnectedAt.getTime() >= hostTransferMs &&
      connectedOthers.length > 0
    ) {
      const nextHost = connectedOthers[0];
      await tx
        .update(roomParticipants)
        .set({ isHost: false })
        .where(eq(roomParticipants.id, currentHost.id));
      await tx
        .update(roomParticipants)
        .set({ isHost: true })
        .where(eq(roomParticipants.id, nextHost.id));

      nextHostSessionId = nextHost.sessionId;
      nextHostUserId = nextHost.userId;
      state = {
        ...state,
        hostId: nextHost.sessionId,
      };
      mutated = true;
      notes.push(`Host transferred to ${nextHost.username}`);
    }

    // 2) Release disconnected LOBBY seats after full ROOM_RECONNECT_GRACE_SECONDS
    if (state.phase === 'LOBBY') {
      for (const p of participants) {
        if (
          !p.isConnected &&
          p.disconnectedAt &&
          nowMs - p.disconnectedAt.getTime() >= graceMs &&
          p.sessionId !== nextHostSessionId
        ) {
          await tx.delete(roomParticipants).where(eq(roomParticipants.id, p.id));
          const fid = p.franchiseId as FranchiseId;
          const cfg = FRANCHISE_MAP[fid];
          if (teams[fid] && cfg) {
            teams[fid] = {
              ...teams[fid],
              controllerType: 'AI',
              ownerId: undefined,
              ownerName: `${cfg.ownerPersona} (AI)`,
              isReady: true,
              isConnected: true,
            };
          }
          mutated = true;
          notes.push(`Released timed-out lobby seat ${fid}`);
        }
      }
    }

    if (!mutated) return null;

    const nextVersion = room.stateVersion + 1;
    const nextState: AuctionState = {
      ...state,
      teams,
      updatedAt: nowMs,
    };

    await tx
      .update(auctionRooms)
      .set({
        hostSessionId: nextHostSessionId,
        hostUserId: nextHostUserId,
        auctionStateJson: nextState,
        stateVersion: nextVersion,
        updatedAt: now,
      })
      .where(eq(auctionRooms.id, room.id));

    await tx.insert(auctionEvents).values({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      roomId: room.id,
      eventType: 'HOST_OR_SEAT_RECONCILED',
      actorId: 'system',
      franchiseId: null,
      playerId: null,
      requestId: null,
      eventPayloadJson: { notes, hostSessionId: nextHostSessionId },
      stateVersion: nextVersion,
      createdAt: now,
    });

    return {
      roomId: room.id,
      roomCode: room.roomCode,
      state: nextState,
      stateVersion: nextVersion,
      eventType: 'state:sync',
    };
  });

  if (committed) {
    await publishRoomUpdate(committed.roomCode, committed.eventType, committed.stateVersion);
  }
  return committed;
}
