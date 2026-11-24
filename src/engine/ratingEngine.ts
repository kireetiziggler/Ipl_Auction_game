import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { DEFAULT_RATING_WEIGHTS, roundCr } from '../data/rulesets';
import { generateBestPlayingXI } from './playingXI';
import {
  AuctionState,
  FranchiseId,
  Player,
  RatingWeights,
  SeasonRuleset,
  TeamRatingBreakdown,
  TeamState,
} from './types';

function clamp(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(val)));
}

function clampFloat(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(val * 10) / 10));
}

/**
 * HIDDEN SECRET PERFORMANCE ENGINE (100% Deterministic, Zero Randomness)
 * Computes a player's hidden match-winning strength percentage (0..100) strictly from
 * real career cricket statistics (runs, batting average, strike rate, wickets, economy,
 * bowling strike rate, centuries/fifties, catches, and IPL experience).
 * Never exposed on player cards or auction stage!
 */
export function computeSecretPlayerStrength(player: Player): {
  winImpact: number;
  battingImpact: number;
  bowlingImpact: number;
  fieldingImpact: number;
} {
  const s = player.stats;
  const experienceBoost = Math.min(8, Math.log10(Math.max(1, s.matches) + 1) * 3.4);
  const cappedBonus = player.isCapped ? 3.5 : 0;

  // Batting performance strictly from career stats
  let battingImpact = 28;
  if (s.runs > 0 || s.battingAvg > 0 || s.strikeRate > 0) {
    const avgTerm = Math.min(38, s.battingAvg * 0.85);
    const srTerm = Math.min(34, Math.max(0, (s.strikeRate - 90) * 0.42));
    const volumeTerm = Math.min(16, Math.sqrt(Math.max(0, s.runs)) * 0.19);
    const milestoneTerm = Math.min(8, s.hundreds * 2.2 + s.fifties * 0.25);
    battingImpact = clampFloat(14 + avgTerm + srTerm + volumeTerm + milestoneTerm + cappedBonus * 0.5, 18, 99);
  }

  // Bowling performance strictly from career stats
  let bowlingImpact = 18;
  if (s.wickets > 0 || (s.economy > 0 && s.economy < 15)) {
    const econVal = s.economy > 0 ? s.economy : 9.2;
    const econTerm = Math.min(38, Math.max(4, (11.2 - econVal) * 8.4));
    const wktVolumeTerm = Math.min(24, Math.sqrt(Math.max(0, s.wickets)) * 1.9);
    const srVal = s.bowlingStrikeRate > 0 ? s.bowlingStrikeRate : 24;
    const bowlSrTerm = Math.min(20, Math.max(2, (30 - srVal) * 1.15));
    bowlingImpact = clampFloat(18 + econTerm + wktVolumeTerm + bowlSrTerm + cappedBonus * 0.5, 20, 99);
  }

  // Fielding / Keeping contribution from catches & match volume
  const catchesPerMatch = s.matches > 0 ? s.catches / s.matches : 0.35;
  const fieldingImpact = clampFloat(62 + Math.min(28, catchesPerMatch * 36) + (player.primaryRole === 'Wicketkeeper' ? 6 : 0), 58, 98);

  // Role-weighted win impact
  let winImpact: number;
  switch (player.primaryRole) {
    case 'Batter':
      winImpact = battingImpact * 0.78 + fieldingImpact * 0.12 + experienceBoost * 1.25;
      break;
    case 'Wicketkeeper':
      winImpact = battingImpact * 0.72 + fieldingImpact * 0.18 + experienceBoost * 1.25;
      break;
    case 'Fast Bowler':
    case 'Spinner':
      winImpact = bowlingImpact * 0.78 + fieldingImpact * 0.1 + battingImpact * 0.04 + experienceBoost * 1.25;
      break;
    case 'All-rounder':
    default: {
      const topSkill = Math.max(battingImpact, bowlingImpact);
      const secondarySkill = Math.min(battingImpact, bowlingImpact);
      winImpact = topSkill * 0.5 + secondarySkill * 0.36 + fieldingImpact * 0.08 + experienceBoost * 1.1;
      break;
    }
  }

  return {
    winImpact: clampFloat(winImpact, 35, 99.5),
    battingImpact,
    bowlingImpact,
    fieldingImpact,
  };
}

export function evaluateTeamSquad(
  team: TeamState,
  ruleset: SeasonRuleset,
  playerMap: Record<string, Player>,
  weights: RatingWeights = DEFAULT_RATING_WEIGHTS,
  customPlayingXIIds?: string[]
): TeamRatingBreakdown {
  const entries = team.squad
    .map((sp) => {
      const player = playerMap[sp.playerId];
      return player
        ? { player, priceCr: sp.boughtPriceCr, secret: computeSecretPlayerStrength(player) }
        : null;
    })
    .filter(
      (
        e
      ): e is {
        player: Player;
        priceCr: number;
        secret: ReturnType<typeof computeSecretPlayerStrength>;
      } => Boolean(e)
    );

  if (entries.length === 0) {
    return {
      franchiseId: team.franchiseId,
      overallScore: 0,
      winPercentage: 0,
      battingScore: 0,
      bowlingScore: 0,
      allRoundScore: 0,
      fieldingScore: 0,
      balanceScore: 0,
      overseasScore: 0,
      depthScore: 0,
      budgetEfficiencyScore: 0,
      weightedPoints: {
        batting: 0,
        bowling: 0,
        allRounders: 0,
        balance: 0,
        overseasBalance: 0,
        squadDepth: 0,
        budgetEfficiency: 0,
      },
      strengths: [],
      weaknesses: ['No players acquired yet.'],
      summary: `${FRANCHISE_MAP[team.franchiseId].name} has not signed any players yet.`,
      awards: {},
    };
  }

  // Evaluate Playing XI (user-chosen XI if provided, otherwise AI's optimal XI)
  const xi = generateBestPlayingXI(team, ruleset, playerMap, 'BALANCED', customPlayingXIIds);
  const xiPlayers = xi.starters.map((s) => ({
    player: s.player,
    secret: computeSecretPlayerStrength(s.player),
  }));

  // 1. Batting Quality (top 6 batters in Playing XI based on real career batting stats)
  const battingPool = [...xiPlayers]
    .sort((a, b) => b.secret.battingImpact - a.secret.battingImpact)
    .slice(0, 6);
  const avgBat =
    battingPool.reduce((s, e) => s + e.secret.battingImpact, 0) / Math.max(1, battingPool.length);
  const batCoverageFactor = Math.min(1, battingPool.length / 6);
  const hasFinisher = xiPlayers.some((e) => e.player.secondaryRole === 'Finisher');
  const hasOpener = xiPlayers.some((e) => e.player.secondaryRole === 'Top-order Batter');
  const battingScore = clamp(
    avgBat * batCoverageFactor + (hasFinisher ? 4 : -4) + (hasOpener ? 3 : -3)
  );

  // 2. Bowling Quality (top 5 bowlers in Playing XI based on real career bowling stats)
  const bowlingPool = [...xiPlayers]
    .filter(
      (e) =>
        e.player.primaryRole === 'Fast Bowler' ||
        e.player.primaryRole === 'Spinner' ||
        e.player.primaryRole === 'All-rounder'
    )
    .sort((a, b) => b.secret.bowlingImpact - a.secret.bowlingImpact)
    .slice(0, 5);
  const avgBowl =
    bowlingPool.length > 0
      ? bowlingPool.reduce((s, e) => s + e.secret.bowlingImpact, 0) / bowlingPool.length
      : 32;
  const bowlCoverageFactor = Math.min(1, bowlingPool.length / 5);
  const hasDeath = xiPlayers.some((e) => e.player.secondaryRole === 'Death-over Specialist');
  const hasPowerplay = xiPlayers.some(
    (e) =>
      e.player.secondaryRole === 'Powerplay Specialist' ||
      e.player.secondaryRole === 'Swing Bowler'
  );
  const hasSpinner = xiPlayers.some(
    (e) => e.player.primaryRole === 'Spinner' || e.player.secondaryRole === 'Spin All-rounder'
  );
  const bowlingScore = clamp(
    avgBowl * bowlCoverageFactor + (hasDeath ? 5 : -5) + (hasPowerplay ? 3 : -3) + (hasSpinner ? 3 : -4)
  );

  // 3. All-rounders Quality & Versatility
  const allRounders = xiPlayers.filter((e) => e.player.primaryRole === 'All-rounder');
  const avgAR =
    allRounders.length > 0
      ? allRounders.reduce((s, e) => s + e.secret.winImpact, 0) / allRounders.length
      : 42;
  const arCountBonus = Math.min(1, allRounders.length / 2);
  const allRoundScore = clamp(avgAR * (0.45 + 0.55 * arCountBonus));

  // 4. Fielding
  const fieldingScore = clamp(
    xiPlayers.reduce((s, e) => s + e.secret.fieldingImpact, 0) / Math.max(1, xiPlayers.length)
  );

  // 5. Team Balance in Playing XI
  const wkCount = xiPlayers.filter((e) => e.player.primaryRole === 'Wicketkeeper').length;
  const fastCount = xiPlayers.filter((e) => e.player.primaryRole === 'Fast Bowler').length;
  const spinCount = xiPlayers.filter((e) => e.player.primaryRole === 'Spinner').length;
  const leftHanders = xiPlayers.filter(
    (e) => e.player.battingStyle === 'Left-hand bat' && e.secret.battingImpact >= 55
  ).length;
  const hasExperiencedLeader = xiPlayers.some((e) => e.player.stats.matches >= 75);

  let balanceRaw = 46;
  if (wkCount >= 1) balanceRaw += 16;
  if (fastCount >= 2) balanceRaw += 10;
  else if (fastCount >= 1) balanceRaw += 5;
  if (spinCount >= 1) balanceRaw += 10;
  if (bowlingPool.length >= 5) balanceRaw += 8;
  else balanceRaw -= (5 - bowlingPool.length) * 6;
  if (leftHanders >= 2) balanceRaw += 5;
  if (hasExperiencedLeader) balanceRaw += 5;
  if (xi.overseasCount > ruleset.maxOverseasPlayingXI) balanceRaw -= 25;
  if (xiPlayers.length < 11) balanceRaw -= (11 - xiPlayers.length) * 7;
  const balanceScore = clamp(balanceRaw);

  // 6. Overseas & Indian Core Balance
  const overseas = entries.filter((e) => e.player.isOverseas);
  const indian = entries.filter((e) => !e.player.isOverseas);
  const avgOs =
    overseas.length > 0
      ? overseas.reduce((s, e) => s + e.secret.winImpact, 0) / overseas.length
      : 55;
  const avgInd =
    indian.length > 0
      ? indian.reduce((s, e) => s + e.secret.winImpact, 0) / indian.length
      : 55;
  let osRaw = avgOs * 0.45 + avgInd * 0.55;
  if (overseas.length > ruleset.maxOverseasSquad) osRaw -= 30;
  if (xi.overseasCount <= ruleset.maxOverseasPlayingXI && xi.overseasCount >= 3) osRaw += 7;
  if (indian.length >= 7) osRaw += 6;
  else osRaw -= (7 - indian.length) * 3;
  const overseasScore = clamp(osRaw);

  // 7. Squad Depth & Impact Sub
  const sizeRatio = Math.min(1, entries.length / Math.max(1, ruleset.minSquadSize));
  const impactStrength = xi.impactPlayer
    ? computeSecretPlayerStrength(xi.impactPlayer.player).winImpact
    : 55;
  const depthScore = clamp(sizeRatio * 64 + (impactStrength / 100) * 36);

  // 8. Budget Efficiency (secret stat performance per Crore spent)
  const totalStatValue = entries.reduce((s, e) => s + e.secret.winImpact / 10, 0);
  const totalSpent = Math.max(1, team.totalSpentCr);
  const valuePerCr = totalStatValue / totalSpent;
  let effRaw = 60 + (valuePerCr - 1.0) * 32;
  const purseUtilization = totalSpent / ruleset.initialPurseCr;
  if (purseUtilization < 0.45 && entries.length < ruleset.minSquadSize) {
    effRaw -= 18;
  }
  const budgetEfficiencyScore = clamp(effRaw);

  // Secret deterministic Playing XI Win Percentage (0..100)
  const xiAvgSecret =
    xiPlayers.length > 0
      ? xiPlayers.reduce((s, e) => s + e.secret.winImpact, 0) / xiPlayers.length
      : 0;
  const xiCountPenalty = xiPlayers.length < 11 ? (11 - xiPlayers.length) * 6.5 : 0;
  const overseasPenalty =
    xi.overseasCount > ruleset.maxOverseasPlayingXI
      ? (xi.overseasCount - ruleset.maxOverseasPlayingXI) * 10
      : 0;
  const wkPenalty = wkCount === 0 ? 8 : 0;
  const bowlingPenalty = bowlingPool.length < 5 ? (5 - bowlingPool.length) * 5.5 : 0;

  const rawWinPct =
    xiAvgSecret * 0.62 +
    battingScore * 0.12 +
    bowlingScore * 0.14 +
    balanceScore * 0.08 +
    (impactStrength * 0.04) -
    xiCountPenalty -
    overseasPenalty -
    wkPenalty -
    bowlingPenalty;

  const winPercentage = clampFloat(rawWinPct, 12, 98.8);

  // Normalize configurable weights for breakdown display
  const totalWeight =
    weights.batting +
    weights.bowling +
    weights.allRounders +
    weights.balance +
    weights.overseasBalance +
    weights.squadDepth +
    weights.budgetEfficiency;
  const wScale = totalWeight > 0 ? 100 / totalWeight : 1;

  const weightedPoints = {
    batting: roundCr((battingScore / 100) * weights.batting * wScale),
    bowling: roundCr((bowlingScore / 100) * weights.bowling * wScale),
    allRounders: roundCr((allRoundScore / 100) * weights.allRounders * wScale),
    balance: roundCr((balanceScore / 100) * weights.balance * wScale),
    overseasBalance: roundCr((overseasScore / 100) * weights.overseasBalance * wScale),
    squadDepth: roundCr((depthScore / 100) * weights.squadDepth * wScale),
    budgetEfficiency: roundCr((budgetEfficiencyScore / 100) * weights.budgetEfficiency * wScale),
  };

  // Championship Score tracks deterministic Playing XI winPercentage directly
  const overallScore = clamp(winPercentage);

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (battingScore >= 80) strengths.push('High-impact Playing XI batting firepower');
  else if (battingScore < 65) weaknesses.push('Playing XI batting unit lacks proven run-scorers');

  if (bowlingScore >= 80) strengths.push('Clinical multi-phase wicket-taking bowling attack');
  else if (bowlingScore < 65) weaknesses.push('Bowling economy & strike threat need reinforcement');

  if (!hasDeath) weaknesses.push('No specialist death-over bowler in Playing XI');
  else strengths.push('Proven death-over execution in overs 16–20');

  if (allRoundScore >= 78) strengths.push('Strong dual-skill all-rounder flexibility');
  else if (allRounders.length < 1) weaknesses.push('Missing a frontline all-rounder in the XI');

  if (wkCount === 0) weaknesses.push('Missing a specialist wicketkeeper in Playing XI');
  if (spinCount === 0) weaknesses.push('No specialist spinner selected in Playing XI');
  if (xiPlayers.length < 11) {
    weaknesses.push(`Incomplete Playing XI (${xiPlayers.length}/11)`);
  }

  // Awards (strictly stat-driven)
  const highestPriced = [...entries].sort((a, b) => b.priceCr - a.priceCr)[0];
  const bestBargainRaw = [...entries]
    .map((e) => ({
      player: e.player,
      priceCr: e.priceCr,
      valueGapCr: roundCr(e.secret.winImpact / 7.5 - e.priceCr),
    }))
    .sort((a, b) => b.valueGapCr - a.valueGapCr)[0];
  const bestIndian = [...indian].sort((a, b) => b.secret.winImpact - a.secret.winImpact)[0];
  const bestOverseas = [...overseas].sort((a, b) => b.secret.winImpact - a.secret.winImpact)[0];
  const bestBatter = [...entries]
    .filter((e) => e.player.primaryRole === 'Batter' || e.player.primaryRole === 'Wicketkeeper')
    .sort((a, b) => b.secret.battingImpact - a.secret.battingImpact)[0];
  const bestBowler = [...entries]
    .filter((e) => e.player.primaryRole === 'Fast Bowler' || e.player.primaryRole === 'Spinner')
    .sort((a, b) => b.secret.bowlingImpact - a.secret.bowlingImpact)[0];
  const bestAllRounder = [...entries]
    .filter((e) => e.player.primaryRole === 'All-rounder')
    .sort((a, b) => b.secret.winImpact - a.secret.winImpact)[0];

  const franchiseName = FRANCHISE_MAP[team.franchiseId].name;
  const topStrength = strengths[0]?.toLowerCase() ?? 'balanced squad fundamentals';
  const topWeakness = weaknesses[0]?.toLowerCase() ?? 'minor bench specialization gaps';
  const summary = `${franchiseName} achieved a ${winPercentage.toFixed(1)}% championship strength index based on real player performance metrics. Key strength: ${topStrength}; focus area: ${topWeakness}.`;

  return {
    franchiseId: team.franchiseId,
    overallScore,
    winPercentage,
    battingScore,
    bowlingScore,
    allRoundScore,
    fieldingScore,
    balanceScore,
    overseasScore,
    depthScore,
    budgetEfficiencyScore,
    weightedPoints,
    strengths: strengths.slice(0, 4),
    weaknesses: weaknesses.slice(0, 4),
    summary,
    awards: {
      highestPriced: highestPriced
        ? { player: highestPriced.player, priceCr: highestPriced.priceCr }
        : undefined,
      bestBargain: bestBargainRaw,
      bestIndian: bestIndian ? { player: bestIndian.player, priceCr: bestIndian.priceCr } : undefined,
      bestOverseas: bestOverseas
        ? { player: bestOverseas.player, priceCr: bestOverseas.priceCr }
        : undefined,
      bestBatter: bestBatter ? { player: bestBatter.player, priceCr: bestBatter.priceCr } : undefined,
      bestBowler: bestBowler ? { player: bestBowler.player, priceCr: bestBowler.priceCr } : undefined,
      bestAllRounder: bestAllRounder
        ? { player: bestAllRounder.player, priceCr: bestAllRounder.priceCr }
        : undefined,
    },
  };
}

export function evaluateAllFranchises(
  state: AuctionState,
  playerMap: Record<string, Player>,
  weights: RatingWeights = DEFAULT_RATING_WEIGHTS,
  customXIByFranchise?: Partial<Record<FranchiseId, string[]>>
): Record<FranchiseId, TeamRatingBreakdown> {
  const result = {} as Record<FranchiseId, TeamRatingBreakdown>;
  for (const fid of ALL_FRANCHISE_IDS) {
    result[fid] = evaluateTeamSquad(
      state.teams[fid],
      state.ruleset,
      playerMap,
      weights,
      customXIByFranchise?.[fid]
    );
  }
  return result;
}

export function getRankedLeaderboard(
  state: AuctionState,
  ratings: Record<FranchiseId, TeamRatingBreakdown>
): { rank: number; franchiseId: FranchiseId; team: TeamState; rating: TeamRatingBreakdown }[] {
  return ALL_FRANCHISE_IDS.map((fid) => ({
    franchiseId: fid,
    team: state.teams[fid],
    rating: ratings[fid],
  }))
    .sort((a, b) => {
      if (b.rating.winPercentage !== a.rating.winPercentage) {
        return b.rating.winPercentage - a.rating.winPercentage;
      }
      if (b.rating.bowlingScore !== a.rating.bowlingScore) {
        return b.rating.bowlingScore - a.rating.bowlingScore;
      }
      return b.rating.battingScore - a.rating.battingScore;
    })
    .map((item, idx) => ({ ...item, rank: idx + 1 }));
}

export interface StrategyComparisonReport {
  userFranchiseId: FranchiseId;
  userSpendByRole: Record<string, number>;
  leagueAvgSpendByRole: Record<string, number>;
  avgPurchasePriceCr: number;
  leagueAvgPurchasePriceCr: number;
  insights: string[];
  missedTargets: { player: Player; soldTo: FranchiseId; priceCr: number }[];
  overpaidBuys: { player: Player; paidCr: number; estCr: number }[];
  bargainBuys: { player: Player; paidCr: number; estCr: number }[];
}

export function buildStrategyComparison(
  state: AuctionState,
  userFranchiseId: FranchiseId,
  playerMap: Record<string, Player>
): StrategyComparisonReport {
  const roles = ['Batter', 'Wicketkeeper', 'All-rounder', 'Fast Bowler', 'Spinner'];
  const userSpendByRole: Record<string, number> = {};
  const leagueTotalSpendByRole: Record<string, number> = {};
  for (const r of roles) {
    userSpendByRole[r] = 0;
    leagueTotalSpendByRole[r] = 0;
  }

  let leagueTotalSpend = 0;
  let leagueTotalPlayers = 0;

  for (const fid of ALL_FRANCHISE_IDS) {
    const t = state.teams[fid];
    for (const sp of t.squad) {
      const p = playerMap[sp.playerId];
      if (!p) continue;
      leagueTotalSpendByRole[p.primaryRole] = roundCr(
        (leagueTotalSpendByRole[p.primaryRole] ?? 0) + sp.boughtPriceCr
      );
      leagueTotalSpend += sp.boughtPriceCr;
      leagueTotalPlayers += 1;
      if (fid === userFranchiseId) {
        userSpendByRole[p.primaryRole] = roundCr(
          (userSpendByRole[p.primaryRole] ?? 0) + sp.boughtPriceCr
        );
      }
    }
  }

  const leagueAvgSpendByRole: Record<string, number> = {};
  for (const r of roles) {
    leagueAvgSpendByRole[r] = roundCr(leagueTotalSpendByRole[r] / ALL_FRANCHISE_IDS.length);
  }

  const userTeam = state.teams[userFranchiseId];
  const avgPurchasePriceCr =
    userTeam.squad.length > 0 ? roundCr(userTeam.totalSpentCr / userTeam.squad.length) : 0;
  const leagueAvgPurchasePriceCr =
    leagueTotalPlayers > 0 ? roundCr(leagueTotalSpend / leagueTotalPlayers) : 0;

  const userOwnedIds = new Set(userTeam.squad.map((s) => s.playerId));
  const userBidPlayerIds = new Set(
    state.allBids.filter((b) => b.franchiseId === userFranchiseId).map((b) => b.playerId)
  );
  const missedTargets: { player: Player; soldTo: FranchiseId; priceCr: number }[] = [];
  for (const fid of ALL_FRANCHISE_IDS) {
    if (fid === userFranchiseId) continue;
    for (const sp of state.teams[fid].squad) {
      if (userBidPlayerIds.has(sp.playerId) && !userOwnedIds.has(sp.playerId)) {
        const p = playerMap[sp.playerId];
        if (p) missedTargets.push({ player: p, soldTo: fid, priceCr: sp.boughtPriceCr });
      }
    }
  }
  missedTargets.sort(
    (a, b) => computeSecretPlayerStrength(b.player).winImpact - computeSecretPlayerStrength(a.player).winImpact
  );

  const userEntries = userTeam.squad
    .map((s) => ({ player: playerMap[s.playerId], paidCr: s.boughtPriceCr }))
    .filter((x): x is { player: Player; paidCr: number } => Boolean(x.player));

  const overpaidBuys = userEntries
    .filter((e) => e.paidCr > e.player.ratings.estimatedValueCr + 1.5)
    .map((e) => ({ player: e.player, paidCr: e.paidCr, estCr: e.player.ratings.estimatedValueCr }))
    .sort((a, b) => b.paidCr - b.estCr - (a.paidCr - a.estCr))
    .slice(0, 4);

  const bargainBuys = userEntries
    .filter((e) => e.paidCr <= e.player.ratings.estimatedValueCr - 0.5)
    .map((e) => ({ player: e.player, paidCr: e.paidCr, estCr: e.player.ratings.estimatedValueCr }))
    .sort((a, b) => b.estCr - b.paidCr - (a.estCr - a.paidCr))
    .slice(0, 4);

  const insights: string[] = [];
  const batDiffPct =
    leagueAvgSpendByRole.Batter > 0
      ? Math.round(
          ((userSpendByRole.Batter - leagueAvgSpendByRole.Batter) / leagueAvgSpendByRole.Batter) *
            100
        )
      : 0;
  if (Math.abs(batDiffPct) >= 10) {
    insights.push(
      `You spent ${Math.abs(batDiffPct)}% ${batDiffPct > 0 ? 'more' : 'less'} on specialist batters than the league average.`
    );
  }
  const paceDiffPct =
    leagueAvgSpendByRole['Fast Bowler'] > 0
      ? Math.round(
          ((userSpendByRole['Fast Bowler'] - leagueAvgSpendByRole['Fast Bowler']) /
            leagueAvgSpendByRole['Fast Bowler']) *
            100
        )
      : 0;
  if (Math.abs(paceDiffPct) >= 10) {
    insights.push(
      `Your fast-bowling investment was ${Math.abs(paceDiffPct)}% ${paceDiffPct > 0 ? 'above' : 'below'} rival franchises.`
    );
  }
  if (bargainBuys[0]) {
    insights.push(
      `Smartest value acquisition: ${bargainBuys[0].player.name} signed for ₹${bargainBuys[0].paidCr.toFixed(2)} Cr.`
    );
  }
  if (missedTargets[0]) {
    insights.push(
      `Closest missed target: ${missedTargets[0].player.name}, signed by ${FRANCHISE_MAP[missedTargets[0].soldTo].name} for ₹${missedTargets[0].priceCr.toFixed(2)} Cr.`
    );
  }
  if (insights.length === 0) {
    insights.push('Your budget allocation closely tracked balanced championship benchmarks across roles.');
  }

  return {
    userFranchiseId,
    userSpendByRole,
    leagueAvgSpendByRole,
    avgPurchasePriceCr,
    leagueAvgPurchasePriceCr,
    insights,
    missedTargets: missedTargets.slice(0, 6),
    overpaidBuys,
    bargainBuys,
  };
}
