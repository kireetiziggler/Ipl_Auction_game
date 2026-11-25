import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { db } from '../../db/index.ts';
import {
  auctionEvents,
  auctionRooms,
  customPlayers,
  guestSessions,
  rateLimitBuckets,
  roomParticipants,
  userSessions,
  users,
} from '../../db/schema.ts';
import type { AuctionState, FranchiseId } from '../../engine/types.ts';
import { migrateJsonStoreToPostgres } from '../../../scripts/migrate-json-store.ts';
import { hashPassword } from '../authService.ts';
import { hashToken } from '../config.ts';
import { createArenaServer, type ArenaServerHandle } from '../createApp.ts';
import {
  reconcileDisconnectedParticipantsForRoom,
} from '../roomRepository.ts';
import { AuctionSchedulerWorker, tickSingleRoom } from '../schedulerWorker.ts';
import { getMergedPlayerMap } from '../adminService.ts';

const TEST_RUN_ID = `tst_${crypto.randomBytes(4).toString('hex')}`;
const createdEmails: string[] = [];
const createdRoomCodes: string[] = [];
const createdSessionIds: string[] = [];
const createdCustomPlayerIds: string[] = [];

async function startTestServer(): Promise<{ handle: ArenaServerHandle; baseUrl: string; wsUrl: string }> {
  const handle = await createArenaServer({
    enableViteMiddleware: false,
    enableBackgroundWorkers: false,
  });
  await new Promise<void>((resolve) => {
    handle.httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = handle.httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Could not bind ephemeral test port');
  }
  return {
    handle,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/ws/auction`,
  };
}

function waitForWsMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (predicate(parsed)) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // ignore
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before expected message'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

async function openWs(wsUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

describe('Production PostgreSQL Auth, Multiplayer, Concurrency & Recovery Suite', () => {
  let server: { handle: ArenaServerHandle; baseUrl: string; wsUrl: string };

  beforeAll(async () => {
    server = await startTestServer();
  }, 20_000);

  afterAll(async () => {
    if (server?.handle) {
      await server.handle.shutdown();
    }
    // Clean up only records created during this test run
    try {
      if (createdRoomCodes.length > 0) {
        await db.delete(auctionRooms).where(inArray(auctionRooms.roomCode, createdRoomCodes));
      }
      if (createdSessionIds.length > 0) {
        const sessRows = await db
          .select({ guestSessionId: userSessions.guestSessionId })
          .from(userSessions)
          .where(inArray(userSessions.id, createdSessionIds));
        const guestIds = sessRows
          .map((r) => r.guestSessionId)
          .filter((id): id is string => Boolean(id));
        await db.delete(userSessions).where(inArray(userSessions.id, createdSessionIds));
        if (guestIds.length > 0) {
          await db.delete(guestSessions).where(inArray(guestSessions.id, guestIds));
        }
      }
      if (createdEmails.length > 0) {
        await db.delete(users).where(inArray(users.normalizedEmail, createdEmails));
      }
      if (createdCustomPlayerIds.length > 0) {
        await db.delete(customPlayers).where(inArray(customPlayers.id, createdCustomPlayerIds));
      }
      await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucketKey, '%127.0.0.1%'));
    } catch (err) {
      console.warn('[TestCleanup] non-fatal cleanup warning:', err);
    }
  }, 20_000);

  // ==================== 1. AUTHENTICATION & SESSION TESTS ====================
  describe('Authentication & Persistent Sessions', () => {
    const testEmail = `${TEST_RUN_ID}_Owner@Example.COM`;
    const normalizedEmail = testEmail.toLowerCase();
    const testPassword = 'StrongPassword#2027';
    let sessionToken = '';
    let sessionId = '';

    it('registers a user, hashes password & token in PostgreSQL, and never returns secrets', async () => {
      createdEmails.push(normalizedEmail);
      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: testEmail,
          username: 'Test Franchise Owner',
          password: testPassword,
          favoriteFranchise: 'RCB',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.token).toBe('string');
      expect(typeof body.sessionId).toBe('string');
      expect(body.profile).toBeDefined();
      const profile = body.profile as Record<string, unknown>;
      expect(profile.email).toBe(normalizedEmail);
      expect(profile.passwordHash).toBeUndefined();
      expect(profile.passwordSalt).toBeUndefined();

      sessionToken = body.token as string;
      sessionId = body.sessionId as string;
      createdSessionIds.push(sessionId);

      // Verify raw token is NOT stored in DB, only SHA-256 hash
      const dbSessions = await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.id, sessionId));
      expect(dbSessions.length).toBe(1);
      expect(dbSessions[0].tokenHash).toBe(hashToken(sessionToken));
      expect(dbSessions[0].tokenHash).not.toBe(sessionToken);
    });

    it('rejects duplicate email registration regardless of case', async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: normalizedEmail.toUpperCase(),
          username: 'Duplicate User',
          password: testPassword,
        }),
      });
      expect(res.status).toBe(409);
    });

    it('returns generic failure on invalid login and succeeds on valid credentials', async () => {
      const badRes = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password: 'WrongPassword123' }),
      });
      expect(badRes.status).toBe(401);
      const badBody = (await badRes.json()) as { error: string };
      expect(badBody.error).toBe('Invalid email or password.');

      const unknownRes = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${TEST_RUN_ID}_unknown@example.com`, password: 'WrongPassword123' }),
      });
      expect(unknownRes.status).toBe(401);
      const unknownBody = (await unknownRes.json()) as { error: string };
      expect(unknownBody.error).toBe(badBody.error);

      const goodRes = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      expect(goodRes.status).toBe(200);
      const goodBody = (await goodRes.json()) as { token: string; sessionId: string };
      createdSessionIds.push(goodBody.sessionId);
      expect(goodBody.token.length).toBeGreaterThan(32);
    });

    it('supports /api/auth/me, token rotation via /api/auth/refresh, and revocation via /api/auth/logout', async () => {
      const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(meRes.status).toBe(200);
      const meBody = (await meRes.json()) as { sessionId: string; isGuest: boolean };
      expect(meBody.sessionId).toBe(sessionId);
      expect(meBody.isGuest).toBe(false);

      // Refresh rotates token while keeping same sessionId
      const refRes = await fetch(`${server.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(refRes.status).toBe(200);
      const refBody = (await refRes.json()) as { token: string; sessionId: string };
      expect(refBody.sessionId).toBe(sessionId);
      expect(refBody.token).not.toBe(sessionToken);

      // Old token is now rejected
      const staleRes = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(staleRes.status).toBe(401);

      // New token works
      const freshRes = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${refBody.token}` },
      });
      expect(freshRes.status).toBe(200);

      // Logout revokes session
      const outRes = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${refBody.token}` },
      });
      expect(outRes.status).toBe(200);

      const postOutRes = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${refBody.token}` },
      });
      expect(postOutRes.status).toBe(401);
    });

    it('issues server-backed guest sessions for players without accounts', async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Guest Striker', favoriteFranchise: 'MI' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { token: string; sessionId: string; isGuest: boolean };
      createdSessionIds.push(body.sessionId);
      expect(body.isGuest).toBe(true);
      expect(body.token.length).toBeGreaterThan(32);

      const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(meRes.status).toBe(200);
    });
  });

  // ==================== 2. MULTIPLAYER, AUTHORIZATION, RECONNECTION & HOST RE-ELECTION ====================
  describe('Multiplayer Room Engine, Reconnection & Host Re-election', () => {
    it('rejects unauthenticated room creation and WebSocket joins', async () => {
      const noAuthRoom = await fetch(`${server.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ franchiseId: 'CSK' }),
      });
      expect(noAuthRoom.status).toBe(401);

      const ws = await openWs(server.wsUrl);
      const authErrPromise = waitForWsMessage(ws, (m) => m.type === 'auth:error');
      ws.send(JSON.stringify({ type: 'room:join', roomCode: 'ABC123', clientId: 'spoofed_client' }));
      const errMsg = await authErrPromise;
      expect(errMsg.code).toBe('UNAUTHORIZED');
      ws.close();
    });

    it('supports multi-player join, franchise switching, non-host rejection, reconnection, and host re-election', async () => {
      // Provision 2 server-issued guest sessions
      const [g1Res, g2Res] = await Promise.all([
        fetch(`${server.baseUrl}/api/auth/guest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'Host Owner', favoriteFranchise: 'CSK' }),
        }),
        fetch(`${server.baseUrl}/api/auth/guest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'Challenger Owner', favoriteFranchise: 'MI' }),
        }),
      ]);
      const g1 = (await g1Res.json()) as { token: string; sessionId: string };
      const g2 = (await g2Res.json()) as { token: string; sessionId: string };
      createdSessionIds.push(g1.sessionId, g2.sessionId);

      // Host creates room
      const roomRes = await fetch(`${server.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${g1.token}`,
        },
        body: JSON.stringify({ username: 'Host Owner', franchiseId: 'CSK' }),
      });
      expect(roomRes.status).toBe(201);
      const created = (await roomRes.json()) as { roomCode: string; roomId: string };
      createdRoomCodes.push(created.roomCode);

      // Both players join via authenticated WS
      const ws1 = await openWs(server.wsUrl);
      const join1 = waitForWsMessage(ws1, (m) => m.type === 'room:joined');
      ws1.send(JSON.stringify({ type: 'room:join', roomCode: created.roomCode, token: g1.token, franchiseId: 'CSK' }));
      const joined1 = await join1;
      expect(joined1.franchiseId).toBe('CSK');

      const ws2 = await openWs(server.wsUrl);
      const join2 = waitForWsMessage(ws2, (m) => m.type === 'room:joined');
      ws2.send(JSON.stringify({ type: 'room:join', roomCode: created.roomCode, token: g2.token, franchiseId: 'MI' }));
      const joined2 = await join2;
      expect(joined2.franchiseId).toBe('MI');

      // Player 2 tries to take Host's CSK franchise -> rejected
      const errTaken = waitForWsMessage(ws2, (m) => m.type === 'error');
      ws2.send(JSON.stringify({ type: 'lobby:select_franchise', franchiseId: 'CSK' }));
      const errTakenMsg = await errTaken;
      expect(String(errTakenMsg.message)).toContain('already claimed');

      // Player 2 switches to RCB -> accepted
      const switched = waitForWsMessage(ws2, (m) => m.type === 'franchise:assigned');
      ws2.send(JSON.stringify({ type: 'lobby:select_franchise', franchiseId: 'RCB' }));
      const switchedMsg = await switched;
      expect(switchedMsg.franchiseId).toBe('RCB');

      // Player 2 tries host-only action (auction:start) -> rejected
      const errHostOnly = waitForWsMessage(ws2, (m) => m.type === 'error');
      ws2.send(JSON.stringify({ type: 'auction:start' }));
      const errHostOnlyMsg = await errHostOnly;
      expect(String(errHostOnlyMsg.message)).toContain('host');

      // Player 2 disconnects -> wait deterministically for disconnect sync -> reconnects and preserves RCB
      const p2DiscSync = waitForWsMessage(
        ws1,
        (m) =>
          m.type === 'state:sync' &&
          Boolean((m.state as AuctionState)?.teams?.RCB?.isConnected === false),
        10_000
      );
      ws2.close();
      await p2DiscSync;

      const ws2Re = await openWs(server.wsUrl);
      const rejoin2 = waitForWsMessage(ws2Re, (m) => m.type === 'room:joined', 10_000);
      ws2Re.send(JSON.stringify({ type: 'room:join', roomCode: created.roomCode, token: g2.token }));
      const rejoined2 = await rejoin2;
      expect(rejoined2.franchiseId).toBe('RCB');

      // Host disconnects -> wait deterministically for disconnect commit -> reconcile host re-election
      const hostDiscSync = waitForWsMessage(
        ws2Re,
        (m) =>
          m.type === 'state:sync' &&
          Boolean((m.state as AuctionState)?.teams?.CSK?.isConnected === false),
        10_000
      );
      ws1.close();
      await hostDiscSync;

      const reconciled = await reconcileDisconnectedParticipantsForRoom(
        created.roomId,
        Date.now() + 20_000,
        { hostTransferSeconds: 5, graceSeconds: 90 }
      );
      expect(reconciled).not.toBeNull();
      expect(reconciled!.state.hostId).toBe(g2.sessionId);

      // Verify persisted host change in DB
      const [roomRow] = await db
        .select()
        .from(auctionRooms)
        .where(eq(auctionRooms.id, created.roomId));
      expect(roomRow.hostSessionId).toBe(g2.sessionId);

      ws2Re.close();
    }, 20_000);
  });

  // ==================== 3. CONCURRENCY, IDEMPOTENCY & RESTART RECOVERY ====================
  describe('Concurrency, Bid Idempotency & Server Restart Recovery', () => {
    it('serializes simultaneous bids, enforces requestId idempotency, and recovers full auction state across server restart', async () => {
      const [g1Res, g2Res] = await Promise.all([
        fetch(`${server.baseUrl}/api/auth/guest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'Bidder One', favoriteFranchise: 'CSK' }),
        }),
        fetch(`${server.baseUrl}/api/auth/guest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'Bidder Two', favoriteFranchise: 'MI' }),
        }),
      ]);
      const g1 = (await g1Res.json()) as { token: string; sessionId: string };
      const g2 = (await g2Res.json()) as { token: string; sessionId: string };
      createdSessionIds.push(g1.sessionId, g2.sessionId);

      const roomRes = await fetch(`${server.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${g1.token}`,
        },
        body: JSON.stringify({ username: 'Bidder One', franchiseId: 'CSK', auctionSpeed: 'FAST' }),
      });
      const created = (await roomRes.json()) as { roomCode: string; roomId: string };
      createdRoomCodes.push(created.roomCode);

      const ws1 = await openWs(server.wsUrl);
      const ws2 = await openWs(server.wsUrl);

      const j1 = waitForWsMessage(ws1, (m) => m.type === 'room:joined');
      ws1.send(JSON.stringify({ type: 'room:join', roomCode: created.roomCode, token: g1.token, franchiseId: 'CSK' }));
      await j1;

      const j2 = waitForWsMessage(ws2, (m) => m.type === 'room:joined');
      ws2.send(JSON.stringify({ type: 'room:join', roomCode: created.roomCode, token: g2.token, franchiseId: 'MI' }));
      await j2;

      // Host starts auction
      const startedPromise = waitForWsMessage(ws1, (m) => m.type === 'auction:started');
      ws1.send(JSON.stringify({ type: 'auction:start' }));
      const startedMsg = await startedPromise;
      const startedState = startedMsg.state as AuctionState;
      expect(startedState.phase).toBe('OPENING_BID');
      expect(startedState.currentPlayerId).toBeTruthy();

      // Test idempotent bid with fixed requestId sent twice concurrently
      const dupReqId = `req_idem_${TEST_RUN_ID}`;
      const bidSyncPromise = waitForWsMessage(ws1, (m) => m.type === 'bid:placed');
      ws1.send(JSON.stringify({ type: 'auction:bid', requestId: dupReqId }));
      const firstBidMsg = await bidSyncPromise;
      const firstBidState = firstBidMsg.state as AuctionState;
      const firstBidAmount = firstBidState.currentBidCr;
      expect(firstBidState.currentBidderId).toBe('CSK');

      // Retry exact same requestId -> must return idempotentReplay and NOT increase bid or duplicate event
      const replayPromise = waitForWsMessage(ws1, (m) => m.idempotentReplay === true);
      ws1.send(JSON.stringify({ type: 'auction:bid', requestId: dupReqId }));
      const replayMsg = await replayPromise;
      expect((replayMsg.state as AuctionState).currentBidCr).toBe(firstBidAmount);

      const matchingBidEvents = await db
        .select()
        .from(auctionEvents)
        .where(eq(auctionEvents.requestId, dupReqId));
      expect(matchingBidEvents.length).toBe(1);

      // Simultaneous competing bids at the EXACT same target price from MI & CSK -> serialized by SELECT ... FOR UPDATE!
      const nextStepAmount = firstBidAmount + (firstBidState.currentBidCr < 2 ? 0.1 : 0.25);
      const miBidDone = waitForWsMessage(ws2, (m) => m.type === 'bid:placed', 10_000);
      const duplicatePriceRejection = waitForWsMessage(
        ws1,
        (m) => m.type === 'bid:rejected' || m.type === 'bid:placed',
        10_000
      );
      ws2.send(
        JSON.stringify({
          type: 'auction:bid',
          amountCr: nextStepAmount,
          requestId: `req_mi_race_${TEST_RUN_ID}`,
        })
      );
      ws1.send(
        JSON.stringify({
          type: 'auction:bid',
          amountCr: nextStepAmount,
          requestId: `req_csk_race_${TEST_RUN_ID}`,
        })
      );
      const miBidMsg = await miBidDone;
      await duplicatePriceRejection;
      const miBidState = miBidMsg.state as AuctionState;
      expect(miBidState.currentBidderId).toBe('MI');
      expect(miBidState.currentBidCr).toBeGreaterThan(firstBidAmount);
      const versionBeforeRestart = miBidMsg.stateVersion as number;

      ws1.close();
      ws2.close();

      // Simulate COMPLETE server restart by spinning up a brand new independent ArenaServer instance
      const server2 = await startTestServer();
      try {
        const resAfterRestart = await fetch(`${server2.baseUrl}/api/rooms/${created.roomCode}`);
        expect(resAfterRestart.status).toBe(200);
        const restored = (await resAfterRestart.json()) as {
          stateVersion: number;
          state: AuctionState;
        };
        expect(restored.stateVersion).toBeGreaterThanOrEqual(versionBeforeRestart);
        expect(restored.state.currentBidderId).toBe('MI');
        expect(restored.state.currentBidCr).toBe(miBidState.currentBidCr);

        // Client 1 reconnects to Server Instance 2 using the SAME session token and places a counter-bid!
        const ws1Restart = await openWs(server2.wsUrl);
        const rejoined = waitForWsMessage(ws1Restart, (m) => m.type === 'room:joined', 10_000);
        ws1Restart.send(
          JSON.stringify({ type: 'room:join', roomCode: created.roomCode, token: g1.token })
        );
        const rejoinData = await rejoined;
        expect(rejoinData.franchiseId).toBe('CSK');

        const counterBid = waitForWsMessage(ws1Restart, (m) => m.type === 'bid:placed', 10_000);
        ws1Restart.send(
          JSON.stringify({ type: 'auction:bid', requestId: `req_csk_post_restart_${TEST_RUN_ID}` })
        );
        const counterData = await counterBid;
        expect((counterData.state as AuctionState).currentBidderId).toBe('CSK');
        expect((counterData.state as AuctionState).currentBidCr).toBeGreaterThan(
          miBidState.currentBidCr
        );
        ws1Restart.close();
      } finally {
        await server2.handle.shutdown();
      }
    }, 25_000);
  });

  // ==================== 4. SCHEDULER MULTI-INSTANCE SAFETY & OVERDUE RECOVERY ====================
  describe('Multi-Instance Scheduler Safety & Overdue Lot Recovery', () => {
    it('allows strictly ONE scheduler worker to hold the PostgreSQL advisory lock and fails over cleanly', async () => {
      const testLockKey = 7102099000 + crypto.randomInt(1, 90000);
      const workerA = new AuctionSchedulerWorker(() => {}, `inst_A_${TEST_RUN_ID}`, testLockKey);
      const workerB = new AuctionSchedulerWorker(() => {}, `inst_B_${TEST_RUN_ID}`, testLockKey);

      try {
        const lockA = await workerA.acquireAdvisoryLock();
        const lockB = await workerB.acquireAdvisoryLock();

        expect(lockA).toBe(true);
        expect(lockB).toBe(false);
        expect(workerA.isLeader).toBe(true);
        expect(workerB.isLeader).toBe(false);

        // Simulate crash/shutdown of workerA -> workerC acquires lock cleanly
        await workerA.releaseAdvisoryLock();
        const workerC = new AuctionSchedulerWorker(() => {}, `inst_C_${TEST_RUN_ID}`, testLockKey);
        try {
          const lockC = await workerC.acquireAdvisoryLock();
          expect(lockC).toBe(true);
        } finally {
          await workerC.stop();
        }
      } finally {
        await workerA.stop();
        await workerB.stop();
      }
    }, 15_000);

    it('recovers overdue countdown lot closure and post-SOLD transition via tickSingleRoom', async () => {
      const gRes = await fetch(`${server.baseUrl}/api/auth/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Scheduler Host', favoriteFranchise: 'SRH' }),
      });
      const g = (await gRes.json()) as { token: string; sessionId: string };
      createdSessionIds.push(g.sessionId);

      const rRes = await fetch(`${server.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${g.token}`,
        },
        body: JSON.stringify({ username: 'Scheduler Host', franchiseId: 'SRH' }),
      });
      const created = (await rRes.json()) as { roomCode: string; roomId: string };
      createdRoomCodes.push(created.roomCode);

      const ws = await openWs(server.wsUrl);
      const joinP = waitForWsMessage(ws, (m) => m.type === 'room:joined');
      ws.send(JSON.stringify({ type: 'room:join', roomCode: created.roomCode, token: g.token }));
      await joinP;

      const startP = waitForWsMessage(ws, (m) => m.type === 'auction:started');
      ws.send(JSON.stringify({ type: 'auction:start' }));
      const started = await startP;
      const firstPlayerId = (started.state as AuctionState).currentPlayerId;

      const bidP = waitForWsMessage(ws, (m) => m.type === 'bid:placed');
      ws.send(JSON.stringify({ type: 'auction:bid', requestId: `req_sched_${TEST_RUN_ID}` }));
      await bidP;
      ws.close();

      const tickWithLockRetry = async (targetMs: number) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const result = await tickSingleRoom(created.roomId, playerMap, targetMs);
          if (result) return result;
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      };

      // Advance clock past countdown expiry to simulate overdue lot close after downtime
      const playerMap = await getMergedPlayerMap();
      const futureCloseTime = Date.now() + 120_000;
      const closedMutation = await tickWithLockRetry(futureCloseTime);
      expect(closedMutation).not.toBeNull();
      expect(['SOLD', 'RTM_OFFER']).toContain(closedMutation!.state.phase);

      // If SOLD, advance clock past lotTransitionAt and verify next player is nominated automatically
      if (closedMutation!.state.phase === 'SOLD') {
        const nextMutation = await tickWithLockRetry(futureCloseTime + 10_000);
        expect(nextMutation).not.toBeNull();
        expect(nextMutation!.eventType).toBe('lot:next');
        expect(nextMutation!.state.currentPlayerId).not.toBe(firstPlayerId);
      }
    }, 20_000);
  });

  // ==================== 5. LEGACY JSON STORE MIGRATION ====================
  describe('Safe Legacy JSON Store Migration', () => {
    it('backs up legacy arena-store.json, imports idempotently, and never deletes original', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-migrate-'));
      const jsonPath = path.join(tmpDir, 'arena-store.json');
      const legacyEmail = `${TEST_RUN_ID}_legacy@example.com`;
      const legacyPlayerId = `custom-${TEST_RUN_ID}`;
      createdEmails.push(legacyEmail);
      createdCustomPlayerIds.push(legacyPlayerId);

      const { hash, salt } = hashPassword('LegacyPass#2027');
      fs.writeFileSync(
        jsonPath,
        JSON.stringify({
          users: [
            {
              id: `usr_leg_${TEST_RUN_ID}`,
              username: 'Legacy Owner',
              email: legacyEmail,
              passwordHash: hash,
              passwordSalt: salt,
              favoriteFranchise: 'KKR',
              avatarColor: '#3A225D',
              stats: { auctionsPlayed: 3, auctionsWon: 1, bestRating: 88, avgRating: 82, tournamentsWon: 0 },
            },
          ],
          customPlayers: [
            {
              id: legacyPlayerId,
              name: 'Legacy Test Finisher',
              country: 'India',
              primaryRole: 'Batter',
              category: 'Emerging Stars',
              basePriceCr: 0.5,
            },
          ],
        }),
        'utf-8'
      );

      // First run imports both records and creates backup
      const firstRun = await migrateJsonStoreToPostgres(jsonPath);
      expect(firstRun.storeFound).toBe(true);
      expect(firstRun.backupPath && fs.existsSync(firstRun.backupPath)).toBe(true);
      expect(fs.existsSync(jsonPath)).toBe(true); // Original never deleted
      expect(firstRun.usersImported).toBe(1);
      expect(firstRun.customPlayersImported).toBe(1);

      // Second run is strictly idempotent (skips both without duplicating or overwriting)
      const secondRun = await migrateJsonStoreToPostgres(jsonPath);
      expect(secondRun.usersImported).toBe(0);
      expect(secondRun.usersSkipped).toBe(1);
      expect(secondRun.customPlayersImported).toBe(0);
      expect(secondRun.customPlayersSkipped).toBe(1);

      // Verify migrated user can log in directly against PostgreSQL!
      const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: legacyEmail, password: 'LegacyPass#2027' }),
      });
      expect(loginRes.status).toBe(200);
      const loginData = (await loginRes.json()) as { sessionId: string };
      createdSessionIds.push(loginData.sessionId);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
