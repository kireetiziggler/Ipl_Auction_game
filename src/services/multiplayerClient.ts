import { AIDifficulty, AuctionState, FranchiseId, NominationMode } from '../engine/types';

export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export interface MultiplayerCallbacks {
  onStatus: (status: ConnectionStatus) => void;
  onState: (state: AuctionState, eventType: string) => void;
  onAssignedFranchise: (franchiseId: FranchiseId) => void;
  onSessionSynced?: (sessionId: string) => void;
  onAuthExpired?: () => Promise<string | null>;
  onError: (message: string) => void;
}

export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private roomCode = '';
  private sessionToken: string | null = null;
  private username = '';
  private desiredFranchiseId?: FranchiseId;
  private callbacks: MultiplayerCallbacks;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectAttempt = 0;
  private manualClose = false;
  private lastStateVersion = 0;
  private pendingBidRequestId: string | null = null;
  private pendingBidTimer: number | null = null;
  private authRefreshInFlight = false;

  constructor(callbacks: MultiplayerCallbacks) {
    this.callbacks = callbacks;
  }

  connect(params: {
    roomCode: string;
    token?: string | null;
    username: string;
    franchiseId?: FranchiseId;
  }): void {
    this.manualClose = false;
    this.roomCode = params.roomCode.toUpperCase();
    this.sessionToken = params.token ?? null;
    this.username = params.username;
    this.desiredFranchiseId = params.franchiseId;
    this.reconnectAttempt = 0;
    this.lastStateVersion = 0;
    this.clearPendingBid();
    this.openSocket(false);
  }

  updateSessionToken(token: string | null): void {
    this.sessionToken = token;
  }

  private clearPendingBid(): void {
    this.pendingBidRequestId = null;
    if (this.pendingBidTimer !== null) {
      window.clearTimeout(this.pendingBidTimer);
      this.pendingBidTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPendingBid();
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer !== null) return;
    this.callbacks.onStatus('RECONNECTING');
    const baseMs = Math.min(15_000, 1000 * Math.pow(2, Math.min(this.reconnectAttempt, 4)));
    const jitterMs = Math.floor(Math.random() * 400);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) {
        this.openSocket(true);
      }
    }, baseMs + jitterMs);
  }

  private openSocket(isReconnect: boolean): void {
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.callbacks.onStatus(isReconnect ? 'RECONNECTING' : 'CONNECTING');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/auction`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.callbacks.onStatus('CONNECTED');
      const joinPayload: Record<string, unknown> = {
        type: 'room:join',
        roomCode: this.roomCode,
        username: this.username,
        franchiseId: this.desiredFranchiseId,
      };
      if (this.sessionToken) {
        joinPayload.token = this.sessionToken;
      }
      ws.send(JSON.stringify(joinPayload));

      this.heartbeatTimer = window.setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          state?: AuctionState;
          stateVersion?: number;
          franchiseId?: FranchiseId;
          sessionId?: string;
          message?: string;
          requestId?: string;
        };

        if (msg.type === 'pong') return;

        if (msg.type === 'auth:error') {
          if (!this.authRefreshInFlight && this.callbacks.onAuthExpired) {
            this.authRefreshInFlight = true;
            void this.callbacks
              .onAuthExpired()
              .then((freshToken) => {
                this.authRefreshInFlight = false;
                if (freshToken !== undefined) {
                  this.sessionToken = freshToken;
                  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const retryPayload: Record<string, unknown> = {
                      type: 'room:join',
                      roomCode: this.roomCode,
                      username: this.username,
                      franchiseId: this.desiredFranchiseId,
                    };
                    if (this.sessionToken) retryPayload.token = this.sessionToken;
                    this.ws.send(JSON.stringify(retryPayload));
                  }
                } else if (msg.message) {
                  this.callbacks.onError(msg.message);
                }
              })
              .catch(() => {
                this.authRefreshInFlight = false;
                if (msg.message) this.callbacks.onError(msg.message);
              });
          } else if (msg.message) {
            this.callbacks.onError(msg.message);
          }
          return;
        }

        if (msg.type === 'room:joined') {
          this.reconnectAttempt = 0;
          if (msg.sessionId) {
            this.callbacks.onSessionSynced?.(msg.sessionId);
          }
          if (msg.franchiseId) {
            this.desiredFranchiseId = msg.franchiseId;
            this.callbacks.onAssignedFranchise(msg.franchiseId);
          }
        }

        if (msg.type === 'franchise:assigned' && msg.franchiseId) {
          this.desiredFranchiseId = msg.franchiseId;
          this.callbacks.onAssignedFranchise(msg.franchiseId);
        }

        if (msg.type === 'bid:rejected') {
          this.clearPendingBid();
          if (msg.message) {
            this.callbacks.onError(msg.message);
          }
          return;
        }

        if (msg.state) {
          if (typeof msg.stateVersion === 'number') {
            if (msg.stateVersion < this.lastStateVersion && msg.type !== 'room:joined') {
              return; // Ignore out-of-order older state frame
            }
            this.lastStateVersion = msg.stateVersion;
          }
          this.clearPendingBid();
          this.callbacks.onState(msg.state, msg.type);
        }

        if (msg.type === 'error' && msg.message) {
          this.callbacks.onError(msg.message);
        }
      } catch {
        // Ignore invalid JSON frames
      }
    };

    ws.onclose = (ev) => {
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.manualClose || ev.code === 4001) {
        this.callbacks.onStatus('DISCONNECTED');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose handles exponential backoff reconnection
    };
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  selectFranchise(franchiseId: FranchiseId): void {
    this.send({ type: 'lobby:select_franchise', franchiseId });
  }

  toggleReady(ready?: boolean): void {
    this.send({ type: 'lobby:toggle_ready', ready });
  }

  updateLobbySettings(settings: {
    aiDifficulty?: AIDifficulty;
    auctionSpeed?: 'NORMAL' | 'FAST' | 'BLITZ';
    rulesetId?: string;
    nominationMode?: NominationMode;
  }): void {
    this.send({ type: 'lobby:update_settings', settings });
  }

  enterRetention(): void {
    this.send({ type: 'lobby:enter_retention' });
  }

  confirmRetentions(selections: Partial<Record<FranchiseId, string[]>>): void {
    this.send({ type: 'retention:confirm', selections });
  }

  startAuction(): void {
    this.send({ type: 'auction:start' });
  }

  placeBid(amountCr?: number): void {
    // Prevent accidental rapid double-click duplicate bids while an identical bid request is in flight
    if (this.pendingBidRequestId) {
      return;
    }
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const sent = this.send({ type: 'auction:bid', amountCr, requestId });
    if (sent) {
      this.pendingBidRequestId = requestId;
      this.pendingBidTimer = window.setTimeout(() => {
        this.clearPendingBid();
      }, 1800);
    } else {
      this.callbacks.onError('Reconnecting to auction room... please wait a moment.');
    }
  }

  pass(): void {
    this.send({ type: 'auction:pass' });
  }

  respondRtmOffer(useRtm: boolean): void {
    this.send({ type: 'auction:rtm_offer', useRtm });
  }

  submitRtmCounter(counterBidCr: number | null): void {
    this.send({ type: 'auction:rtm_counter', counterBidCr });
  }

  respondRtmFinalMatch(matchCounter: boolean): void {
    this.send({ type: 'auction:rtm_final', matchCounter });
  }

  pause(): void {
    this.send({ type: 'auction:pause' });
  }

  resume(): void {
    this.send({ type: 'auction:resume' });
  }

  nominatePlayer(playerId: string): void {
    this.send({ type: 'auction:nominate', playerId });
  }

  finishNow(): void {
    this.send({ type: 'auction:finish_now' });
  }

  disconnect(): void {
    this.manualClose = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.callbacks.onStatus('DISCONNECTED');
  }
}
