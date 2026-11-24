import { Player, PrimaryRole } from './types';

export type CardTier = 'GOLD' | 'SILVER' | 'BRONZE';

export interface PlayerCardAttributes {
  tier: CardTier;
  ovr: number;
  roleCode: string;
  bat: number;
  run: number;
  bow: number;
  cat: number;
  fie: number;
  phy: number;
}

function clampAttr(val: number, min = 25, max = 99): number {
  return Math.max(min, Math.min(max, Math.round(val)));
}

/**
 * Assigns Gold / Silver / Bronze card tier based on player overall rating.
 * Across the 307-player IPL 2026 pool:
 *   GOLD   (>= 82): ~108 marquee & star players
 *   SILVER (74-81): ~100 capped & emerging starters
 *   BRONZE (<  74): ~99 uncapped & domestic prospects
 */
export function getCardTier(player: Player): CardTier {
  const ovr = player.ratings.overall;
  if (ovr >= 82) return 'GOLD';
  if (ovr >= 74) return 'SILVER';
  return 'BRONZE';
}

export function getCardRoleCode(role: PrimaryRole): string {
  switch (role) {
    case 'Batter':
      return 'BAT';
    case 'Wicketkeeper':
      return 'WK';
    case 'All-rounder':
      return 'AR';
    case 'Fast Bowler':
      return 'BOWL';
    case 'Spinner':
      return 'SPIN';
    default:
      return 'PRO';
  }
}

/**
 * Deterministically computes the 6 FIFA-style Cricket Card attributes
 * (BAT, RUN, BOW, CAT, FIE, PHY) directly from each player's career stats and ratings.
 */
export function computeCardAttributes(player: Player): PlayerCardAttributes {
  const r = player.ratings;
  const s = player.stats;

  // BAT: Core batting skill
  const bat = clampAttr(r.batting, 22, 99);

  // RUN: Running between wickets, strike acceleration & athleticism
  const srFactor = s.strikeRate > 0 ? Math.min(18, Math.max(-8, (s.strikeRate - 122) * 0.28)) : 0;
  const ageAgility = player.age <= 27 ? 5 : player.age <= 32 ? 2 : player.age >= 36 ? -4 : 0;
  const run = clampAttr(r.fielding * 0.52 + r.form * 0.38 + srFactor + ageAgility + 8, 42, 98);

  // BOW: Core bowling skill
  const bow = clampAttr(r.bowling, 15, 99);

  // CAT: Catching / safe hands / wicketkeeping reflexes
  const catchesPerMatch = s.matches > 0 ? s.catches / s.matches : 0.35;
  const wkBoost = player.primaryRole === 'Wicketkeeper' ? 9 : 0;
  const cat = clampAttr(r.fielding * 0.72 + Math.min(20, catchesPerMatch * 24) + wkBoost + 8, 52, 98);

  // FIE: Ground fielding & throwing arm
  const fie = clampAttr(r.fielding, 48, 98);

  // PHY: Physical fitness, durability & match stamina
  const paceStamina = player.primaryRole === 'Fast Bowler' || player.primaryRole === 'All-rounder' ? 4 : 0;
  const experienceEndurance = Math.min(6, Math.floor(s.matches / 40));
  const phy = clampAttr(r.form * 0.48 + r.fielding * 0.36 + paceStamina + experienceEndurance + 10, 54, 98);

  return {
    tier: getCardTier(player),
    ovr: clampAttr(r.overall, 60, 99),
    roleCode: getCardRoleCode(player.primaryRole),
    bat,
    run,
    bow,
    cat,
    fie,
    phy,
  };
}
