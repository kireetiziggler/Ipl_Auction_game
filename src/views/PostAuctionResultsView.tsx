import React, { useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import {
  Trophy,
  BarChart3,
  Users,
  PlayCircle,
  PauseCircle,
  Scale,
  RotateCcw,
  Share2,
  Check,
  AlertTriangle,
  CheckCircle2,
  Award,
  FastForward,
  Swords,
  Sparkles,
  Trash2,
  ChevronRight,
  Shield,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { COUNTRY_FLAGS } from '../data/players';
import { formatCr, MIN_MATCH_SQUAD_SIZE } from '../data/rulesets';
import { computeCardAttributes } from '../engine/cardAttributes';
import { generateBestPlayingXI } from '../engine/playingXI';
import { simulatePlayingXICompetition } from '../engine/playingXICompetition';
import { buildStrategyComparison } from '../engine/ratingEngine';
import {
  AuctionState,
  FranchiseId,
  GameSettings,
  Player,
  PlayingXIPreset,
} from '../engine/types';
import { audioService } from '../services/audioService';
import { FranchiseBadge } from '../components/FranchiseBadge';
import { PlayerAvatar } from '../components/PlayerAvatar';

const TROPHY_IMG = '/src/assets/images/championship_trophy_stage_1795354543939.jpg';

type PostAuctionStage = 'PICK_XI' | 'COMPETE' | 'LEADERBOARD';
type RoleFilter = 'ALL' | 'BAT' | 'WK' | 'AR' | 'BOWL';

interface PostAuctionResultsViewProps {
  state: AuctionState;
  playerMap: Record<string, Player>;
  userFranchiseId: FranchiseId;
  settings: GameSettings;
  initialCompeted?: boolean;
  initialUserXIIds?: string[];
  onAutoFillMinSquad?: () => void;
  onConfirmPlayingXI?: (starterIds: string[]) => void;
  onRematch: () => void;
  onBackHome: () => void;
  onInspectPlayer: (player: Player) => void;
}

export const PostAuctionResultsView: React.FC<PostAuctionResultsViewProps> = ({
  state,
  playerMap,
  userFranchiseId,
  settings,
  initialCompeted = false,
  initialUserXIIds,
  onAutoFillMinSquad,
  onConfirmPlayingXI,
  onRematch,
  onBackHome,
  onInspectPlayer,
}) => {
  const userTeam = state.teams[userFranchiseId];

  const userSquadPlayers = useMemo(() => {
    return userTeam.squad
      .map((sp) => ({ player: playerMap[sp.playerId], sp }))
      .filter(
        (x): x is { player: Player; sp: (typeof userTeam.squad)[number] } => Boolean(x.player)
      )
      .sort((a, b) => b.player.ratings.overall - a.player.ratings.overall);
  }, [userTeam.squad, playerMap]);

  const requiredCount = Math.min(11, userSquadPlayers.length);

  // Stage flow: PICK_XI -> COMPETE (9-round XI vs XI League) -> LEADERBOARD (Champion & Celebration)
  const [stage, setStage] = useState<PostAuctionStage>(initialCompeted ? 'LEADERBOARD' : 'PICK_XI');

  // Start fresh after an auction so the user actively selects their Playing XI (or taps Auto-Pick Best XI)
  const [userXIIds, setUserXIIds] = useState<string[]>(() => {
    if (initialUserXIIds && initialUserXIIds.length > 0) return initialUserXIIds;
    if (initialCompeted) {
      return generateBestPlayingXI(userTeam, state.ruleset, playerMap, 'BALANCED').starters.map(
        (s) => s.player.id
      );
    }
    return [];
  });
  const [xiPreset, setXiPreset] = useState<PlayingXIPreset | null>(null);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');

  // Stage 2: Playing XI Competition round-by-round playback (1..9)
  const [completedRounds, setCompletedRounds] = useState<number>(initialCompeted ? 9 : 0);
  const [competitionRunning, setCompetitionRunning] = useState<boolean>(false);

  // Stage 3: Leaderboard tabs & inspection
  const [activeTab, setActiveTab] = useState<
    'ceremony' | 'matches' | 'xi' | 'analytics' | 'replay' | 'strategy'
  >('ceremony');
  const [selectedFranchise, setSelectedFranchise] = useState<FranchiseId>(userFranchiseId);
  const [matchTeamFilter, setMatchTeamFilter] = useState<'USER' | 'ALL' | FranchiseId>('USER');
  const [copiedShare, setCopiedShare] = useState(false);

  // Replay state
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(2);
  const [replayTeamFilter, setReplayTeamFilter] = useState<string>('ALL');

  // Live validation of the user's selected Playing XI
  const userPlayingXIConfig = useMemo(
    () =>
      generateBestPlayingXI(
        userTeam,
        state.ruleset,
        playerMap,
        xiPreset ?? 'BALANCED',
        userXIIds.length > 0 ? userXIIds : ['__empty__']
      ),
    [userTeam, state.ruleset, playerMap, xiPreset, userXIIds]
  );

  // Deterministic 10-Team Playing XI League Competition
  const competition = useMemo(
    () =>
      simulatePlayingXICompetition(
        state,
        playerMap,
        userFranchiseId,
        userXIIds.length === requiredCount ? userXIIds : [],
        settings.ratingWeights
      ),
    [state, playerMap, userFranchiseId, userXIIds, requiredCount, settings.ratingWeights]
  );

  const standings = competition.standings;
  const championRow = standings[0];
  const userStanding =
    standings.find((row) => row.franchiseId === userFranchiseId) ?? standings[0];
  const ratings = competition.ratings;
  const inspectedRating = ratings[selectedFranchise];
  const inspectedXI = competition.xiConfigs[selectedFranchise];

  const strategyReport = useMemo(
    () => buildStrategyComparison(state, selectedFranchise, playerMap),
    [state, selectedFranchise, playerMap]
  );

  // Auto-advance Playing XI League Rounds 1..9 during Stage 2
  useEffect(() => {
    if (stage !== 'COMPETE' || !competitionRunning) return;
    if (completedRounds >= 9) {
      setCompetitionRunning(false);
      return;
    }
    const delay = completedRounds === 0 ? 550 : 850;
    const t = window.setTimeout(() => {
      setCompletedRounds((r) => Math.min(9, r + 1));
    }, delay);
    return () => window.clearTimeout(t);
  }, [stage, competitionRunning, completedRounds]);

  // Celebration confetti burst ONLY when Championship Leaderboard (Stage 3) unlocks
  useEffect(() => {
    if (stage !== 'LEADERBOARD') return;
    const prefersReduced =
      settings.reducedMotion ||
      (typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (prefersReduced) return;

    const fire = () => {
      try {
        confetti({
          particleCount: 75,
          spread: 78,
          origin: { y: 0.32, x: 0.24 },
          colors: ['#F59E0B', '#FDE68A', '#38BDF8', '#10B981', '#FFFFFF'],
        });
        confetti({
          particleCount: 75,
          spread: 78,
          origin: { y: 0.32, x: 0.76 },
          colors: ['#F59E0B', '#FDE68A', '#38BDF8', '#10B981', '#FFFFFF'],
        });
      } catch {
        // Ignore headless canvas errors
      }
    };
    fire();
    const secondBurst = window.setTimeout(fire, 650);
    return () => window.clearTimeout(secondBurst);
  }, [stage, settings.reducedMotion]);

  const togglePlayerInUserXI = (player: Player) => {
    setXiPreset(null);
    if (userXIIds.includes(player.id)) {
      setUserXIIds((prev) => prev.filter((id) => id !== player.id));
      return;
    }
    if (userXIIds.length >= requiredCount) return;
    const currentOS = userXIIds.filter((id) => playerMap[id]?.isOverseas).length;
    if (player.isOverseas && currentOS >= state.ruleset.maxOverseasPlayingXI) return;
    setUserXIIds((prev) => [...prev, player.id]);
  };

  const applyPresetToUserXI = (preset: PlayingXIPreset) => {
    setXiPreset(preset);
    const auto = generateBestPlayingXI(userTeam, state.ruleset, playerMap, preset);
    setUserXIIds(auto.starters.map((s) => s.player.id));
  };

  const handleStartCompetition = () => {
    setCompletedRounds(0);
    setCompetitionRunning(true);
    setStage('COMPETE');
  };

  const handleRevealLeaderboard = () => {
    audioService.playVictoryFanfare();
    setStage('LEADERBOARD');
    setActiveTab('ceremony');
    onConfirmPlayingXI?.(userXIIds);
  };

  // Live partial table during Stage 2 rounds 1..9
  const liveStage2Standings = useMemo(() => {
    const visibleMatches = competition.matches.filter((m) => m.roundNumber <= completedRounds);
    const map: Record<
      FranchiseId,
      { played: number; won: number; lost: number; points: number; nrrSum: number }
    > = {} as Record<
      FranchiseId,
      { played: number; won: number; lost: number; points: number; nrrSum: number }
    >;
    for (const fid of ALL_FRANCHISE_IDS) {
      map[fid] = { played: 0, won: 0, lost: 0, points: 0, nrrSum: 0 };
    }
    for (const m of visibleMatches) {
      map[m.homeId].played += 1;
      map[m.awayId].played += 1;
      map[m.homeId].nrrSum += m.nrrDeltaHome;
      map[m.awayId].nrrSum -= m.nrrDeltaHome;
      if (m.winnerId === m.homeId) {
        map[m.homeId].won += 1;
        map[m.homeId].points += 2;
        map[m.awayId].lost += 1;
      } else {
        map[m.awayId].won += 1;
        map[m.awayId].points += 2;
        map[m.homeId].lost += 1;
      }
    }
    return ALL_FRANCHISE_IDS.map((fid) => {
      const row = map[fid];
      const finalRow = standings.find((s) => s.franchiseId === fid)!;
      return {
        franchiseId: fid,
        played: row.played,
        won: row.won,
        lost: row.lost,
        points: row.points,
        nrr: row.played > 0 ? Math.round((row.nrrSum / row.played) * 100) / 100 : 0,
        xiStrength: finalRow.xiStrength,
      };
    }).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (Math.abs(b.nrr - a.nrr) > 0.001) return b.nrr - a.nrr;
      return b.xiStrength - a.xiStrength;
    });
  }, [competition.matches, completedRounds, standings]);

  // Filtered replay events
  const replayEvents = useMemo(() => {
    return state.events.filter((e) => {
      if (replayTeamFilter === 'ALL') return true;
      return e.franchiseId === replayTeamFilter;
    });
  }, [state.events, replayTeamFilter]);

  useEffect(() => {
    if (!replayPlaying) return;
    if (replayIndex >= replayEvents.length - 1) {
      setReplayPlaying(false);
      return;
    }
    const ms = Math.round(900 / replaySpeed);
    const t = window.setTimeout(() => {
      setReplayIndex((i) => Math.min(replayEvents.length - 1, i + 1));
    }, ms);
    return () => window.clearTimeout(t);
  }, [replayPlaying, replayIndex, replaySpeed, replayEvents.length]);

  const radarData = useMemo(() => {
    const avg = (key: keyof typeof inspectedRating) => {
      const vals = ALL_FRANCHISE_IDS.map((fid) => Number(ratings[fid][key]) || 0);
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    };
    return [
      { metric: 'Batting', team: inspectedRating.battingScore, league: avg('battingScore') },
      { metric: 'Bowling', team: inspectedRating.bowlingScore, league: avg('bowlingScore') },
      { metric: 'All-Round', team: inspectedRating.allRoundScore, league: avg('allRoundScore') },
      { metric: 'Balance', team: inspectedRating.balanceScore, league: avg('balanceScore') },
      { metric: 'Overseas', team: inspectedRating.overseasScore, league: avg('overseasScore') },
      { metric: 'Depth', team: inspectedRating.depthScore, league: avg('depthScore') },
      {
        metric: 'Value',
        team: inspectedRating.budgetEfficiencyScore,
        league: avg('budgetEfficiencyScore'),
      },
    ];
  }, [inspectedRating, ratings]);

  const roleSpendChartData = useMemo(() => {
    return Object.keys(strategyReport.userSpendByRole).map((role) => ({
      role,
      selected: strategyReport.userSpendByRole[role],
      leagueAvg: strategyReport.leagueAvgSpendByRole[role],
    }));
  }, [strategyReport]);

  const handleShareResult = async () => {
    const summary = `IPL 2027 Auction Arena Championship\nMy Team: ${FRANCHISE_MAP[userFranchiseId].name} (Rank #${userStanding.rank}/10 · ${userStanding.won}W-${userStanding.lost}L · ${userStanding.points} Pts · XI Strength ${userStanding.xiStrength.toFixed(1)})\nChampion: ${FRANCHISE_MAP[championRow.franchiseId].name} (${championRow.won}W-${championRow.lost}L · ${championRow.points} Pts)`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'IPL Auction Arena Championship', text: summary });
      } else {
        await navigator.clipboard.writeText(summary);
        setCopiedShare(true);
        window.setTimeout(() => setCopiedShare(false), 2200);
      }
    } catch {
      // Ignore
    }
  };

  // ==================== STAGE 1: PICK YOUR PLAYING XI ====================
  if (stage === 'PICK_XI') {
    const currentOS = userXIIds.filter((id) => playerMap[id]?.isOverseas).length;
    const wkSelected = userXIIds.filter((id) => playerMap[id]?.primaryRole === 'Wicketkeeper').length;
    const avgSelectedOvr =
      userXIIds.length > 0
        ? Math.round(
            userXIIds.reduce((sum, id) => sum + (playerMap[id]?.ratings.overall ?? 72), 0) /
              userXIIds.length
          )
        : 0;
    const meetsMinSquad = userSquadPlayers.length >= MIN_MATCH_SQUAD_SIZE;
    const missingForMinSquad = Math.max(0, MIN_MATCH_SQUAD_SIZE - userSquadPlayers.length);
    const canCompete =
      meetsMinSquad &&
      userXIIds.length === requiredCount &&
      requiredCount === 11 &&
      currentOS <= state.ruleset.maxOverseasPlayingXI;

    const filteredSquad = userSquadPlayers.filter(({ player }) => {
      if (roleFilter === 'ALL') return true;
      if (roleFilter === 'BAT') return player.primaryRole === 'Batter';
      if (roleFilter === 'WK') return player.primaryRole === 'Wicketkeeper';
      if (roleFilter === 'AR') return player.primaryRole === 'All-rounder';
      return player.primaryRole === 'Fast Bowler' || player.primaryRole === 'Spinner';
    });

    return (
      <div className="space-y-5 pb-16">
        {/* Stage Progress Stepper */}
        <div className="flex items-center justify-center gap-2 sm:gap-3 text-[11px] sm:text-xs font-bold">
          <span className="inline-flex items-center gap-1.5 text-amber-400">
            <span className="w-5 h-5 rounded-full bg-amber-500 text-slate-950 flex items-center justify-center font-mono-num">
              1
            </span>
            Pick Playing XI
          </span>
          <ChevronRight className="w-4 h-4 text-slate-500" />
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center font-mono-num">
              2
            </span>
            Compete vs 9 Rival XIs
          </span>
          <ChevronRight className="w-4 h-4 text-slate-500" />
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center font-mono-num">
              3
            </span>
            Leaderboard & Champion
          </span>
        </div>

        {/* STRICT MINIMUM 14-PLAYER SQUAD ENFORCEMENT BANNER */}
        {!meetsMinSquad && (
          <div className="rounded-2xl border border-rose-500/45 bg-rose-500/12 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-extrabold text-rose-300">
                  Minimum {MIN_MATCH_SQUAD_SIZE} Players Required — Match Cannot Proceed Yet
                </div>
                <p className="text-xs text-slate-300 mt-0.5">
                  Your {FRANCHISE_MAP[userFranchiseId].shortName} squad currently has{' '}
                  <strong className="text-white font-mono-num">
                    {userSquadPlayers.length}/{MIN_MATCH_SQUAD_SIZE}
                  </strong>{' '}
                  players. Every franchise must have at least {MIN_MATCH_SQUAD_SIZE} players before entering the Playing XI Championship.
                </p>
              </div>
            </div>
            {onAutoFillMinSquad && (
              <button
                type="button"
                onClick={onAutoFillMinSquad}
                className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs whitespace-nowrap shrink-0 transition shadow-lg shadow-amber-500/20"
              >
                Auto-Draft {missingForMinSquad} Unsold Player{missingForMinSquad === 1 ? '' : 's'} (Base Price)
              </button>
            )}
          </div>
        )}

        {/* Selection Hero Header */}
        <section className="relative overflow-hidden rounded-3xl border border-amber-500/30 bg-gradient-to-br from-[#0F1A33] via-[#0B1222] to-[#070B14] p-5 sm:p-7 text-white shadow-2xl">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div className="flex items-start gap-4">
              <FranchiseBadge franchiseId={userFranchiseId} size="lg" />
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-extrabold tracking-widest uppercase text-amber-400">
                  <Sparkles className="w-3.5 h-3.5" />
                  STEP 1 OF 3 · AUCTION COMPLETE
                </div>
                <h1 className="font-display text-3xl sm:text-5xl font-extrabold mt-1">
                  Pick Your {FRANCHISE_MAP[userFranchiseId].shortName} Playing XI
                </h1>
                <p className="text-sm text-slate-300 mt-1 max-w-2xl">
                  Select {requiredCount} starters from your {userSquadPlayers.length}-player squad
                  (minimum {MIN_MATCH_SQUAD_SIZE} squad players required, max{' '}
                  {state.ruleset.maxOverseasPlayingXI} overseas in XI). Next, your Playing XI will
                  face all 9 rival franchises head-to-head before the Championship Leaderboard is
                  revealed!
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={!canCompete}
              onClick={handleStartCompetition}
              className="px-6 py-4 rounded-2xl bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 disabled:opacity-40 text-slate-950 font-display font-extrabold text-base sm:text-lg shadow-xl shadow-amber-500/25 inline-flex items-center justify-center gap-2.5 transition whitespace-nowrap shrink-0"
            >
              <Swords className="w-5 h-5" />
              {!meetsMinSquad
                ? `Need ${missingForMinSquad} More in Squad (Min ${MIN_MATCH_SQUAD_SIZE})`
                : canCompete
                ? 'Lock Playing XI & Compete'
                : `Select ${requiredCount - userXIIds.length} More Player${
                    requiredCount - userXIIds.length === 1 ? '' : 's'
                  }`}
            </button>
          </div>

          {/* Readiness Readout & Tactical Auto-Fill Helpers */}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-5 pt-4 border-t border-white/10">
            <div className="flex flex-wrap items-center gap-4 text-xs font-mono-num">
              <span>
                Playing XI:{' '}
                <strong
                  className={
                    userXIIds.length === requiredCount ? 'text-emerald-400' : 'text-amber-400'
                  }
                >
                  {userXIIds.length}/{requiredCount}
                </strong>
              </span>
              <span>
                Overseas:{' '}
                <strong
                  className={
                    currentOS <= state.ruleset.maxOverseasPlayingXI
                      ? 'text-sky-400'
                      : 'text-rose-400'
                  }
                >
                  {currentOS}/{state.ruleset.maxOverseasPlayingXI}
                </strong>
              </span>
              <span>
                Wicketkeepers:{' '}
                <strong className={wkSelected >= 1 ? 'text-emerald-400' : 'text-amber-300'}>
                  {wkSelected}
                </strong>
              </span>
              <span>
                Bowling Options:{' '}
                <strong className="text-white">{userPlayingXIConfig.bowlingOptionsCount}</strong>
              </span>
              {avgSelectedOvr > 0 && (
                <span>
                  Avg Card OVR:{' '}
                  <strong className="text-amber-400">{avgSelectedOvr}</strong>
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-400 mr-1">Auto-Pick:</span>
              {(
                [
                  { id: 'BALANCED', label: 'Best XI' },
                  { id: 'BATTING_HEAVY', label: 'Batting' },
                  { id: 'BOWLING_HEAVY', label: 'Bowling' },
                  { id: 'SPIN_FOCUSED', label: 'Spin' },
                  { id: 'PACE_FOCUSED', label: 'Pace' },
                ] as { id: PlayingXIPreset; label: string }[]
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPresetToUserXI(p.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    xiPreset === p.id
                      ? 'bg-amber-500 text-slate-950'
                      : 'bg-white/10 hover:bg-white/15 text-slate-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              {userXIIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setXiPreset(null);
                    setUserXIIds([]);
                  }}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 inline-flex items-center gap-1 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Role Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {(
              [
                { id: 'ALL', label: `All Squad (${userSquadPlayers.length})` },
                { id: 'BAT', label: 'Batters' },
                { id: 'WK', label: 'Keepers' },
                { id: 'AR', label: 'All-rounders' },
                { id: 'BOWL', label: 'Bowlers' },
              ] as { id: RoleFilter; label: string }[]
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setRoleFilter(f.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition border ${
                  roleFilter === f.id
                    ? 'bg-amber-500 text-slate-950 border-amber-400'
                    : 'bg-white dark:bg-[#0F172A] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-slate-400'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {userXIIds.length === requiredCount && wkSelected === 0 && (
            <div className="text-xs text-amber-500 font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              Tip: Including at least 1 Wicketkeeper boosts your Playing XI Balance rating!
            </div>
          )}
        </div>

        {/* Interactive Gold / Silver / Bronze Card Grid for Picking Playing XI */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
          {filteredSquad.map(({ player, sp }) => {
            const isSelected = userXIIds.includes(player.id);
            const osBlocked =
              !isSelected && player.isOverseas && currentOS >= state.ruleset.maxOverseasPlayingXI;
            const fullBlocked = !isSelected && userXIIds.length >= requiredCount;
            const disabled = osBlocked || fullBlocked;
            const attrs = computeCardAttributes(player);

            return (
              <div
                key={player.id}
                onClick={() => !disabled && togglePlayerInUserXI(player)}
                className={`relative rounded-2xl p-3 border transition-all flex flex-col items-center text-center gap-2 ${
                  isSelected
                    ? 'bg-amber-500/12 border-amber-400 shadow-lg shadow-amber-500/15 ring-1 ring-amber-400/50 cursor-pointer'
                    : disabled
                    ? 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 opacity-50 cursor-not-allowed'
                    : 'bg-white dark:bg-[#0F172A] border-slate-200 dark:border-slate-800 hover:border-amber-400/60 cursor-pointer'
                }`}
              >
                {/* Selection Check Badge */}
                <div className="w-full flex items-center justify-between text-[10px] font-bold">
                  <span
                    className={`uppercase tracking-wider ${
                      attrs.tier === 'GOLD'
                        ? 'text-amber-400'
                        : attrs.tier === 'SILVER'
                        ? 'text-slate-400'
                        : 'text-orange-400'
                    }`}
                  >
                    {attrs.tier}
                  </span>
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center ${
                      isSelected
                        ? 'bg-amber-500 text-slate-950'
                        : 'border border-slate-300 dark:border-slate-600 text-transparent'
                    }`}
                  >
                    <Check className="w-3 h-3 stroke-[3]" />
                  </div>
                </div>

                {/* Full Gold / Silver / Bronze Shield Cricket Card */}
                <PlayerAvatar player={player} size="lg" />

                <div className="w-full space-y-0.5 pt-0.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onInspectPlayer(player);
                    }}
                    className="text-xs font-bold text-slate-900 dark:text-white hover:text-amber-400 truncate block w-full"
                  >
                    {player.secondaryRole}
                  </button>
                  <div className="flex items-center justify-between text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                    <span>{player.isOverseas ? '✈ OS' : 'IND'}</span>
                    <span className="text-amber-500 font-bold">{formatCr(sp.boughtPriceCr)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ==================== STAGE 2: PLAYING XI vs PLAYING XI COMPETITION ====================
  if (stage === 'COMPETE') {
    const allDone = completedRounds >= 9;
    const latestUserMatch =
      competition.userMatches.find((m) => m.roundNumber === Math.max(1, completedRounds)) ??
      competition.userMatches[0];
    const completedUserMatches = competition.userMatches.filter(
      (m) => m.roundNumber <= completedRounds
    );
    const userWinsSoFar = completedUserMatches.filter((m) => m.winnerId === userFranchiseId).length;
    const userLossesSoFar = completedUserMatches.length - userWinsSoFar;

    return (
      <div className="space-y-5 pb-16">
        {/* Stage Progress Stepper */}
        <div className="flex items-center justify-center gap-2 sm:gap-3 text-[11px] sm:text-xs font-bold">
          <span className="inline-flex items-center gap-1.5 text-emerald-400">
            <span className="w-5 h-5 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center">
              <Check className="w-3 h-3 stroke-[3]" />
            </span>
            Playing XI Locked
          </span>
          <ChevronRight className="w-4 h-4 text-slate-500" />
          <span className="inline-flex items-center gap-1.5 text-amber-400">
            <span className="w-5 h-5 rounded-full bg-amber-500 text-slate-950 flex items-center justify-center font-mono-num">
              2
            </span>
            XI vs XI League ({completedRounds}/9)
          </span>
          <ChevronRight className="w-4 h-4 text-slate-500" />
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center font-mono-num">
              3
            </span>
            Leaderboard & Champion
          </span>
        </div>

        {/* Live Match Center Header */}
        <section className="rounded-3xl border border-amber-500/35 bg-gradient-to-br from-[#0F1A33] via-[#0B1222] to-[#060A14] p-5 sm:p-7 text-white shadow-2xl space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-extrabold tracking-widest uppercase text-amber-400">
                <Swords className="w-4 h-4" />
                {allDone
                  ? 'ALL 9 PLAYING XI ROUNDS COMPLETED'
                  : `PLAYING XI CHAMPIONSHIP · ROUND ${Math.min(9, completedRounds + 1)} OF 9`}
              </div>
              <h1 className="font-display text-3xl sm:text-4xl font-extrabold mt-1">
                {FRANCHISE_MAP[userFranchiseId].name} vs Rival Playing XIs
              </h1>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                Every franchise&apos;s locked Playing XI is competing in a 9-round deterministic
                league driven by player ratings, batting/bowling matchups, and squad balance.
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {!allDone ? (
                <button
                  type="button"
                  onClick={() => {
                    setCompetitionRunning(false);
                    setCompletedRounds(9);
                  }}
                  className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-bold text-white inline-flex items-center gap-1.5 transition"
                >
                  <FastForward className="w-4 h-4 text-amber-400" />
                  Finish Remaining Rounds
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleRevealLeaderboard}
                  className="px-6 py-3.5 rounded-2xl bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-slate-950 font-display font-extrabold text-base shadow-xl shadow-amber-500/30 inline-flex items-center gap-2 transition"
                >
                  <Trophy className="w-5 h-5" />
                  Reveal Leaderboard & Crown Champion
                </button>
              )}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-mono-num">
              <span className="text-slate-300">
                Your Record:{' '}
                <strong className="text-emerald-400">{userWinsSoFar}W</strong> -{' '}
                <strong className="text-rose-400">{userLossesSoFar}L</strong>
              </span>
              <span className="text-amber-400 font-bold">
                {completedRounds * 5} / 45 League Matches Played
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-500 via-amber-400 to-emerald-400 transition-all duration-500"
                style={{ width: `${(completedRounds / 9) * 100}%` }}
              />
            </div>
          </div>

          {/* Featured Live Matchup Card */}
          {completedRounds > 0 && latestUserMatch && (
            <div className="rounded-2xl bg-slate-950/75 border border-slate-800 p-4 sm:p-5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-3 flex items-center justify-between">
                <span>
                  ROUND {latestUserMatch.roundNumber} · FEATURED PLAYING XI CLASH
                </span>
                <span
                  className={
                    latestUserMatch.winnerId === userFranchiseId
                      ? 'text-emerald-400'
                      : 'text-rose-400'
                  }
                >
                  {latestUserMatch.winnerId === userFranchiseId ? 'VICTORY' : 'DEFEAT'}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                {/* Home XI */}
                <div className="md:col-span-4 flex items-center gap-3">
                  <FranchiseBadge franchiseId={latestUserMatch.homeId} size="md" />
                  <div>
                    <div className="font-display text-lg font-extrabold text-white">
                      {FRANCHISE_MAP[latestUserMatch.homeId].name}
                    </div>
                    <div className="font-mono-num text-base font-extrabold text-amber-400">
                      {latestUserMatch.homeScoreText}
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono-num">
                      XI Strength {latestUserMatch.homeStrength.toFixed(1)}
                    </div>
                  </div>
                </div>

                {/* Result Center */}
                <div className="md:col-span-4 text-center space-y-1">
                  <div className="text-xs font-extrabold text-white uppercase tracking-wider">
                    {FRANCHISE_MAP[latestUserMatch.winnerId].shortName} {latestUserMatch.marginText}
                  </div>
                  {latestUserMatch.playerOfMatch && (
                    <div className="inline-flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-1.5 mt-1">
                      <PlayerAvatar player={latestUserMatch.playerOfMatch} size="sm" />
                      <div className="text-left">
                        <div className="text-[10px] uppercase tracking-wider text-amber-400 font-bold">
                          Star of the Match
                        </div>
                        <div className="text-xs font-semibold text-white">
                          {latestUserMatch.playerOfMatchSummary}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Away XI */}
                <div className="md:col-span-4 flex items-center md:justify-end gap-3">
                  <div className="md:text-right">
                    <div className="font-display text-lg font-extrabold text-white">
                      {FRANCHISE_MAP[latestUserMatch.awayId].name}
                    </div>
                    <div className="font-mono-num text-base font-extrabold text-sky-400">
                      {latestUserMatch.awayScoreText}
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono-num">
                      XI Strength {latestUserMatch.awayStrength.toFixed(1)}
                    </div>
                  </div>
                  <FranchiseBadge franchiseId={latestUserMatch.awayId} size="md" />
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Bottom 2-Column Live Grid: Your 9 Matches + Live Standings Preview */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Your 9 Head-to-Head Playing XI Clashes */}
          <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-3">
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Your Playing XI Match Results ({completedUserMatches.length}/9)
            </h2>
            <div className="space-y-2">
              {competition.userMatches.map((m) => {
                const played = m.roundNumber <= completedRounds;
                const oppId = m.homeId === userFranchiseId ? m.awayId : m.homeId;
                const userWon = m.winnerId === userFranchiseId;
                const userScore = m.homeId === userFranchiseId ? m.homeScoreText : m.awayScoreText;
                const oppScore = m.homeId === userFranchiseId ? m.awayScoreText : m.homeScoreText;

                return (
                  <div
                    key={m.matchNumber}
                    className={`rounded-xl px-3.5 py-2.5 border flex items-center justify-between gap-3 transition-all ${
                      !played
                        ? 'bg-slate-50 dark:bg-slate-900/35 border-slate-200 dark:border-slate-800 opacity-50'
                        : userWon
                        ? 'bg-emerald-500/8 border-emerald-500/30'
                        : 'bg-rose-500/8 border-rose-500/30'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="font-mono-num text-[11px] font-bold text-slate-400 w-7 shrink-0">
                        R{m.roundNumber}
                      </span>
                      <FranchiseBadge franchiseId={oppId} size="xs" />
                      <div className="min-w-0">
                        <div className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white truncate">
                          vs {FRANCHISE_MAP[oppId].name}
                        </div>
                        {played ? (
                          <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 truncate">
                            {FRANCHISE_MAP[userFranchiseId].shortName} {userScore} ·{' '}
                            {FRANCHISE_MAP[oppId].shortName} {oppScore}
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-500">Scheduled</div>
                        )}
                      </div>
                    </div>

                    {played ? (
                      <div className="text-right shrink-0">
                        <div
                          className={`text-xs font-extrabold ${
                            userWon ? 'text-emerald-500' : 'text-rose-400'
                          }`}
                        >
                          {userWon ? 'WIN' : 'LOSS'}
                        </div>
                        <div className="text-[10px] text-slate-500">{m.marginText}</div>
                      </div>
                    ) : (
                      <span className="text-[11px] font-mono-num text-slate-400">Pending</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Live Points Race */}
          <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-3">
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Live Points Race
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2 pr-2">#</th>
                    <th className="py-2 pr-2">Team</th>
                    <th className="py-2 px-1.5 text-right">P</th>
                    <th className="py-2 px-1.5 text-right">W</th>
                    <th className="py-2 px-1.5 text-right">L</th>
                    <th className="py-2 pl-2 text-right">Pts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {liveStage2Standings.map((row, idx) => (
                    <tr
                      key={row.franchiseId}
                      className={row.franchiseId === userFranchiseId ? 'bg-amber-500/10' : ''}
                    >
                      <td className="py-2 pr-2 font-mono-num font-bold text-slate-400">
                        {idx + 1}
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-2">
                          <FranchiseBadge franchiseId={row.franchiseId} size="xs" />
                          <span className="font-bold text-slate-900 dark:text-white">
                            {FRANCHISE_MAP[row.franchiseId].shortName}
                            {row.franchiseId === userFranchiseId ? ' (You)' : ''}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 px-1.5 text-right font-mono-num text-slate-500">
                        {row.played}
                      </td>
                      <td className="py-2 px-1.5 text-right font-mono-num text-emerald-500 font-bold">
                        {row.won}
                      </td>
                      <td className="py-2 px-1.5 text-right font-mono-num text-rose-400">
                        {row.lost}
                      </td>
                      <td className="py-2 pl-2 text-right font-mono-num font-extrabold text-amber-500">
                        {row.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {allDone && (
              <button
                type="button"
                onClick={handleRevealLeaderboard}
                className="w-full mt-3 py-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-extrabold text-base inline-flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 transition"
              >
                <Trophy className="w-5 h-5" />
                Open Official Leaderboard & Celebrate
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==================== STAGE 3: OFFICIAL CHAMPIONSHIP LEADERBOARD & CELEBRATION ====================
  const userWonChampionship = championRow.franchiseId === userFranchiseId;
  const championTeam = state.teams[championRow.franchiseId];
  const filteredMatches = competition.matches.filter((m) => {
    if (matchTeamFilter === 'ALL') return true;
    if (matchTeamFilter === 'USER') return m.isUserMatch;
    return m.homeId === matchTeamFilter || m.awayId === matchTeamFilter;
  });

  return (
    <div className="space-y-6 pb-16">
      {/* CHAMPIONSHIP TROPHY & WINNER CELEBRATION HERO */}
      <section className="relative overflow-hidden rounded-3xl border border-amber-500/35 bg-[#060A14] text-white shadow-2xl">
        <img
          src={TROPHY_IMG}
          alt="IPL Auction Arena Championship Trophy"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-50"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#060A14]/95 via-[#060A14]/82 to-[#060A14]/45" />

        <div className="relative z-10 p-6 sm:p-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center gap-5">
            <FranchiseBadge franchiseId={championRow.franchiseId} size="xl" />
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-extrabold tracking-widest uppercase text-amber-400">
                <Trophy className="w-4 h-4" />
                {userWonChampionship
                  ? 'CONGRATULATIONS! YOU ARE THE IPL 2027 CHAMPION!'
                  : `IPL 2027 PLAYING XI CHAMPION · ${state.ruleset.name}`}
              </div>
              <h1 className="font-display text-4xl sm:text-6xl font-extrabold tracking-tight mt-1 bg-gradient-to-r from-white via-amber-200 to-amber-400 bg-clip-text text-transparent">
                {FRANCHISE_MAP[championRow.franchiseId].name}
              </h1>
              <div className="text-sm text-slate-200 mt-1.5">
                Owner: <strong className="text-white">{championTeam.ownerName}</strong> · League
                Record{' '}
                <span className="font-mono-num font-extrabold text-emerald-400">
                  {championRow.won}W-{championRow.lost}L ({championRow.points} Pts)
                </span>{' '}
                · Team Strength{' '}
                <span className="font-mono-num font-extrabold text-amber-400 text-base">
                  {championRow.xiStrength.toFixed(1)}
                </span>
              </div>
              <div className="text-xs text-slate-300 mt-1.5">
                Your Finish ({FRANCHISE_MAP[userFranchiseId].shortName}): Rank{' '}
                <strong className="text-white">#{userStanding.rank}/10</strong> ·{' '}
                <span className="font-mono-num text-sky-400 font-bold">
                  {userStanding.won}W-{userStanding.lost}L ({userStanding.points} Pts)
                </span>{' '}
                · XI Strength{' '}
                <span className="font-mono-num text-amber-300 font-bold">
                  {userStanding.xiStrength.toFixed(1)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              onClick={() => setStage('PICK_XI')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold text-white transition whitespace-nowrap"
            >
              <Users className="w-4 h-4" />
              Edit Playing XI & Re-Compete
            </button>
            <button
              onClick={handleShareResult}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold text-white transition whitespace-nowrap"
            >
              {copiedShare ? (
                <Check className="w-4 h-4 text-emerald-400" />
              ) : (
                <Share2 className="w-4 h-4" />
              )}
              {copiedShare ? 'Result Copied' : 'Share'}
            </button>
            <button
              onClick={onRematch}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-xs font-extrabold text-slate-950 transition whitespace-nowrap"
            >
              <RotateCcw className="w-4 h-4" />
              New Auction
            </button>
            <button
              onClick={onBackHome}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition whitespace-nowrap"
            >
              Arena Home
            </button>
          </div>
        </div>
      </section>

      {/* NAVIGATION TABS + FRANCHISE SWITCHER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-x-auto">
          {[
            { id: 'ceremony' as const, label: 'Championship Leaderboard', icon: Trophy },
            { id: 'matches' as const, label: 'XI vs XI Matches', icon: Swords },
            { id: 'xi' as const, label: 'All 10 Playing XIs', icon: Shield },
            { id: 'analytics' as const, label: 'Squad Analytics', icon: BarChart3 },
            { id: 'replay' as const, label: 'Auction Replay', icon: PlayCircle },
            { id: 'strategy' as const, label: 'Strategy Report', icon: Scale },
          ].map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 ${
                  activeTab === tab.id
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-slate-500 dark:text-slate-400" htmlFor="inspect-franchise">
            Inspect Team:
          </label>
          <select
            id="inspect-franchise"
            value={selectedFranchise}
            onChange={(e) => setSelectedFranchise(e.target.value as FranchiseId)}
            className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-900 dark:text-white"
          >
            {standings.map((row) => (
              <option key={row.franchiseId} value={row.franchiseId}>
                #{row.rank} {FRANCHISE_MAP[row.franchiseId].name} ({row.points} Pts ·{' '}
                {row.xiStrength.toFixed(1)})
                {row.franchiseId === userFranchiseId ? ' — YOU' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* TAB 1: CHAMPIONSHIP LEADERBOARD & AWARDS */}
      {activeTab === 'ceremony' && (
        <div className="space-y-6">
          <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                IPL 2027 Championship Leaderboard
              </h2>
              <span className="text-xs text-slate-500">
                Ranked by Playing XI League Wins, NRR & Real-Stat Team Strength
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-900/80 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="py-3 px-4 font-semibold">Rank</th>
                    <th className="py-3 px-4 font-semibold">Franchise</th>
                    <th className="py-3 px-3 font-semibold text-right">W-L</th>
                    <th className="py-3 px-3 font-semibold text-right">Pts</th>
                    <th className="py-3 px-3 font-semibold text-right">NRR</th>
                    <th className="py-3 px-3 font-semibold text-right">XI Strength</th>
                    <th className="py-3 px-3 font-semibold text-right">Bat / Bowl</th>
                    <th className="py-3 px-4 font-semibold">Key Signing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {standings.map((row) => {
                    const rankColor =
                      row.rank === 1
                        ? 'text-amber-400'
                        : row.rank === 2
                        ? 'text-slate-300'
                        : row.rank === 3
                        ? 'text-orange-400'
                        : 'text-slate-500';
                    const isMine = row.franchiseId === userFranchiseId;
                    const team = state.teams[row.franchiseId];
                    return (
                      <tr
                        key={row.franchiseId}
                        onClick={() => setSelectedFranchise(row.franchiseId)}
                        className={`cursor-pointer transition-colors ${
                          row.franchiseId === selectedFranchise
                            ? 'bg-amber-500/10'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-900/50'
                        }`}
                      >
                        <td className={`py-3 px-4 font-mono-num font-extrabold text-sm ${rankColor}`}>
                          #{row.rank}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            <FranchiseBadge franchiseId={row.franchiseId} size="xs" />
                            <div>
                              <div className="font-semibold text-slate-900 dark:text-white">
                                {FRANCHISE_MAP[row.franchiseId].name}
                                {isMine ? ' (You)' : ''}
                                {row.rank === 1 ? ' 🏆' : ''}
                              </div>
                              <div className="text-[11px] text-slate-500">{team.ownerName}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono-num font-bold text-slate-800 dark:text-slate-200">
                          {row.won}-{row.lost}
                        </td>
                        <td className="py-3 px-3 text-right font-mono-num font-extrabold text-sm text-emerald-500">
                          {row.points}
                        </td>
                        <td className="py-3 px-3 text-right font-mono-num text-slate-600 dark:text-slate-300">
                          {row.nrr >= 0 ? `+${row.nrr.toFixed(2)}` : row.nrr.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono-num font-extrabold text-sm text-amber-500">
                          {row.xiStrength.toFixed(1)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono-num text-slate-600 dark:text-slate-300">
                          {row.rating.battingScore} / {row.rating.bowlingScore}
                        </td>
                        <td className="py-3 px-4 text-slate-700 dark:text-slate-300">
                          {row.rating.awards.highestPriced
                            ? `${row.rating.awards.highestPriced.player.name} (${formatCr(
                                row.rating.awards.highestPriced.priceCr
                              )})`
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Selected Team Awards Showcase */}
          <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Award className="w-5 h-5 text-amber-500" />
                {FRANCHISE_MAP[selectedFranchise].name} — Season Honors
              </h3>
              <span className="font-mono-num text-base font-extrabold text-amber-500">
                Win Index {inspectedRating.winPercentage.toFixed(1)}%
              </span>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">{inspectedRating.summary}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: 'Highest Signing', item: inspectedRating.awards.highestPriced },
                { label: 'Best Value Buy', item: inspectedRating.awards.bestBargain },
                { label: 'MVP Indian Star', item: inspectedRating.awards.bestIndian },
                { label: 'MVP Overseas Star', item: inspectedRating.awards.bestOverseas },
              ].map((card) => (
                <div
                  key={card.label}
                  className="rounded-xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 p-3.5"
                >
                  <div className="text-[11px] font-semibold text-amber-500">{card.label}</div>
                  {card.item ? (
                    <button
                      onClick={() => onInspectPlayer(card.item!.player)}
                      className="mt-2 flex items-center gap-2.5 text-left w-full"
                    >
                      <PlayerAvatar player={card.item.player} size="sm" />
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                          {card.item.player.name}
                        </div>
                        <div className="text-xs font-mono-num text-slate-500">
                          {formatCr(card.item.priceCr)} · {card.item.player.secondaryRole}
                        </div>
                      </div>
                    </button>
                  ) : (
                    <div className="text-xs text-slate-500 mt-2">None acquired</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PLAYING XI HEAD-TO-HEAD MATCH LOG */}
      {activeTab === 'matches' && (
        <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                Playing XI League Match Results
              </h2>
              <p className="text-xs text-slate-500">
                All 45 head-to-head clashes between the 10 franchises&apos; Playing XIs.
              </p>
            </div>
            <select
              value={matchTeamFilter}
              onChange={(e) =>
                setMatchTeamFilter(e.target.value as 'USER' | 'ALL' | FranchiseId)
              }
              className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-900 dark:text-white"
            >
              <option value="USER">
                My Matches ({FRANCHISE_MAP[userFranchiseId].shortName} — 9 Matches)
              </option>
              <option value="ALL">All 45 League Matches</option>
              {ALL_FRANCHISE_IDS.map((fid) => (
                <option key={fid} value={fid}>
                  {FRANCHISE_MAP[fid].name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {filteredMatches.map((m) => (
              <div
                key={m.matchNumber}
                className="rounded-xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between text-[11px] font-bold text-slate-500">
                  <span>
                    ROUND {m.roundNumber} · MATCH #{m.matchNumber}
                  </span>
                  <span className="text-amber-500">
                    {FRANCHISE_MAP[m.winnerId].shortName} {m.marginText}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <FranchiseBadge franchiseId={m.homeId} size="xs" />
                    <span
                      className={`font-bold ${
                        m.winnerId === m.homeId
                          ? 'text-slate-900 dark:text-white'
                          : 'text-slate-500'
                      }`}
                    >
                      {FRANCHISE_MAP[m.homeId].shortName}
                    </span>
                    <span className="font-mono-num text-amber-500 font-bold">
                      {m.homeScoreText}
                    </span>
                  </div>
                  <span className="text-slate-400 font-bold">vs</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono-num text-sky-400 font-bold">
                      {m.awayScoreText}
                    </span>
                    <span
                      className={`font-bold ${
                        m.winnerId === m.awayId
                          ? 'text-slate-900 dark:text-white'
                          : 'text-slate-500'
                      }`}
                    >
                      {FRANCHISE_MAP[m.awayId].shortName}
                    </span>
                    <FranchiseBadge franchiseId={m.awayId} size="xs" />
                  </div>
                </div>
                {m.playerOfMatch && (
                  <div className="pt-1.5 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
                    Star of the Match:{' '}
                    <strong className="text-slate-800 dark:text-slate-200">
                      {m.playerOfMatchSummary}
                    </strong>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: ALL 10 PLAYING XI LINEUPS (GOLD/SILVER/BRONZE CARDS) */}
      {activeTab === 'xi' && (
        <div className="space-y-4">
          <div
            className={`rounded-xl px-4 py-3 text-xs flex items-center justify-between gap-2.5 border ${
              inspectedXI.isValid
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-700 dark:text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/25 text-rose-700 dark:text-rose-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {inspectedXI.isValid ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0" />
              )}
              <span>
                {inspectedXI.isValid
                  ? `${FRANCHISE_MAP[selectedFranchise].name} Playing XI — Overseas ${inspectedXI.overseasCount}/${state.ruleset.maxOverseasPlayingXI} · ${inspectedXI.bowlingOptionsCount} Bowling Options`
                  : inspectedXI.validationErrors.join(' · ')}
              </span>
            </div>
            {selectedFranchise === userFranchiseId && (
              <button
                onClick={() => setStage('PICK_XI')}
                className="font-bold underline text-amber-500 shrink-0"
              >
                Change My XI
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3.5">
            {inspectedXI.starters.map((slot) => (
              <button
                key={slot.player.id}
                onClick={() => onInspectPlayer(slot.player)}
                className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 hover:border-amber-400/60 p-3 flex flex-col items-center text-center gap-1.5 transition"
              >
                <div className="w-full flex items-center justify-between text-[10px] font-mono-num">
                  <span className="font-bold text-slate-400">#{slot.order}</span>
                  <span className="font-extrabold text-amber-500">
                    {[
                      slot.isCaptain ? '(C)' : '',
                      slot.isViceCaptain ? '(VC)' : '',
                      slot.isWicketkeeper ? '(WK)' : '',
                      slot.player.isOverseas ? '✈' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                </div>
                <PlayerAvatar player={slot.player} size="lg" />
                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate w-full">
                  {slot.roleLabel}
                </div>
                <div className="font-mono-num text-[11px] font-bold text-amber-500">
                  {formatCr(slot.priceCr)}
                </div>
              </button>
            ))}
          </div>

          {/* Impact Sub & Bench */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {inspectedXI.impactPlayer && (
              <div className="lg:col-span-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 p-4 space-y-2">
                <div className="text-xs font-bold text-amber-400">IMPACT PLAYER SUB</div>
                <div className="flex items-center gap-3">
                  <PlayerAvatar player={inspectedXI.impactPlayer.player} size="md" />
                  <div>
                    <div className="font-display text-xl font-bold text-slate-900 dark:text-white">
                      {inspectedXI.impactPlayer.player.name}
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-300">
                      {inspectedXI.impactPlayer.player.secondaryRole}
                    </div>
                  </div>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  {inspectedXI.impactPlayer.reason}
                </p>
              </div>
            )}

            <div className="lg:col-span-8 rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 space-y-2.5">
              <h4 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                Bench ({inspectedXI.bench.length})
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {inspectedXI.bench.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onInspectPlayer(p)}
                    className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-slate-500 text-left flex items-center gap-2.5 transition"
                  >
                    <PlayerAvatar player={p} size="sm" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                        {p.name} {p.isOverseas ? '✈' : ''}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {COUNTRY_FLAGS[p.countryCode] ?? ''} {p.secondaryRole}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: SQUAD ANALYTICS */}
      {activeTab === 'analytics' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-3">
            <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              7-Axis Team Profile vs League Average
            </h3>
            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData}>
                  <PolarGrid stroke="#334155" />
                  <PolarAngleAxis dataKey="metric" tick={{ fill: '#94A3B8', fontSize: 12 }} />
                  <PolarRadiusAxis
                    angle={30}
                    domain={[0, 100]}
                    tick={{ fill: '#64748B', fontSize: 10 }}
                  />
                  <Radar
                    name={FRANCHISE_MAP[selectedFranchise].shortName}
                    dataKey="team"
                    stroke="#F59E0B"
                    fill="#F59E0B"
                    fillOpacity={0.35}
                  />
                  <Radar
                    name="League Avg"
                    dataKey="league"
                    stroke="#38BDF8"
                    fill="#38BDF8"
                    fillOpacity={0.18}
                  />
                  <Legend />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0F172A',
                      borderColor: '#334155',
                      borderRadius: '10px',
                      color: '#F8FAFC',
                    }}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="lg:col-span-6 rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                Performance Breakdown
              </h3>
              <span className="font-mono-num text-2xl font-extrabold text-amber-500">
                {inspectedRating.winPercentage.toFixed(1)}%
              </span>
            </div>

            <div className="space-y-3">
              {[
                { label: 'Batting Strength', raw: inspectedRating.battingScore },
                { label: 'Bowling Strength', raw: inspectedRating.bowlingScore },
                { label: 'All-Rounder Flexibility', raw: inspectedRating.allRoundScore },
                { label: 'Playing XI Balance', raw: inspectedRating.balanceScore },
                { label: 'Indian & Overseas Core', raw: inspectedRating.overseasScore },
                { label: 'Impact Sub & Depth', raw: inspectedRating.depthScore },
                { label: 'Auction Efficiency', raw: inspectedRating.budgetEfficiencyScore },
              ].map((row) => (
                <div key={row.label} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-700 dark:text-slate-300 font-medium">
                      {row.label}
                    </span>
                    <span className="font-mono-num font-bold text-slate-900 dark:text-white">
                      {row.raw}/100
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-amber-500"
                      style={{ width: `${row.raw}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-3.5 text-xs space-y-1">
                <div className="font-semibold text-emerald-500">Key Strengths</div>
                {inspectedRating.strengths.map((s) => (
                  <div key={s} className="text-slate-700 dark:text-slate-300">
                    • {s}
                  </div>
                ))}
              </div>
              <div className="rounded-xl bg-rose-500/5 border border-rose-500/20 p-3.5 text-xs space-y-1">
                <div className="font-semibold text-rose-400">Improvement Areas</div>
                {inspectedRating.weaknesses.length > 0 ? (
                  inspectedRating.weaknesses.map((w) => (
                    <div key={w} className="text-slate-700 dark:text-slate-300">
                      • {w}
                    </div>
                  ))
                ) : (
                  <div className="text-slate-500">No major roster gaps detected.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: AUCTION TIMELINE REPLAY */}
      {activeTab === 'replay' && (
        <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                Auction Timeline Replay
              </h3>
              <p className="text-xs text-slate-500">
                Scrub through all {replayEvents.length} retentions, nominations, bids, RTMs, and
                sales.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={replayTeamFilter}
                onChange={(e) => {
                  setReplayTeamFilter(e.target.value);
                  setReplayIndex(0);
                  setReplayPlaying(false);
                }}
                className="rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-white"
              >
                <option value="ALL">All Franchises</option>
                {ALL_FRANCHISE_IDS.map((fid) => (
                  <option key={fid} value={fid}>
                    {FRANCHISE_MAP[fid].name}
                  </option>
                ))}
              </select>

              <button
                onClick={() => setReplayPlaying((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-bold text-xs"
              >
                {replayPlaying ? (
                  <PauseCircle className="w-4 h-4" />
                ) : (
                  <PlayCircle className="w-4 h-4" />
                )}
                {replayPlaying ? 'Pause' : 'Play Replay'}
              </button>

              <button
                onClick={() => setReplaySpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-mono-num font-bold text-slate-900 dark:text-white"
              >
                <FastForward className="w-3.5 h-3.5" />
                {replaySpeed}x
              </button>
            </div>
          </div>

          {replayEvents.length > 0 && (
            <div className="space-y-3">
              <input
                type="range"
                min={0}
                max={Math.max(0, replayEvents.length - 1)}
                value={replayIndex}
                onChange={(e) => {
                  setReplayPlaying(false);
                  setReplayIndex(Number(e.target.value));
                }}
                className="w-full accent-amber-500"
              />

              {replayEvents[replayIndex] && (
                <div className="rounded-xl bg-slate-950 text-white border border-slate-800 p-4 flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-[11px] font-mono-num text-amber-400">
                      Event {replayIndex + 1} / {replayEvents.length} ·{' '}
                      {new Date(replayEvents[replayIndex].timestamp).toLocaleTimeString()} ·{' '}
                      {replayEvents[replayIndex].type.replace(/_/g, ' ')}
                    </div>
                    <div className="text-base font-semibold">
                      {replayEvents[replayIndex].message}
                    </div>
                  </div>
                  {replayEvents[replayIndex].franchiseId && (
                    <FranchiseBadge franchiseId={replayEvents[replayIndex].franchiseId!} size="md" />
                  )}
                </div>
              )}

              <div className="max-h-72 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl">
                {replayEvents
                  .slice(0, replayIndex + 1)
                  .reverse()
                  .slice(0, 40)
                  .map((ev) => (
                    <div
                      key={ev.id}
                      className="px-3.5 py-2.5 text-xs flex items-center justify-between gap-3"
                    >
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {ev.message}
                      </span>
                      {ev.amountCr !== undefined && (
                        <span className="font-mono-num font-bold text-amber-500 shrink-0">
                          {formatCr(ev.amountCr)}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 6: STRATEGY COMPARISON */}
      {activeTab === 'strategy' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-3">
            <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Spend by Role vs League Average (₹ Cr)
            </h3>
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={roleSpendChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                  <XAxis dataKey="role" tick={{ fill: '#94A3B8', fontSize: 11 }} />
                  <YAxis tick={{ fill: '#94A3B8', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0F172A',
                      borderColor: '#334155',
                      borderRadius: '10px',
                      color: '#F8FAFC',
                    }}
                  />
                  <Legend />
                  <Bar
                    dataKey="selected"
                    name={FRANCHISE_MAP[selectedFranchise].shortName}
                    fill="#F59E0B"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar dataKey="leagueAvg" name="League Avg" fill="#38BDF8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
            <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Strategic Insights
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-[11px] text-slate-500">Avg Signing Price</div>
                <div className="font-mono-num text-lg font-bold text-amber-500">
                  {formatCr(strategyReport.avgPurchasePriceCr)}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-[11px] text-slate-500">League Avg Signing</div>
                <div className="font-mono-num text-lg font-bold text-sky-400">
                  {formatCr(strategyReport.leagueAvgPurchasePriceCr)}
                </div>
              </div>
            </div>
            <ul className="space-y-2 text-xs text-slate-700 dark:text-slate-300">
              {strategyReport.insights.map((ins) => (
                <li
                  key={ins}
                  className="rounded-lg bg-slate-50 dark:bg-slate-900/60 p-2.5 border border-slate-200 dark:border-slate-800"
                >
                  {ins}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
