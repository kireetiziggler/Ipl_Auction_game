import { ALL_FRANCHISE_IDS } from '../data/franchises';
import { DEFAULT_RATING_WEIGHTS } from '../data/rulesets';
import { generateBestPlayingXI } from './playingXI';
import { computeSecretPlayerStrength, evaluateAllFranchises } from './ratingEngine';
import {
  AuctionState,
  FranchiseId,
  Player,
  PlayingXIConfig,
  RatingWeights,
  TeamRatingBreakdown,
} from './types';

export interface PlayingXIMatchResult {
  matchNumber: number;
  roundNumber: number;
  homeId: FranchiseId;
  awayId: FranchiseId;
  homeStrength: number;
  awayStrength: number;
  homeScore: number;
  homeWickets: number;
  awayScore: number;
  awayWickets: number;
  homeScoreText: string;
  awayScoreText: string;
  winnerId: FranchiseId;
  loserId: FranchiseId;
  marginText: string;
  nrrDeltaHome: number;
  playerOfMatch: Player | null;
  playerOfMatchSummary: string;
  isUserMatch: boolean;
}

export interface CompetitionStandingRow {
  rank: number;
  franchiseId: FranchiseId;
  played: number;
  won: number;
  lost: number;
  points: number;
  nrr: number;
  xiStrength: number;
  rating: TeamRatingBreakdown;
  xiConfig: PlayingXIConfig;
}

export interface PlayingXICompetitionSummary {
  matches: PlayingXIMatchResult[];
  userMatches: PlayingXIMatchResult[];
  standings: CompetitionStandingRow[];
  championId: FranchiseId;
  xiConfigs: Record<FranchiseId, PlayingXIConfig>;
  ratings: Record<FranchiseId, TeamRatingBreakdown>;
}

/**
 * Computes a deterministic Playing XI composite match rating (0..100) from real player stats,
 * batting/bowling/fielding balance, captaincy, and legal XI compliance.
 */
function computeXICompetitionProfile(
  xi: PlayingXIConfig,
  rating: TeamRatingBreakdown
): {
  overallPower: number;
  battingPower: number;
  bowlingPower: number;
  balancePower: number;
  starPlayer: Player | null;
} {
  const starters = xi.starters;
  if (starters.length === 0) {
    return {
      overallPower: 30,
      battingPower: 30,
      bowlingPower: 30,
      balancePower: 30,
      starPlayer: null,
    };
  }

  const starterStrengths = starters.map((slot) => ({
    slot,
    secret: computeSecretPlayerStrength(slot.player),
  }));

  const avgStarterImpact =
    starterStrengths.reduce((sum, x) => sum + x.secret.winImpact, 0) / starters.length;
  const captainBonus = starters.find((s) => s.isCaptain)?.player.ratings.captaincy ?? 72;
  const impactSubBoost = xi.impactPlayer
    ? computeSecretPlayerStrength(xi.impactPlayer.player).winImpact * 0.06
    : 0;
  const penalty =
    (starters.length < 11 ? (11 - starters.length) * 5.5 : 0) +
    (!xi.isValid ? 4.5 : 0);

  const battingPower = Math.max(
    32,
    Math.min(99, rating.battingScore * 0.62 + avgStarterImpact * 0.38)
  );
  const bowlingPower = Math.max(
    32,
    Math.min(99, rating.bowlingScore * 0.62 + avgStarterImpact * 0.38)
  );
  const balancePower = Math.max(
    30,
    Math.min(99, rating.balanceScore * 0.5 + rating.allRoundScore * 0.3 + captainBonus * 0.2)
  );
  const overallPower = Math.max(
    25,
    Math.min(
      99.5,
      rating.winPercentage * 0.56 +
        avgStarterImpact * 0.3 +
        balancePower * 0.14 +
        impactSubBoost * 0.5 -
        penalty
    )
  );

  const star = [...starterStrengths].sort((a, b) => b.secret.winImpact - a.secret.winImpact)[0]
    ?.slot.player ?? null;

  return {
    overallPower: Math.round(overallPower * 10) / 10,
    battingPower: Math.round(battingPower * 10) / 10,
    bowlingPower: Math.round(bowlingPower * 10) / 10,
    balancePower: Math.round(balancePower * 10) / 10,
    starPlayer: star,
  };
}

/**
 * Generates standard Circle-Method Round-Robin schedule for 10 franchises:
 * 9 rounds, 5 matches per round = 45 total matches (every team faces all 9 rivals once).
 */
function buildRoundRobinSchedule(teams: FranchiseId[]): Array<{ round: number; pairs: [FranchiseId, FranchiseId][] }> {
  const list = [...teams];
  const n = list.length; // 10
  const rounds: Array<{ round: number; pairs: [FranchiseId, FranchiseId][] }> = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs: [FranchiseId, FranchiseId][] = [];
    for (let i = 0; i < n / 2; i++) {
      const t1 = list[i];
      const t2 = list[n - 1 - i];
      pairs.push(r % 2 === 0 ? [t1, t2] : [t2, t1]);
    }
    rounds.push({ round: r + 1, pairs });
    // Rotate all elements except index 0
    const last = list.pop()!;
    list.splice(1, 0, last);
  }
  return rounds;
}

/**
 * Deterministic Playing XI vs Playing XI Championship League Simulation.
 * Strictly based on each franchise's locked Playing XI ratings, batting vs bowling
 * matchups, balance, and career stats — zero random dice rolls.
 */
export function simulatePlayingXICompetition(
  state: AuctionState,
  playerMap: Record<string, Player>,
  userFranchiseId: FranchiseId,
  userXIIds: string[],
  weights: RatingWeights = DEFAULT_RATING_WEIGHTS
): PlayingXICompetitionSummary {
  const customXIs: Partial<Record<FranchiseId, string[]>> = {
    [userFranchiseId]: userXIIds,
  };

  const ratings = evaluateAllFranchises(state, playerMap, weights, customXIs);

  const xiConfigs = {} as Record<FranchiseId, PlayingXIConfig>;
  const profiles = {} as Record<
    FranchiseId,
    ReturnType<typeof computeXICompetitionProfile>
  >;

  for (const fid of ALL_FRANCHISE_IDS) {
    const xi = generateBestPlayingXI(
      state.teams[fid],
      state.ruleset,
      playerMap,
      'BALANCED',
      fid === userFranchiseId ? userXIIds : undefined
    );
    xiConfigs[fid] = xi;
    profiles[fid] = computeXICompetitionProfile(xi, ratings[fid]);
  }

  const schedule = buildRoundRobinSchedule(ALL_FRANCHISE_IDS);
  const matches: PlayingXIMatchResult[] = [];
  let matchCounter = 0;

  const table: Record<
    FranchiseId,
    { played: number; won: number; lost: number; points: number; nrrSum: number }
  > = {} as Record<
    FranchiseId,
    { played: number; won: number; lost: number; points: number; nrrSum: number }
  >;

  for (const fid of ALL_FRANCHISE_IDS) {
    table[fid] = { played: 0, won: 0, lost: 0, points: 0, nrrSum: 0 };
  }

  for (const roundObj of schedule) {
    for (const [homeId, awayId] of roundObj.pairs) {
      matchCounter++;
      const h = profiles[homeId];
      const a = profiles[awayId];

      // Matchup scoring strictly derived from Batting vs Opponent Bowling + Overall XI Strength
      const homeBatEdge = h.battingPower - a.bowlingPower;
      const awayBatEdge = a.battingPower - h.bowlingPower;
      const overallEdge = h.overallPower - a.overallPower;

      // Subtle deterministic venue/pitch style variation per round (0..2.2 runs) — never overrides a stronger XI
      const pitchShift = ((roundObj.round % 3) - 1) * 1.4;

      // Composite match performance index (deterministic)
      const homePerf = h.overallPower * 0.72 + h.battingPower * 0.16 + h.bowlingPower * 0.12 + homeBatEdge * 0.14;
      const awayPerf = a.overallPower * 0.72 + a.battingPower * 0.16 + a.bowlingPower * 0.12 + awayBatEdge * 0.14;

      const homeWins =
        Math.abs(homePerf - awayPerf) > 0.05
          ? homePerf > awayPerf
          : ratings[homeId].winPercentage >= ratings[awayId].winPercentage;

      const winnerId = homeWins ? homeId : awayId;
      const loserId = homeWins ? awayId : homeId;
      const diff = Math.abs(homePerf - awayPerf);

      // Realistic T20 scorelines calibrated to batting/bowling ratings
      const baseHomeRuns = Math.round(164 + (h.battingPower - 68) * 1.15 - (a.bowlingPower - 68) * 0.55 + pitchShift);
      const baseAwayRuns = Math.round(164 + (a.battingPower - 68) * 1.15 - (h.bowlingPower - 68) * 0.55 + pitchShift);

      let homeScore = Math.max(124, Math.min(238, baseHomeRuns));
      let awayScore = Math.max(122, Math.min(236, baseAwayRuns));

      const marginRuns = Math.max(3, Math.min(48, Math.round(4 + diff * 2.1)));
      if (homeWins) {
        if (homeScore <= awayScore) {
          homeScore = Math.min(242, awayScore + marginRuns);
        }
      } else {
        if (awayScore <= homeScore) {
          awayScore = Math.min(242, homeScore + marginRuns);
        }
      }

      const homeWickets = Math.max(2, Math.min(9, Math.round(5 + (a.bowlingPower - h.battingPower) * 0.08 + (homeWins ? -1 : 1))));
      const awayWickets = Math.max(2, Math.min(9, Math.round(5 + (h.bowlingPower - a.battingPower) * 0.08 + (homeWins ? 1 : -1))));

      const winByWickets = !homeWins;
      const wicketsLeft = Math.max(2, Math.min(8, 10 - awayWickets));
      const marginText = winByWickets
        ? `won by ${wicketsLeft} wickets`
        : `won by ${homeScore - awayScore} runs`;

      const homeScoreText = `${homeScore}/${homeWickets} (20.0)`;
      const awayScoreText = winByWickets
        ? `${awayScore}/${awayWickets} (${(18.2 + Math.min(1.5, Math.max(0.1, (10 - diff) * 0.14))).toFixed(1)})`
        : `${awayScore}/${awayWickets} (20.0)`;

      const nrrDeltaHome = Math.round(((homeScore - awayScore) / 20) * 100) / 100;

      // Pick deterministic Star of the Match from the winning Playing XI (rotating cleanly across top 3 stars by round)
      const winnerStarters = xiConfigs[winnerId].starters;
      const rankedWinnerPlayers = [...winnerStarters]
        .map((s) => ({ player: s.player, impact: computeSecretPlayerStrength(s.player).winImpact }))
        .sort((x, y) => y.impact - x.impact);
      const starPick =
        rankedWinnerPlayers[Math.min(rankedWinnerPlayers.length - 1, (roundObj.round - 1) % Math.min(3, Math.max(1, rankedWinnerPlayers.length)))]
          ?.player ?? profiles[winnerId].starPlayer;

      let playerOfMatchSummary = 'Match-winning impact';
      if (starPick) {
        if (starPick.primaryRole === 'Fast Bowler' || starPick.primaryRole === 'Spinner') {
          const wkts = diff > 6 ? 4 : 3;
          const runsConc = Math.max(16, Math.min(31, Math.round(28 - (starPick.ratings.bowling - 75) * 0.4)));
          playerOfMatchSummary = `${starPick.name} · ${wkts}/${runsConc} (4.0)`;
        } else {
          const runs = Math.max(46, Math.min(94, Math.round(54 + (starPick.ratings.batting - 75) * 1.35 + Math.min(12, overallEdge * 0.5))));
          const balls = Math.max(24, Math.round((runs / Math.max(125, starPick.stats.strikeRate || 140)) * 100));
          playerOfMatchSummary = `${starPick.name} · ${runs}* (${balls})`;
        }
      }

      table[homeId].played += 1;
      table[awayId].played += 1;
      table[homeId].nrrSum += nrrDeltaHome;
      table[awayId].nrrSum -= nrrDeltaHome;
      if (homeWins) {
        table[homeId].won += 1;
        table[homeId].points += 2;
        table[awayId].lost += 1;
      } else {
        table[awayId].won += 1;
        table[awayId].points += 2;
        table[homeId].lost += 1;
      }

      matches.push({
        matchNumber: matchCounter,
        roundNumber: roundObj.round,
        homeId,
        awayId,
        homeStrength: h.overallPower,
        awayStrength: a.overallPower,
        homeScore,
        homeWickets,
        awayScore,
        awayWickets,
        homeScoreText,
        awayScoreText,
        winnerId,
        loserId,
        marginText,
        nrrDeltaHome,
        playerOfMatch: starPick,
        playerOfMatchSummary,
        isUserMatch: homeId === userFranchiseId || awayId === userFranchiseId,
      });
    }
  }

  const standings: CompetitionStandingRow[] = ALL_FRANCHISE_IDS.map((fid) => {
    const t = table[fid];
    return {
      rank: 1,
      franchiseId: fid,
      played: t.played,
      won: t.won,
      lost: t.lost,
      points: t.points,
      nrr: Math.round((t.nrrSum / Math.max(1, t.played)) * 1000) / 1000,
      xiStrength: profiles[fid].overallPower,
      rating: ratings[fid],
      xiConfig: xiConfigs[fid],
    };
  })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (Math.abs(b.nrr - a.nrr) > 0.001) return b.nrr - a.nrr;
      return b.xiStrength - a.xiStrength;
    })
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  return {
    matches,
    userMatches: matches.filter((m) => m.isUserMatch),
    standings,
    championId: standings[0].franchiseId,
    xiConfigs,
    ratings,
  };
}
