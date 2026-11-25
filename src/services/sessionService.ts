import type { FranchiseId, UserProfile } from '../engine/types';

export interface ServerSessionInfo {
  sessionId: string;
  token: string | null; // Held in JS memory only (never stored in localStorage/sessionStorage)
  isGuest: boolean;
  expiresAt: string;
  profile: UserProfile;
}

class SessionService {
  private current: ServerSessionInfo | null = null;
  private inflightBootstrap: Promise<ServerSessionInfo | null> | null = null;

  getSession(): ServerSessionInfo | null {
    return this.current;
  }

  getToken(): string | null {
    return this.current?.token ?? null;
  }

  getSessionId(): string | null {
    return this.current?.sessionId ?? null;
  }

  setSession(info: ServerSessionInfo | null): void {
    this.current = info;
  }

  async authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'fetch');
    }
    if (this.current?.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.current.token}`);
    }
    return fetch(input, {
      ...init,
      headers,
      credentials: 'include',
    });
  }

  /**
   * Restores an active HttpOnly cookie/Bearer session via GET /api/auth/me,
   * or creates a server-issued persistent guest session via POST /api/auth/guest.
   */
  async ensureSession(defaults: {
    username: string;
    favoriteFranchise: FranchiseId;
  }): Promise<ServerSessionInfo | null> {
    if (this.current) {
      const expMs = Date.parse(this.current.expiresAt);
      if (Number.isFinite(expMs) && expMs - Date.now() > 5 * 60_000) {
        return this.current;
      }
      // Near expiry -> refresh
      const refreshed = await this.refreshSession();
      if (refreshed) return refreshed;
    }

    if (this.inflightBootstrap) return this.inflightBootstrap;

    this.inflightBootstrap = (async () => {
      try {
        const meRes = await this.authFetch('/api/auth/me');
        if (meRes.ok) {
          const data = (await meRes.json()) as {
            sessionId: string;
            isGuest: boolean;
            expiresAt: string;
            profile: UserProfile;
          };
          this.current = {
            sessionId: data.sessionId,
            token: this.current?.token ?? null,
            isGuest: Boolean(data.isGuest),
            expiresAt: data.expiresAt,
            profile: data.profile,
          };
          return this.current;
        }
      } catch {
        // Offline or server unreachable; fall through to guest attempt
      }

      try {
        const guestRes = await this.authFetch('/api/auth/guest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: defaults.username,
            favoriteFranchise: defaults.favoriteFranchise,
          }),
        });
        if (guestRes.ok) {
          const data = (await guestRes.json()) as {
            token: string;
            sessionId: string;
            isGuest: boolean;
            expiresAt: string;
            profile: UserProfile;
          };
          this.current = {
            sessionId: data.sessionId,
            token: data.token,
            isGuest: true,
            expiresAt: data.expiresAt,
            profile: data.profile,
          };
          return this.current;
        }
      } catch {
        // Offline PWA mode continues seamlessly for local Solo play
      }
      return null;
    })();

    try {
      return await this.inflightBootstrap;
    } finally {
      this.inflightBootstrap = null;
    }
  }

  async syncFirebaseToken(
    idToken: string,
    favoriteFranchise: FranchiseId
  ): Promise<ServerSessionInfo | null> {
    try {
      const res = await this.authFetch('/api/auth/firebase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, favoriteFranchise }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        token: string;
        sessionId: string;
        isGuest: boolean;
        expiresAt: string;
        profile: UserProfile;
      };
      this.current = {
        sessionId: data.sessionId,
        token: data.token,
        isGuest: false,
        expiresAt: data.expiresAt,
        profile: data.profile,
      };
      return this.current;
    } catch {
      return null;
    }
  }

  async refreshSession(): Promise<ServerSessionInfo | null> {
    try {
      const res = await this.authFetch('/api/auth/refresh', { method: 'POST' });
      if (!res.ok) {
        this.current = null;
        return null;
      }
      const data = (await res.json()) as {
        token: string;
        sessionId: string;
        isGuest: boolean;
        expiresAt: string;
        profile: UserProfile;
      };
      this.current = {
        sessionId: data.sessionId,
        token: data.token,
        isGuest: Boolean(data.isGuest),
        expiresAt: data.expiresAt,
        profile: data.profile,
      };
      return this.current;
    } catch {
      return null;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.authFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore network failure on logout
    } finally {
      this.current = null;
    }
  }

  async updateProfile(patch: {
    username?: string;
    favoriteFranchise?: FranchiseId;
  }): Promise<UserProfile | null> {
    if (!this.current) return null;
    try {
      const res = await this.authFetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { profile: UserProfile };
      this.current = { ...this.current, profile: data.profile };
      return data.profile;
    } catch {
      return null;
    }
  }
}

export const sessionService = new SessionService();
