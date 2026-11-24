import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { roundCr } from '../data/rulesets';
import {
  getMaxAllowedBidCr,
  getRequiredNextBidCr,
  validateBid,
} from './auctionStateMachine';
import {
  AIDifficulty,
  AIPersonality,
  AuctionState,
  FranchiseId,
  Player,
  PrimaryRole,
  TeamState,
} from './types';

export interface AIBidDecision {
  shouldBid: boolean;
  franchiseId: FranchiseId;
  bidAmountCr: number;
  maxWillingnessCr: number;
  confidence: number; // 0 to 1
  reason: string;
}

const TARGET_ROLE_QUOTA: Record<PrimaryRole, number> = {
  Batter: 5,
  Wicketkeeper: 2,
  'All-rounder': 4,
  'Fast Bowler': 4,
  Spinner: 3,
};

function getDifficultyParams(diff: AIDifficulty) {
  switch (diff) {
    case 'EASY':
      return { valuationNoise: 0.22, scarcityWeight: 0.4, psychWeight: 0.2, discipline: 0.72 };
    case 'NORMAL':
      return { valuationNoise: 0.13, scarcityWeight: 0.75, psychWeight: 0.55, discipline: 0.88 };
    case 'HARD':
      return { valuationNoise: 0.07, scarcityWeight: 1.0, psychWeight: 0.85, discipline: 0.96 };
    case 'EXPERT':
      return { valuationNoise: 0.04, scarcityWeight: 1.2, psychWeight: 1.1, discipline: 1.04 };
  }
}

function getPersonalityMultiplier(
  personality: AIPersonality,
  player: Player,
  team: TeamState
): { mult: number; label: string } {
  switch (personality) {
    case 'AGGRESSIVE_BIDDER':
      if (player.ratings.overall >= 88) return { mult: 1.18, label: 'aggressive push for elite talent' };
      return { mult: 1.06, label: 'assertive bidding stance' };

    case 'VALUE_STRATEGIST':
      if (player.ratings.overall >= 82 && player.ratings.estimatedValueCr <= 9) {
        return { mult: 1.12, label: 'high value-to-cost efficiency target' };
      }
      return { mult: 0.92, label: 'strict fair-value ceiling discipline' };

    case 'BATTING_SPECIALIST':
      if (player.primaryRole === 'Batter' || player.primaryRole === 'Wicketkeeper') {
        return { mult: 1.16, label: 'priority batting firepower profile' };
      }
      return { mult: 0.96, label: 'conserving purse for batting depth' };

    case 'BOWLING_SPECIALIST':
      if (player.primaryRole === 'Fast Bowler' || player.primaryRole === 'Spinner') {
        return { mult: 1.17, label: 'priority bowling attack reinforcement' };
      }
      return { mult: 0.95, label: 'preserving budget for strike bowlers' };

    case 'ALL_ROUNDER_SPECIALIST':
      if (player.primaryRole === 'All-rounder') {
        return { mult: 1.22, label: 'versatile all-rounder priority' };
      }
      return { mult: 0.97, label: 'balanced multi-skill focus' };

    case 'YOUTH_STRATEGIST':
      if (player.age <= 25 && player.ratings.potential >= 88) {
        return { mult: 1.22, label: 'high-upside young core target' };
      }
      if (player.age >= 35) return { mult: 0.84, label: 'prefers younger long-term core' };
      return { mult: 1.0, label: 'age-balanced squad target' };

    case 'SUPERSTAR_COLLECTOR':
      if (
        player.category === 'Marquee' ||
        player.category === 'Marquee Set 1' ||
        player.category === 'Marquee Set 2' ||
        player.ratings.overall >= 90
      ) {
        return { mult: 1.24, label: 'marquee icon acquisition drive' };
      }
      return { mult: 0.91, label: 'saving purse for marquee superstars' };

    case 'BUDGET_STRATEGIST':
      if (team.squad.length < 4 && player.ratings.estimatedValueCr > 13) {
        return { mult: 0.85, label: 'avoiding early marquee overpayment' };
      }
      return { mult: 1.04, label: 'late-auction bargain calculation' };

    case 'BALANCED_STRATEGIST':
    default:
      if (player.ratings.captaincy >= 85 || player.stats.matches >= 80) {
        return { mult: 1.08, label: 'proven IPL experience and balance' };
      }
      return { mult: 1.02, label: 'balanced squad construction' };
  }
}

/** Deterministic per-lot pseudo-random offset so an AI team has a steady ceiling during one player's bidding war */
function lotSeededNoise(roomId: string, franchiseId: FranchiseId, playerId: string): number {
  const str = `${roomId}:${franchiseId}:${playerId}`;
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const norm = ((hash >>> 0) % 1000) / 1000; // 0..1
  return norm * 2 - 1; // -1..+1
}

export function evaluateAIMaxWillingness(
  state: AuctionState,
  franchiseId: FranchiseId,
  player: Player,
  playerMap: Record<string, Player>
): { maxCr: number; reason: string } {
  const team = state.teams[franchiseId];
  const franchiseCfg = FRANCHISE_MAP[franchiseId];
  const diff = getDifficultyParams(state.aiDifficulty);

  const squadPlayers = team.squad
    .map((sp) => playerMap[sp.playerId])
    .filter((p): p is Player => Boolean(p));

  const roleCount = squadPlayers.filter((p) => p.primaryRole === player.primaryRole).length;
  const targetForRole = TARGET_ROLE_QUOTA[player.primaryRole];

  // 1. Base fair value scaled to ruleset purse vs standard 120 Cr
  const purseScale = state.ruleset.initialPurseCr / 120.0;
  let valuation = player.ratings.estimatedValueCr * purseScale;

  // 2. Team need factor
  let needFactor = 1.0;
  let needReason = '';
  if (roleCount === 0) {
    needFactor = player.primaryRole === 'Wicketkeeper' ? 1.24 : 1.16;
    needReason = `fills critical ${player.primaryRole.toLowerCase()} vacancy`;
  } else if (roleCount < targetForRole) {
    needFactor = 1.04;
    needReason = `adds needed ${player.primaryRole.toLowerCase()} depth`;
  } else if (roleCount >= targetForRole + 1) {
    needFactor = 0.55;
    needReason = `role already well covered`;
  } else {
    needFactor = 0.78;
    needReason = `depth upgrade`;
  }

  // Specialty need boost (death bowler / finisher / captain)
  const hasDeathBowler = squadPlayers.some((p) => p.secondaryRole === 'Death-over Specialist');
  const hasFinisher = squadPlayers.some((p) => p.secondaryRole === 'Finisher');
  const hasCaptain = squadPlayers.some((p) => p.ratings.captaincy >= 85);

  if (!hasDeathBowler && player.secondaryRole === 'Death-over Specialist') {
    needFactor *= 1.14;
    needReason = 'secures rare death-over specialist';
  } else if (!hasFinisher && player.secondaryRole === 'Finisher') {
    needFactor *= 1.1;
    needReason = 'fills specialist finisher slot';
  } else if (!hasCaptain && player.ratings.captaincy >= 86) {
    needFactor *= 1.08;
    needReason = 'adds proven captaincy leadership';
  }

  // 3. Role scarcity in remaining queue
  const remainingSameRoleHigh = state.playerQueue
    .map((id) => playerMap[id])
    .filter(
      (p) => p && p.primaryRole === player.primaryRole && p.ratings.overall >= player.ratings.overall - 3
    ).length;

  let scarcityMult = 1.0;
  if (remainingSameRoleHigh <= 1 && roleCount === 0) {
    scarcityMult = 1 + 0.16 * diff.scarcityWeight;
    needReason = `scarce elite ${player.primaryRole.toLowerCase()} remaining in pool`;
  } else if (remainingSameRoleHigh >= 5 && team.squad.length < 8) {
    scarcityMult = 1 - 0.06 * diff.scarcityWeight;
  }

  // 4. Overseas quota pressure
  let overseasMult = 1.0;
  if (player.isOverseas) {
    const osRemaining = state.ruleset.maxOverseasSquad - team.overseasCount;
    if (osRemaining <= 1 && player.ratings.overall < 86) {
      overseasMult = 0.72;
    } else if (osRemaining <= 2 && player.ratings.overall < 84) {
      overseasMult = 0.85;
    }
  } else {
    // Indian core carries strategic premium in IPL
    overseasMult = 1.07;
  }

  // 5. Franchise personality & preferred role
  const personality = getPersonalityMultiplier(team.aiPersonality, player, team);
  const preferredBonus = franchiseCfg.preferredRoles.includes(player.primaryRole) ? 1.05 : 1.0;

  // 6. Bidding psychology: react to human/rival bidding patterns
  let psychMult = 1.0;
  if (state.currentBidderId && state.currentBidderId !== franchiseId) {
    const rivalTeam = state.teams[state.currentBidderId];
    const rivalPsych = state.psychology[state.currentBidderId];

    // If rival repeatedly chases this role and it is scarce, contest strategically
    if (
      rivalPsych &&
      rivalPsych.roleInterest[player.primaryRole] >= 3 &&
      remainingSameRoleHigh <= 2 &&
      roleCount < targetForRole
    ) {
      psychMult += 0.08 * diff.psychWeight;
    }
    // If rival has already spent heavily and is overpaying past estimate, let them burn purse
    if (
      rivalTeam &&
      rivalTeam.purseRemainingCr < state.ruleset.initialPurseCr * 0.35 &&
      state.currentBidCr > valuation * 1.15
    ) {
      psychMult -= 0.12 * diff.psychWeight;
    }
  }

  // 7. Budget pressure & remaining slots calibration
  const slotsLeft = Math.max(1, state.ruleset.minSquadSize - team.squad.length);
  const avgPursePerSlot = team.purseRemainingCr / slotsLeft;
  let budgetPressure = 1.0;
  if (avgPursePerSlot < 2.2) {
    budgetPressure = 0.62;
  } else if (avgPursePerSlot < 4.0) {
    budgetPressure = 0.84;
  } else if (avgPursePerSlot > 10.5 && state.playerQueue.length < 30) {
    // Late auction surplus purse -> willing to spend more on quality remaining players
    budgetPressure = 1.24;
  }

  // 8. Seeded per-lot variance for natural, non-robotic variation
  const noise = 1 + lotSeededNoise(state.roomId, franchiseId, player.id) * diff.valuationNoise;

  valuation =
    valuation *
    needFactor *
    scarcityMult *
    overseasMult *
    personality.mult *
    preferredBonus *
    psychMult *
    budgetPressure *
    noise;

  // Hard cap by ruleset max allowed bid & sensible share of remaining purse
  const maxAllowed = getMaxAllowedBidCr(team, state.ruleset);
  const singlePlayerPurseCap =
    player.ratings.overall >= 92
      ? team.purseRemainingCr * 0.32
      : player.ratings.overall >= 86
      ? team.purseRemainingCr * 0.24
      : team.purseRemainingCr * 0.16;

  const finalMax = roundCr(Math.min(maxAllowed, Math.max(player.basePriceCr * 0.9, Math.min(valuation, singlePlayerPurseCap))));
  const reason = `${personality.label}; ${needReason}`;

  return { maxCr: finalMax, reason };
}

/**
 * Selects the strongest AI contender willing to place the next valid bid on the current player.
 * Returns null if all AI franchises choose to pass or cannot afford the next increment.
 */
export function selectNextAIBidder(
  state: AuctionState,
  playerMap: Record<string, Player>
): AIBidDecision | null {
  if (!state.currentPlayerId) return null;
  const player = playerMap[state.currentPlayerId];
  if (!player) return null;

  const nextRequired = getRequiredNextBidCr(state, player);
  const candidates: AIBidDecision[] = [];

  for (const fid of ALL_FRANCHISE_IDS) {
    const team = state.teams[fid];
    if (team.controllerType !== 'AI') continue;
    if (team.passedCurrentPlayer) continue;
    if (state.currentBidderId === fid) continue;

    const validation = validateBid(state, fid, player, nextRequired);
    if (!validation.valid) continue;

    const { maxCr, reason } = evaluateAIMaxWillingness(state, fid, player, playerMap);
    if (nextRequired <= maxCr) {
      const margin = (maxCr - nextRequired) / Math.max(1, maxCr);
      candidates.push({
        shouldBid: true,
        franchiseId: fid,
        bidAmountCr: nextRequired,
        maxWillingnessCr: maxCr,
        confidence: Math.min(1, Math.max(0.15, margin + 0.35)),
        reason,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Weight toward the AI franchise with strongest conviction + slight variety so bidding wars feel organic
  candidates.sort((a, b) => b.confidence - a.confidence);
  const topPool = candidates.slice(0, Math.min(3, candidates.length));
  const pickIndex = Math.floor(Math.random() * topPool.length);
  return topPool[pickIndex];
}

/**
 * AI Stage 1 RTM Decision: Should the former franchise invoke its Right To Match card?
 */
export function decideAIRTMOffer(
  state: AuctionState,
  rtmFranchiseId: FranchiseId,
  player: Player,
  currentBidCr: number,
  playerMap: Record<string, Player>
): boolean {
  const team = state.teams[rtmFranchiseId];
  if (!team || team.rtmRemaining <= 0) return false;
  const maxAllowed = getMaxAllowedBidCr(team, state.ruleset);
  if (currentBidCr > maxAllowed) return false;

  const { maxCr } = evaluateAIMaxWillingness(state, rtmFranchiseId, player, playerMap);
  // Slight loyalty boost (10%) for former players
  return currentBidCr <= roundCr(maxCr * 1.1);
}

/**
 * AI Stage 2 RTM Counter-Bid: When RTM is invoked, winning AI bidder gets ONE final raise chance.
 * Returns a higher counter-bid amount in Crores, or null if AI declines to raise further.
 */
export function decideAIRTMCounterBid(
  state: AuctionState,
  winningFranchiseId: FranchiseId,
  player: Player,
  initialBidCr: number,
  playerMap: Record<string, Player>
): number | null {
  const team = state.teams[winningFranchiseId];
  if (!team) return null;
  const maxAllowed = getMaxAllowedBidCr(team, state.ruleset);
  const { maxCr } = evaluateAIMaxWillingness(state, winningFranchiseId, player, playerMap);

  const ceiling = roundCr(Math.min(maxAllowed, maxCr * 1.12));
  if (ceiling <= initialBidCr + 0.25) {
    return null;
  }

  // Push smartly toward ceiling (between +0.5 Cr and +2.0 Cr above initial bid)
  const desiredRaise = Math.min(ceiling - initialBidCr, Math.max(0.5, (ceiling - initialBidCr) * 0.75));
  const roundedRaise = Math.max(0.25, Math.round(desiredRaise * 4) / 4);
  const counterCr = roundCr(Math.min(maxAllowed, initialBidCr + roundedRaise));
  return counterCr > initialBidCr ? counterCr : null;
}

/**
 * AI Stage 3 RTM Final Match: Should the former franchise match the winning bidder's counter-bid?
 */
export function decideAIRTMFinalMatch(
  state: AuctionState,
  rtmFranchiseId: FranchiseId,
  player: Player,
  counterBidCr: number,
  playerMap: Record<string, Player>
): boolean {
  const team = state.teams[rtmFranchiseId];
  if (!team) return false;
  const maxAllowed = getMaxAllowedBidCr(team, state.ruleset);
  if (counterBidCr > maxAllowed) return false;

  const { maxCr } = evaluateAIMaxWillingness(state, rtmFranchiseId, player, playerMap);
  return counterBidCr <= roundCr(maxCr * 1.15);
}

