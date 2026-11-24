import { DEFAULT_RATING_WEIGHTS } from '../data/rulesets';
import { GameSettings, SavedAuction, Tournament, UserProfile } from '../engine/types';

const KEYS = {
  SETTINGS: 'ipl_arena_settings_v1',
  PROFILE: 'ipl_arena_guest_profile_v1',
  SAVED_AUCTIONS: 'ipl_arena_saved_auctions_v1',
  TOURNAMENTS: 'ipl_arena_tournaments_v1',
  CLIENT_ID: 'ipl_arena_client_id_v1',
};

export const DEFAULT_SETTINGS: GameSettings = {
  theme: 'dark',
  voiceEnabled: true,
  voiceVolume: 0.9,
  voiceSpeed: 1.06,
  captionsEnabled: true,
  sfxEnabled: true,
  masterVolume: 0.85,
  sfxVolume: 0.85,
  musicEnabled: false,
  musicVolume: 0.3,
  reducedMotion: false,
  defaultDifficulty: 'NORMAL',
  defaultRulesetId: 'sim-2026-mega',
  defaultAuctionSpeed: 'NORMAL',
  defaultNominationMode: 'SET_ORDER',
  confirmBeforeHighBidCr: 15,
  ratingWeights: DEFAULT_RATING_WEIGHTS,
};

export function getOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(KEYS.CLIENT_ID);
    if (existing) return existing;
    const next = `owner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(KEYS.CLIENT_ID, next);
    return next;
  } catch {
    return `owner_${Date.now().toString(36)}`;
  }
}

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEYS.SETTINGS);
    if (!raw) return DEFAULT_SETTINGS;
    return {
      ...DEFAULT_SETTINGS,
      ...JSON.parse(raw),
      ratingWeights: {
        ...DEFAULT_RATING_WEIGHTS,
        ...(JSON.parse(raw)?.ratingWeights ?? {}),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    localStorage.setItem(KEYS.SETTINGS, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadGuestProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(KEYS.PROFILE);
    if (raw) return JSON.parse(raw) as UserProfile;
  } catch {
    // Fallback
  }
  return {
    id: getOrCreateClientId(),
    username: 'Franchise Owner',
    isGuest: true,
    favoriteFranchise: 'CSK',
    avatarColor: '#F59E0B',
    stats: {
      auctionsPlayed: 0,
      auctionsWon: 0,
      bestRating: 0,
      avgRating: 0,
      tournamentsWon: 0,
    },
  };
}

export function saveGuestProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(KEYS.PROFILE, JSON.stringify(profile));
  } catch {
    // Ignore
  }
}

export function loadSavedAuctions(): SavedAuction[] {
  try {
    const raw = localStorage.getItem(KEYS.SAVED_AUCTIONS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveAuctionRecord(record: SavedAuction): SavedAuction[] {
  const existing = loadSavedAuctions().filter((a) => a.id !== record.id);
  const next = [record, ...existing].slice(0, 20);
  try {
    localStorage.setItem(KEYS.SAVED_AUCTIONS, JSON.stringify(next));
  } catch {
    // Trim older snapshots if quota exceeded
    try {
      localStorage.setItem(KEYS.SAVED_AUCTIONS, JSON.stringify(next.slice(0, 6)));
    } catch {
      // Ignore
    }
  }
  return next;
}

export function deleteSavedAuction(id: string): SavedAuction[] {
  const next = loadSavedAuctions().filter((a) => a.id !== id);
  try {
    localStorage.setItem(KEYS.SAVED_AUCTIONS, JSON.stringify(next));
  } catch {
    // Ignore
  }
  return next;
}

export function loadTournaments(): Tournament[] {
  try {
    const raw = localStorage.getItem(KEYS.TOURNAMENTS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveTournaments(list: Tournament[]): void {
  try {
    localStorage.setItem(KEYS.TOURNAMENTS, JSON.stringify(list.slice(0, 15)));
  } catch {
    // Ignore
  }
}
