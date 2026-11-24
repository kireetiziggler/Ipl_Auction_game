import { AIDifficulty, AuctionState, FranchiseId, NominationMode } from '../engine/types';

export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export interface MultiplayerCallbacks {
  onStatus: (status: ConnectionStatus) => void;
  onState: (state: AuctionState, eventType: string) => void;
  onAssignedFranchise: (franchiseId: FranchiseId) => void;
  onError: (message: string) => void;
}

export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private roomCode = '';
  private clientId = '';
  private username = '';
  private desiredFranchiseId?: FranchiseId;
  private callbacks: MultiplayerCallbacks;
  private reconnectTimer: number | null = null;
  private manualClose = false;

  constructor(callbacks: MultiplayerCallbacks) {
    this.callbacks = callbacks;
  }

  connect(params: {
    roomCode: string;
    clientId: string;
    username: string;
    franchiseId?: FranchiseId;
  }): void {
    this.manualClose = false;
    this.roomCode = params.roomCode.toUpperCase();
    this.clientId = params.clientId;
    this.username = params.username;
    this.desiredFranchiseId = params.franchiseId;
    this.openSocket(false);
  }

  private openSocket(isReconnect: boolean): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.callbacks.onStatus(isReconnect ? 'RECONNECTING' : 'CONNECTING');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/auction`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.callbacks.onStatus('CONNECTED');
      ws.send(
        JSON.stringify({
          type: 'room:join',
          roomCode: this.roomCode,
          clientId: this.clientId,
          username: this.username,
          franchiseId: this.desiredFranchiseId,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          state?: AuctionState;
          franchiseId?: FranchiseId;
          message?: string;
        };
        if (msg.type === 'room:joined' && msg.franchiseId) {
          this.desiredFranchiseId = msg.franchiseId;
          this.callbacks.onAssignedFranchise(msg.franchiseId);
        }
        if (msg.type === 'franchise:assigned' && msg.franchiseId) {
          this.desiredFranchiseId = msg.franchiseId;
          this.callbacks.onAssignedFranchise(msg.franchiseId);
        }
        if (msg.state) {
          this.callbacks.onState(msg.state, msg.type);
        }
        if ((msg.type === 'error' || msg.type === 'bid:rejected') && msg.message) {
          this.callbacks.onError(msg.message);
        }
      } catch {
        // Ignore invalid JSON frames
      }
    };

    ws.onclose = () => {
      if (this.manualClose) {
        this.callbacks.onStatus('DISCONNECTED');
        return;
      }
      this.callbacks.onStatus('RECONNECTING');
      this.reconnectTimer = window.setTimeout(() => {
        if (!this.manualClose) {
          this.openSocket(true);
        }
      }, 2000);
    };

    ws.onerror = () => {
      // onclose handles reconnection
    };
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
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
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.send({ type: 'auction:bid', amountCr, requestId });
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
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.callbacks.onStatus('DISCONNECTED');
  }
}

