import { sql } from 'drizzle-orm';
import type { Client } from 'pg';
import { createDedicatedClient, db } from '../db/index.ts';
import { SERVER_CONFIG } from './config.ts';

export const ROOM_UPDATES_CHANNEL = 'auction_room_updates';

export interface RoomUpdateNotification {
  instanceId: string;
  roomCode: string;
  eventType: string;
  stateVersion: number;
  timestamp: number;
}

type NotificationHandler = (payload: RoomUpdateNotification) => void;

/**
 * Publishes a compact committed-state notification via PostgreSQL NOTIFY.
 * Always called AFTER the authoritative PostgreSQL transaction has committed.
 */
export async function publishRoomUpdate(
  roomCode: string,
  eventType: string,
  stateVersion: number
): Promise<void> {
  const payload: RoomUpdateNotification = {
    instanceId: SERVER_CONFIG.INSTANCE_ID,
    roomCode,
    eventType,
    stateVersion,
    timestamp: Date.now(),
  };
  try {
    const serialized = JSON.stringify(payload);
    await db.execute(sql`SELECT pg_notify(${ROOM_UPDATES_CHANNEL}, ${serialized})`);
  } catch (error) {
    // Non-fatal: DB state is already committed and authoritative; local broadcast still runs.
    console.warn(
      '[PubSub] pg_notify failed:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Lazy PostgreSQL LISTEN subscriber for cross-instance room fan-out.
 * Connects only when started (after server listen), with bounded backoff and no tight loops.
 */
export class RoomPubSubListener {
  private client: Client | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private onNotification: NotificationHandler;

  constructor(onNotification: NotificationHandler) {
    this.onNotification = onNotification;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connectOnce();
  }

  private async connectOnce(): Promise<void> {
    if (!this.running) return;
    const client = createDedicatedClient();
    this.client = client;

    client.on('notification', (msg) => {
      if (msg.channel !== ROOM_UPDATES_CHANNEL || !msg.payload) return;
      try {
        const parsed = JSON.parse(msg.payload) as RoomUpdateNotification;
        if (parsed.instanceId === SERVER_CONFIG.INSTANCE_ID) return; // Already broadcast locally
        if (parsed.roomCode && parsed.eventType) {
          this.onNotification(parsed);
        }
      } catch {
        // Ignore malformed notification payload
      }
    });

    client.on('error', (err) => {
      console.warn('[PubSub] LISTEN client error:', err.message);
      this.scheduleReconnect();
    });

    client.on('end', () => {
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${ROOM_UPDATES_CHANNEL}`);
      this.reconnectAttempts = 0;
    } catch (err) {
      console.warn(
        '[PubSub] Could not establish LISTEN connection:',
        err instanceof Error ? err.message : String(err)
      );
      try {
        await client.end();
      } catch {
        // ignore
      }
      this.client = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    if (this.reconnectAttempts >= 5) {
      // Bounded retries so we never flood the proxy if DB is down
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(30_000, 2000 * Math.pow(2, this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      const c = this.client;
      this.client = null;
      try {
        await c.end();
      } catch {
        // ignore
      }
    }
  }
}
