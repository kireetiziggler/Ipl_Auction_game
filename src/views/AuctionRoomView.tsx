import React, { useEffect, useMemo, useState } from 'react';
import {
  Gavel,
  Pause,
  Play,
  FastForward,
  SkipForward,
  Info,
  AlertCircle,
  CheckCircle2,
  Shield,
  Hand,
  Sparkles,
  Wifi,
  Power,
  X,
  CreditCard,
} from 'lucide-react';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { COUNTRY_FLAGS } from '../data/players';
import { formatCr, getNextBidIncrement, MIN_MATCH_SQUAD_SIZE, roundCr } from '../data/rulesets';
import {
  computeLiveTeamSuggestions,
  getEffectiveTimerSeconds,
  getMaxAllowedBidCr,
  getRequiredNextBidCr,
  validateBid,
} from '../engine/auctionStateMachine';
import { AuctionState, FranchiseId, GameSettings, Player } from '../engine/types';
import { ConnectionStatus } from '../services/multiplayerClient';
import { FranchiseBadge } from '../components/FranchiseBadge';
import { PlayerAvatar } from '../components/PlayerAvatar';

const AUCTIONEER_IMG = '/src/assets/images/auctioneer_host_portrait_1795354539552.jpg';

interface AuctionRoomViewProps {
  state: AuctionState;
  playerMap: Record<string, Player>;
  userFranchiseId: FranchiseId;
  clientId: string;
  isMultiplayer: boolean;
  connectionStatus: ConnectionStatus;
  settings: GameSettings;
  lastError: string | null;
  onPlaceBid: (amountCr?: number) => void;
  onPass: () => void;
  onRespondRtmOffer: (useRtm: boolean) => void;
  onSubmitRtmCounter: (counterBidCr: number | null) => void;
  onRespondRtmFinalMatch: (matchCounter: boolean) => void;
  onTogglePause: () => void;
  onNominatePlayer: (playerId: string) => void;
  onSkipPlayer4x?: () => void;
  onSkipSet?: () => void;
  onSimulateRemaining: () => void;
  onEndAndExit: () => void;
  onFinishNow: () => void;
  onInspectPlayer: (player: Player) => void;
}

export const AuctionRoomView: React.FC<AuctionRoomViewProps> = ({
  state,
  playerMap,
  userFranchiseId,
  clientId,
  isMultiplayer,
  connectionStatus,
  settings,
  lastError,
  onPlaceBid,
  onPass,
  onRespondRtmOffer,
  onSubmitRtmCounter,
  onRespondRtmFinalMatch,
  onTogglePause,
  onNominatePlayer,
  onSkipPlayer4x,
  onSkipSet,
  onSimulateRemaining,
  onEndAndExit,
  onFinishNow,
  onInspectPlayer,
}) => {
  const [rightTab, setRightTab] = useState<'stats' | 'squad' | 'queue'>('stats');
  const [inspectedTeamId, setInspectedTeamId] = useState<FranchiseId | null>(null);
  const [autoMaxCr, setAutoMaxCr] = useState<string>('');
  const [pendingHighBidCr, setPendingHighBidCr] = useState<number | null>(null);
  const [showNominateModal, setShowNominateModal] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [customRtmCounter, setCustomRtmCounter] = useState<string>('');
  const [, setRevealTick] = useState(0);

  const isHost = state.hostId === clientId;
  const userTeam = state.teams[userFranchiseId];
  const currentPlayer = state.currentPlayerId ? playerMap[state.currentPlayerId] : null;
  const leaderFranchise = state.currentBidderId ? FRANCHISE_MAP[state.currentBidderId] : null;

  const nowMs = Date.now();
  const isRevealingLot = Boolean(
    currentPlayer &&
      state.phase === 'OPENING_BID' &&
      !state.hasOpeningBid &&
      state.lotRevealAt &&
      nowMs < state.lotRevealAt
  );

  // Flip the card cleanly at the exact lotRevealAt timestamp after "The next player is..."
  useEffect(() => {
    if (!state.lotRevealAt) return;
    const delay = state.lotRevealAt - Date.now();
    if (delay <= 0) return;
    const t = window.setTimeout(() => setRevealTick((v) => v + 1), delay + 30);
    return () => window.clearTimeout(t);
  }, [state.lotRevealAt, state.currentPlayerId]);

  const nextBidCr = currentPlayer ? getRequiredNextBidCr(state, currentPlayer) : 0;
  const stepCr = getNextBidIncrement(state.currentBidCr, state.ruleset);
  const maxAllowedCr = getMaxAllowedBidCr(userTeam, state.ruleset);

  const bidCheck = useMemo(() => {
    if (!currentPlayer) return { valid: false, reason: 'Waiting for next player' };
    if (isRevealingLot) return { valid: false, reason: 'Introducing next player...' };
    return validateBid(state, userFranchiseId, currentPlayer, nextBidCr);
  }, [state, userFranchiseId, currentPlayer, nextBidCr, isRevealingLot]);

  const liveAdvice = useMemo(
    () => computeLiveTeamSuggestions(userTeam, state.ruleset, playerMap),
    [userTeam, state.ruleset, playerMap]
  );

  useEffect(() => {
    setAutoMaxCr('');
    setPendingHighBidCr(null);
    setCustomRtmCounter('');
  }, [state.currentPlayerId]);

  useEffect(() => {
    const ceiling = Number(autoMaxCr);
    if (!ceiling || !currentPlayer || !bidCheck.valid) return;
    if (
      state.currentBidderId !== userFranchiseId &&
      nextBidCr <= ceiling &&
      (state.phase === 'OPENING_BID' || state.phase === 'BIDDING' || state.phase === 'COUNTDOWN')
    ) {
      const t = window.setTimeout(() => {
        onPlaceBid(nextBidCr);
      }, 320);
      return () => window.clearTimeout(t);
    }
  }, [
    autoMaxCr,
    currentPlayer,
    bidCheck.valid,
    state.currentBidderId,
    userFranchiseId,
    nextBidCr,
    state.phase,
    onPlaceBid,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space' && bidCheck.valid) {
        e.preventDefault();
        attemptBid(nextBidCr);
      } else if (e.key.toLowerCase() === 'p' && state.currentBidderId !== userFranchiseId) {
        onPass();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const attemptBid = (amountCr: number) => {
    if (amountCr >= settings.confirmBeforeHighBidCr && pendingHighBidCr !== amountCr) {
      setPendingHighBidCr(amountCr);
      return;
    }
    setPendingHighBidCr(null);
    onPlaceBid(amountCr);
  };

  const timerTotal = getEffectiveTimerSeconds(state);
  const timerPct = Math.max(
    0,
    Math.min(100, (state.countdownRemainingSec / Math.max(1, timerTotal)) * 100)
  );
  const isUrgent =
    state.countdownRemainingSec <= 3 &&
    (state.phase === 'BIDDING' || state.phase === 'COUNTDOWN' || state.phase === 'OPENING_BID');

  const inspectedTeam = inspectedTeamId ? state.teams[inspectedTeamId] : null;
  const rtm = state.rtmState;
  const isRtmPhase =
    state.phase === 'RTM_OFFER' ||
    state.phase === 'RTM_COUNTER' ||
    state.phase === 'RTM_FINAL_MATCH';

  const stageGlowColor = leaderFranchise?.primaryColor ?? '#F59E0B';
  const showSoloSkipControls =
    !isMultiplayer && state.mode !== 'MULTIPLAYER' && Boolean(onSkipPlayer4x || onSkipSet);
  const canSkipCurrentLot =
    state.phase === 'OPENING_BID' ||
    state.phase === 'BIDDING' ||
    state.phase === 'COUNTDOWN' ||
    state.phase === 'PAUSED';

  return (
    <div className="space-y-2 sm:space-y-3.5 pb-4 sm:pb-6">
      {/* COMPACT TOP AUCTIONEER BROADCAST STRIP (Voice is inbuilt & hidden — zero mute/skip buttons!) */}
      <div className="rounded-xl sm:rounded-2xl bg-white dark:bg-[#0D1526] border border-slate-200 dark:border-slate-800 px-3 py-2 sm:px-4 sm:py-2.5 flex items-center justify-between gap-2 sm:gap-3 shadow-sm">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src={AUCTIONEER_IMG}
            alt="IPL Live Auctioneer"
            referrerPolicy="no-referrer"
            className="w-8 h-8 sm:w-10 sm:h-10 rounded-full object-cover border-2 border-amber-500/70 shrink-0 shadow"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-bold tracking-wider uppercase text-amber-500 truncate">
              <span>LOT #{state.currentPlayerIndex}</span>
              <span className="text-slate-500 dark:text-slate-400 font-medium normal-case">
                · {state.playerQueue.length} Left
              </span>
              {isMultiplayer && (
                <span className="hidden sm:inline-flex items-center gap-1 text-emerald-500 normal-case">
                  <Wifi className="w-3 h-3" />
                  {state.roomCode} ({connectionStatus})
                </span>
              )}
            </div>
            <p
              className="text-xs sm:text-sm text-slate-900 dark:text-slate-100 font-medium truncate"
              aria-live="polite"
            >
              “{isRevealingLot ? 'The next player is...' : state.lastAnnouncement}”
            </p>
          </div>
        </div>

        {/* Pause / Resume, Nominate & End Auction Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {isHost && (
            <>
              <button
                onClick={onTogglePause}
                className={`inline-flex items-center justify-center gap-1 min-h-[36px] px-2.5 sm:px-3.5 py-1.5 rounded-xl text-[11px] sm:text-xs font-bold transition whitespace-nowrap border ${
                  state.phase === 'PAUSED'
                    ? 'bg-emerald-500 text-slate-950 border-emerald-400 hover:bg-emerald-400'
                    : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-white'
                }`}
                aria-label={state.phase === 'PAUSED' ? 'Resume Auction' : 'Pause Auction'}
              >
                {state.phase === 'PAUSED' ? (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span className="hidden sm:inline">Resume</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3.5 h-3.5 text-amber-500" />
                    <span className="hidden sm:inline">Pause</span>
                  </>
                )}
              </button>

              {state.nominationMode === 'MANAGER_NOMINATION' && state.playerQueue.length > 0 && (
                <button
                  onClick={() => setShowNominateModal(true)}
                  className="hidden sm:inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-xs font-semibold text-sky-400 transition whitespace-nowrap"
                >
                  <Sparkles className="w-3.5 h-3.5" /> Nominate
                </button>
              )}

              <button
                onClick={() => setShowEndModal(true)}
                className="inline-flex items-center justify-center gap-1 min-h-[36px] px-2.5 sm:px-3.5 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-[11px] sm:text-xs font-bold text-rose-400 transition whitespace-nowrap"
                aria-label="End Auction"
              >
                <Power className="w-3.5 h-3.5" />
                <span>End</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* MAIN ARENA 12-COLUMN GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 sm:gap-4 items-start">
        {/* LEFT/CENTER STAGE (7 cols) */}
        <div className="lg:col-span-7 space-y-2 sm:space-y-3.5">
          {/* SPOTLIGHT PLAYER STAGE WITH DYNAMIC FRANCHISE GLOW */}
          <div
            className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-gradient-to-b from-[#101A32] via-[#0B1222] to-[#080D1A] border border-slate-800 p-3 sm:p-5 text-white shadow-2xl"
            style={{
              boxShadow: `0 20px 50px -24px ${stageGlowColor}55`,
            }}
          >
            {/* Subtle Floodlight Glow Backdrop */}
            <div
              className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[420px] h-48 rounded-full blur-3xl opacity-20 transition-colors duration-500"
              style={{ backgroundColor: stageGlowColor }}
            />

            {/* SOLD / UNSOLD Dramatic Stamp Overlay */}
            {(state.phase === 'SOLD' || state.phase === 'UNSOLD') && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/88 backdrop-blur-md p-6 text-center">
                {state.phase === 'SOLD' && leaderFranchise ? (
                  <>
                    <div className="inline-flex items-center gap-2 text-emerald-400 font-bold text-xs tracking-widest uppercase mb-2">
                      <Gavel className="w-4 h-4" /> HAMMER DOWN
                    </div>
                    <div className="font-display text-6xl sm:text-7xl font-extrabold tracking-tight text-amber-400 drop-shadow">
                      SOLD!
                    </div>
                    <div className="flex items-center gap-3.5 mt-4 bg-white/5 border border-white/10 rounded-2xl px-5 py-3">
                      <FranchiseBadge franchiseId={leaderFranchise.id} size="lg" />
                      <div className="text-left">
                        <div className="font-display text-2xl font-bold text-white">
                          {currentPlayer?.name}
                        </div>
                        <div className="text-sm text-slate-300">
                          to <strong className="text-white">{leaderFranchise.name}</strong> for{' '}
                          <span className="font-mono-num font-extrabold text-amber-400">
                            {formatCr(state.currentBidCr)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-display text-5xl sm:text-6xl font-extrabold tracking-tight text-rose-400">
                      UNSOLD
                    </div>
                    <div className="text-sm text-slate-300 mt-2">
                      {currentPlayer?.name} received no bids at {formatCr(currentPlayer?.basePriceCr ?? 0)}
                    </div>
                  </>
                )}
                <div className="text-xs text-slate-400 mt-4">Preparing next player lot...</div>
              </div>
            )}

            {/* REAL IPL 3-STAGE RIGHT TO MATCH (RTM) OVERLAY */}
            {isRtmPhase && rtm && currentPlayer && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/92 backdrop-blur-md p-6 text-center">
                <div className="max-w-md w-full rounded-2xl bg-[#0F172A] border border-amber-500/50 p-6 space-y-4 shadow-2xl shadow-amber-500/15">
                  <div className="inline-flex items-center gap-2 text-xs font-extrabold tracking-widest uppercase text-amber-400">
                    <CreditCard className="w-4 h-4" />
                    RIGHT TO MATCH (RTM) · {state.countdownRemainingSec}s
                  </div>

                  <div className="flex items-center justify-center gap-3">
                    <PlayerAvatar player={currentPlayer} size="md" />
                    <div className="text-left">
                      <div className="font-display text-2xl font-extrabold text-white">
                        {currentPlayer.name}
                      </div>
                      <div className="text-xs text-slate-300">
                        Winning Bid: <strong className="text-amber-400 font-mono-num">{formatCr(rtm.counterBidCr ?? rtm.initialBidCr)}</strong> by{' '}
                        <strong>{FRANCHISE_MAP[rtm.winningFranchiseId].shortName}</strong>
                      </div>
                    </div>
                  </div>

                  {/* STAGE 1: OFFER */}
                  {state.phase === 'RTM_OFFER' && (
                    rtm.rtmFranchiseId === userFranchiseId ? (
                      <div className="space-y-3">
                        <p className="text-xs text-slate-300">
                          {FRANCHISE_MAP[rtm.winningFranchiseId].name} won the bid at{' '}
                          <strong className="text-amber-400">{formatCr(rtm.initialBidCr)}</strong>. Exercise your RTM card ({userTeam.rtmRemaining} remaining)? They will get one final counter-bid.
                        </p>
                        <div className="grid grid-cols-2 gap-2.5">
                          <button
                            onClick={() => onRespondRtmOffer(true)}
                            className="py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-extrabold text-sm transition"
                          >
                            Use RTM Card
                          </button>
                          <button
                            onClick={() => onRespondRtmOffer(false)}
                            className="py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-sm transition"
                          >
                            Decline RTM
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-amber-200">
                        Waiting for <strong>{FRANCHISE_MAP[rtm.rtmFranchiseId].name}</strong> to decide on their Right To Match card...
                      </p>
                    )
                  )}

                  {/* STAGE 2: COUNTER BID BY WINNING BIDDER */}
                  {state.phase === 'RTM_COUNTER' && (
                    rtm.winningFranchiseId === userFranchiseId ? (
                      <div className="space-y-3">
                        <p className="text-xs text-slate-300">
                          <strong>{FRANCHISE_MAP[rtm.rtmFranchiseId].name}</strong> activated RTM! Submit ONE final counter-bid to force them to pay more (or concede the player at {formatCr(rtm.initialBidCr)}).
                        </p>
                        <div className="grid grid-cols-3 gap-2">
                          {[0.5, 1.0, 2.0].map((raise) => {
                            const target = roundCr(rtm.initialBidCr + raise);
                            const affordable = target <= maxAllowedCr;
                            return (
                              <button
                                key={raise}
                                disabled={!affordable}
                                onClick={() => onSubmitRtmCounter(target)}
                                className="py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500 hover:text-slate-950 border border-amber-500/50 disabled:opacity-35 text-amber-300 font-mono-num font-bold text-xs transition"
                              >
                                {formatCr(target)}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            step="0.25"
                            min={roundCr(rtm.initialBidCr + 0.25)}
                            max={maxAllowedCr}
                            value={customRtmCounter}
                            onChange={(e) => setCustomRtmCounter(e.target.value)}
                            placeholder={`Custom Cr (max ${maxAllowedCr.toFixed(1)})`}
                            className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs font-mono-num text-white"
                          />
                          <button
                            disabled={
                              !Number(customRtmCounter) ||
                              Number(customRtmCounter) <= rtm.initialBidCr ||
                              Number(customRtmCounter) > maxAllowedCr
                            }
                            onClick={() => onSubmitRtmCounter(Number(customRtmCounter))}
                            className="px-3.5 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-bold text-xs"
                          >
                            Counter
                          </button>
                        </div>
                        <button
                          onClick={() => onSubmitRtmCounter(null)}
                          className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs transition"
                        >
                          Do Not Raise (Allow RTM at {formatCr(rtm.initialBidCr)})
                        </button>
                      </div>
                    ) : (
                      <p className="text-sm text-sky-300">
                        <strong>{FRANCHISE_MAP[rtm.rtmFranchiseId].name}</strong> invoked RTM! Waiting for{' '}
                        <strong>{FRANCHISE_MAP[rtm.winningFranchiseId].name}</strong>&apos;s final counter-bid...
                      </p>
                    )
                  )}

                  {/* STAGE 3: FINAL MATCH */}
                  {state.phase === 'RTM_FINAL_MATCH' && (
                    rtm.rtmFranchiseId === userFranchiseId ? (
                      <div className="space-y-3">
                        <p className="text-xs text-slate-300">
                          <strong>{FRANCHISE_MAP[rtm.winningFranchiseId].name}</strong> raised their final offer to{' '}
                          <strong className="text-amber-400 font-mono-num">
                            {formatCr(rtm.counterBidCr ?? rtm.initialBidCr)}
                          </strong>
                          . Match this price to reclaim {currentPlayer.name}?
                        </p>
                        <div className="grid grid-cols-2 gap-2.5">
                          <button
                            onClick={() => onRespondRtmFinalMatch(true)}
                            className="py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-extrabold text-sm transition"
                          >
                            Match {formatCr(rtm.counterBidCr ?? rtm.initialBidCr)}
                          </button>
                          <button
                            onClick={() => onRespondRtmFinalMatch(false)}
                            className="py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-sm transition"
                          >
                            Let Them Buy
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-amber-200">
                        Final counter-bid submitted at{' '}
                        <strong className="font-mono-num">{formatCr(rtm.counterBidCr ?? rtm.initialBidCr)}</strong>! Waiting for{' '}
                        <strong>{FRANCHISE_MAP[rtm.rtmFranchiseId].name}</strong> to match or decline...
                      </p>
                    )
                  )}
                </div>
              </div>
            )}

            {/* EXACT PAUSE OVERLAY */}
            {state.phase === 'PAUSED' && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/88 backdrop-blur-md p-6 text-center">
                <div className="text-xs font-bold tracking-widest uppercase text-amber-400 mb-1">
                  EXACT STATE PRESERVED
                </div>
                <div className="font-display text-4xl sm:text-5xl font-extrabold text-white">
                  AUCTION PAUSED
                </div>
                <p className="text-sm text-slate-300 mt-2 max-w-sm">
                  Frozen on <strong>{currentPlayer?.name}</strong> at{' '}
                  <span className="font-mono-num text-amber-400 font-bold">
                    {formatCr(state.currentBidCr)}
                  </span>{' '}
                  with <span className="font-mono-num font-bold">{state.countdownRemainingSec}s</span> left.
                </p>
                {isHost && (
                  <button
                    onClick={onTogglePause}
                    className="mt-5 px-6 py-3 rounded-xl bg-amber-500 text-slate-950 font-display font-extrabold text-base hover:bg-amber-400 shadow-lg shadow-amber-500/20 inline-flex items-center gap-2 transition"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    Resume Exactly Here
                  </button>
                )}
              </div>
            )}

            {currentPlayer ? (
              isRevealingLot ? (
                /* SYNCHRONIZED VOICE-TO-CARD REVEAL CURTAIN ("The next player is...") */
                <div className="relative z-10 min-h-[214px] sm:min-h-[320px] flex flex-col items-center justify-center text-center py-3 space-y-3">
                  <div
                    className="w-[104px] h-[142px] sm:w-[138px] sm:h-[190px] bg-gradient-to-b from-[#1E293B] via-[#0F172A] to-[#060A14] border-2 border-amber-400/70 shadow-xl shadow-amber-500/20 flex flex-col items-center justify-center p-3"
                    style={{
                      clipPath:
                        'polygon(50% 2%, 88% 7%, 96% 12%, 96% 79%, 82% 91%, 50% 98%, 18% 91%, 4% 79%, 4% 12%, 12% 7%)',
                    }}
                  >
                    <Gavel className="w-7 h-7 sm:w-9 sm:h-9 text-amber-400 mb-1.5" />
                    <span className="font-display text-[10px] sm:text-xs font-extrabold tracking-widest uppercase text-amber-300">
                      IPL 2027
                    </span>
                    <span className="text-[9px] text-slate-400 mt-0.5">LOT #{state.currentPlayerIndex}</span>
                  </div>
                  <div>
                    <div className="text-[11px] font-bold tracking-widest uppercase text-amber-400">
                      {state.reentryRound ? 'Accelerated Re-Entry' : currentPlayer.category}
                    </div>
                    <div className="font-display text-xl sm:text-2xl font-extrabold text-white mt-0.5">
                      The Next Player Is...
                    </div>
                  </div>
                </div>
              ) : (
              <div className="relative z-10 space-y-2.5 sm:space-y-4">
                {/* Set Category & Countdown Bar */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-[11px] sm:text-xs">
                    <span className="text-slate-300 font-semibold truncate">
                      {state.reentryRound ? 'Re-Entry' : currentPlayer.category} ·{' '}
                      {currentPlayer.isCapped ? 'Capped' : 'Uncapped'} ·{' '}
                      {currentPlayer.isOverseas ? 'Overseas' : 'Indian'}
                    </span>
                    <span
                      className={`font-mono-num font-extrabold text-xs sm:text-sm whitespace-nowrap shrink-0 tabular-nums ${
                        isUrgent ? 'text-rose-400' : 'text-amber-400'
                      }`}
                    >
                      {state.countdownRemainingSec}s
                      {state.hasOpeningBid &&
                      state.countdownRemainingSec <= state.ruleset.goingTwiceAtSeconds
                        ? ' · TWICE'
                        : state.hasOpeningBid &&
                          state.countdownRemainingSec <= state.ruleset.goingOnceAtSeconds
                        ? ' · ONCE'
                        : ''}
                    </span>
                  </div>
                  <div className="h-1.5 sm:h-2 rounded-full bg-slate-800/90 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        isUrgent
                          ? 'bg-gradient-to-r from-rose-600 to-rose-400'
                          : 'bg-gradient-to-r from-amber-500 to-amber-300'
                      }`}
                      style={{ width: `${timerPct}%` }}
                    />
                  </div>
                </div>

                {/* Gold/Silver/Bronze Shield Player Card + Live Bid Scoreboard (Horizontal even on mobile for zero-scroll!) */}
                <div className="flex flex-row gap-3 sm:gap-5 items-center">
                  <PlayerAvatar player={currentPlayer} size="stage" />

                  <div className="flex-1 min-w-0 flex flex-col justify-between space-y-2 sm:space-y-3">
                    <div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-1.5 truncate">
                        <span>
                          {COUNTRY_FLAGS[currentPlayer.countryCode] ?? ''} {currentPlayer.country}
                        </span>
                        <span>· {currentPlayer.age}y</span>
                        <span className="hidden sm:inline">· {currentPlayer.battingStyle}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1.5 mt-0.5">
                        <h2 className="font-display text-xl sm:text-3xl font-extrabold tracking-tight text-white truncate">
                          {currentPlayer.name}
                        </h2>
                        <button
                          onClick={() => onInspectPlayer(currentPlayer)}
                          className="p-1.5 sm:p-2 rounded-lg bg-white/5 hover:bg-white/15 text-slate-300 hover:text-white transition shrink-0"
                          title="Full Career Stats"
                          aria-label="Inspect full player report"
                        >
                          <Info className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                      </div>
                      <div className="text-xs sm:text-sm text-sky-300 font-semibold truncate">
                        {currentPlayer.secondaryRole}
                        {currentPlayer.ipl2025Franchise &&
                          state.teams[currentPlayer.ipl2025Franchise]?.rtmRemaining > 0 && (
                            <span className="ml-1.5 text-[11px] text-amber-400 font-bold">
                              · RTM ({currentPlayer.ipl2025Franchise})
                            </span>
                          )}
                      </div>
                    </div>

                    {/* Compact Scoreboard Bid Readout */}
                    <div className="rounded-xl sm:rounded-2xl bg-slate-950/80 border border-slate-800 p-2.5 sm:p-3.5 grid grid-cols-2 gap-2.5 sm:gap-4">
                      <div className="min-w-0">
                        <div className="text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold text-slate-400 truncate">
                          {state.hasOpeningBid ? 'Current Bid' : 'Base Price'}
                        </div>
                        <div className="font-mono-num text-xl sm:text-3xl font-extrabold text-amber-400 mt-0.5 tabular-nums truncate">
                          {formatCr(state.currentBidCr)}
                        </div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400 truncate">
                          Base{' '}
                          <span className="font-mono-num text-slate-200 font-semibold tabular-nums">
                            {formatCr(currentPlayer.basePriceCr)}
                          </span>
                        </div>
                      </div>

                      <div className="border-l border-slate-800 pl-2.5 sm:pl-4 flex flex-col justify-center min-w-0">
                        <div className="text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold text-slate-400 truncate">
                          Leading
                        </div>
                        {leaderFranchise ? (
                          <div className="flex items-center gap-1.5 sm:gap-2.5 mt-1">
                            <FranchiseBadge franchiseId={leaderFranchise.id} size="xs" />
                            <div className="min-w-0">
                              <div className="font-display text-base sm:text-xl font-extrabold text-white leading-tight truncate">
                                {leaderFranchise.shortName}
                              </div>
                              <div className="text-[10px] text-slate-400 truncate">
                                {state.currentBidderId === userFranchiseId
                                  ? 'Your Bid'
                                  : leaderFranchise.city}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs sm:text-sm font-medium text-slate-400 mt-1 leading-tight">
                            Awaiting Bid
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Compact Real Career Stat Strip */}
                <div className="grid grid-cols-4 gap-1.5 pt-2 sm:pt-3 border-t border-slate-800/80 text-center">
                  <div>
                    <div className="text-[10px] sm:text-[11px] text-slate-400">Matches</div>
                    <div className="font-mono-num text-xs sm:text-sm font-bold text-white tabular-nums">
                      {currentPlayer.stats.matches}
                    </div>
                  </div>
                  {currentPlayer.primaryRole === 'Fast Bowler' ||
                  currentPlayer.primaryRole === 'Spinner' ? (
                    <>
                      <div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">Wickets</div>
                        <div className="font-mono-num text-xs sm:text-sm font-bold text-white tabular-nums">
                          {currentPlayer.stats.wickets}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">Economy</div>
                        <div className="font-mono-num text-xs sm:text-sm font-bold text-emerald-400 tabular-nums">
                          {currentPlayer.stats.economy > 0
                            ? currentPlayer.stats.economy.toFixed(2)
                            : '-'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">Best</div>
                        <div className="font-mono-num text-xs sm:text-sm font-bold text-white tabular-nums">
                          {currentPlayer.stats.bestBowling}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">Runs</div>
                        <div className="font-mono-num text-xs sm:text-sm font-bold text-white tabular-nums">
                          {currentPlayer.stats.runs}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">Strike Rate</div>
                        <div className="font-mono-num text-xs sm:text-sm font-bold text-sky-400 tabular-nums">
                          {currentPlayer.stats.strikeRate > 0
                            ? currentPlayer.stats.strikeRate.toFixed(1)
                            : '-'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">Average</div>
                        <div className="font-mono-num text-xs sm:text-sm font-bold text-white tabular-nums">
                          {currentPlayer.stats.battingAvg > 0
                            ? currentPlayer.stats.battingAvg.toFixed(1)
                            : '-'}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
              )
            ) : (
              <div className="py-12 text-center text-slate-400">Loading next player...</div>
            )}
          </div>

          {/* TACTILE BID CONTROLS PANEL (Thumb-Zone Zero-Scroll Ready) */}
          <div className="rounded-2xl bg-white dark:bg-[#0D1526] border border-slate-200 dark:border-slate-800 p-3 sm:p-4 space-y-2 sm:space-y-3 shadow-sm">
            {/* Compact 1-Line Purse, Squad & RTM Summary */}
            <div className="flex items-center justify-between gap-2 text-[11px] sm:text-xs pb-2 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-1.5 min-w-0">
                <FranchiseBadge franchiseId={userFranchiseId} size="xs" />
                <span className="font-bold text-slate-900 dark:text-white truncate">
                  {FRANCHISE_MAP[userFranchiseId].shortName}
                </span>
              </div>
              <div className="flex items-center gap-2 sm:gap-3 font-mono-num text-slate-600 dark:text-slate-300 tabular-nums shrink-0">
                <span>
                  <strong className="text-amber-500">{formatCr(userTeam.purseRemainingCr)}</strong>
                </span>
                <span>·</span>
                <span>
                  <strong
                    className={
                      userTeam.squad.length < MIN_MATCH_SQUAD_SIZE ? 'text-amber-400' : ''
                    }
                    title={`Minimum ${MIN_MATCH_SQUAD_SIZE} players required to compete`}
                  >
                    {userTeam.squad.length}/{state.ruleset.maxSquadSize}
                  </strong>
                  {userTeam.squad.length < MIN_MATCH_SQUAD_SIZE && (
                    <span className="hidden sm:inline text-[10px] text-slate-400 ml-1">
                      (min {MIN_MATCH_SQUAD_SIZE})
                    </span>
                  )}
                </span>
                <span>·</span>
                <span>
                  OS <strong>{userTeam.overseasCount}/{state.ruleset.maxOverseasSquad}</strong>
                </span>
                <span>·</span>
                <span>
                  RTM <strong className="text-sky-400">{userTeam.rtmRemaining}</strong>
                </span>
              </div>
            </div>

            {pendingHighBidCr !== null && (
              <div className="rounded-xl bg-amber-500/15 border border-amber-500/40 px-3 py-2 flex items-center justify-between gap-2 text-xs">
                <span className="text-amber-200 font-medium truncate">
                  Confirm <strong className="font-mono-num">{formatCr(pendingHighBidCr)}</strong>?
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setPendingHighBidCr(null)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-200 font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const amt = pendingHighBidCr;
                      setPendingHighBidCr(null);
                      onPlaceBid(amt);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-bold"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}

            {/* Primary Bid & Pass Row (Side-by-side even on compact mobile!) */}
            <div className="grid grid-cols-12 gap-2">
              <button
                disabled={!bidCheck.valid}
                onClick={() => attemptBid(nextBidCr)}
                className={`col-span-8 min-h-[48px] sm:min-h-[54px] px-3 sm:px-5 py-2.5 rounded-xl font-display font-extrabold text-sm sm:text-lg flex items-center justify-center gap-2 transition active:scale-[0.98] whitespace-nowrap ${
                  state.currentBidderId === userFranchiseId
                    ? 'bg-emerald-600/20 border border-emerald-500/40 text-emerald-400 cursor-default'
                    : bidCheck.valid
                    ? 'bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-slate-950 shadow-lg shadow-amber-500/25'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-500 cursor-not-allowed'
                }`}
              >
                <Gavel className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
                {isRevealingLot ? (
                  <span>Stand By...</span>
                ) : state.currentBidderId === userFranchiseId ? (
                  <span className="truncate">Leading ({formatCr(state.currentBidCr)})</span>
                ) : (
                  <span className="font-mono-num truncate tabular-nums">
                    {state.hasOpeningBid ? 'BID' : 'OPEN'} · {formatCr(nextBidCr)}
                  </span>
                )}
              </button>

              <button
                disabled={
                  isRevealingLot ||
                  state.currentBidderId === userFranchiseId ||
                  userTeam.passedCurrentPlayer ||
                  (state.phase !== 'OPENING_BID' &&
                    state.phase !== 'BIDDING' &&
                    state.phase !== 'COUNTDOWN')
                }
                onClick={onPass}
                className="col-span-4 min-h-[48px] sm:min-h-[54px] px-2.5 sm:px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 text-slate-900 dark:text-slate-100 font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 transition whitespace-nowrap"
              >
                <Hand className="w-4 h-4 shrink-0" />
                {userTeam.passedCurrentPlayer ? 'Passed' : 'Pass'}
              </button>
            </div>

            {/* Quick Jump Bids & Auto-Max */}
            <div className="flex items-center justify-between gap-2 pt-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-slate-500 dark:text-slate-400">Jump:</span>
                {[2, 4].map((mult) => {
                  const jumpAmt = roundCr(nextBidCr + stepCr * (mult - 1));
                  const canJump = bidCheck.valid && jumpAmt <= maxAllowedCr && state.hasOpeningBid;
                  return (
                    <button
                      key={mult}
                      disabled={!canJump}
                      onClick={() => attemptBid(jumpAmt)}
                      className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-amber-500/60 disabled:opacity-35 text-[11px] sm:text-xs font-mono-num font-semibold text-slate-800 dark:text-slate-200 transition tabular-nums"
                    >
                      {formatCr(jumpAmt)}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap" htmlFor="auto-max-input">
                  Auto Max:
                </label>
                <input
                  id="auto-max-input"
                  type="number"
                  step="0.5"
                  min={nextBidCr}
                  max={maxAllowedCr}
                  placeholder="Off"
                  value={autoMaxCr}
                  onChange={(e) => setAutoMaxCr(e.target.value)}
                  className="w-16 sm:w-20 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs font-mono-num text-slate-900 dark:text-white focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>

            {/* SOLO-ONLY FAST CONTROLS: Skip Player (4x) & Skip Current Set (Never shown in Multiplayer) */}
            {showSoloSkipControls && (
              <div className="grid grid-cols-2 gap-2 pt-1.5 border-t border-slate-200 dark:border-slate-800/80">
                {onSkipPlayer4x && (
                  <button
                    type="button"
                    disabled={!canSkipCurrentLot || Boolean(state.fastForwardCurrentLot)}
                    onClick={onSkipPlayer4x}
                    className={`min-h-[36px] px-2.5 py-1.5 rounded-xl text-[11px] sm:text-xs font-bold flex items-center justify-center gap-1.5 border transition whitespace-nowrap ${
                      state.fastForwardCurrentLot
                        ? 'bg-amber-500/20 border-amber-500/50 text-amber-400 cursor-default'
                        : 'bg-slate-100 dark:bg-slate-900/90 border-slate-200 dark:border-slate-700 hover:border-amber-500/60 hover:text-amber-400 disabled:opacity-40 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <FastForward className="w-3.5 h-3.5 shrink-0" />
                    <span>{state.fastForwardCurrentLot ? '4x Fast-Forwarding...' : 'Skip Player (4x)'}</span>
                  </button>
                )}

                {onSkipSet && (
                  <button
                    type="button"
                    disabled={state.phase === 'COMPLETED'}
                    onClick={onSkipSet}
                    className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-700 hover:border-sky-500/60 hover:text-sky-400 disabled:opacity-40 text-slate-700 dark:text-slate-200 text-[11px] sm:text-xs font-bold flex items-center justify-center gap-1.5 transition truncate"
                    title={`Skip all remaining players in ${currentPlayer?.category ?? 'current set'} and move to next set`}
                  >
                    <SkipForward className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      Skip Set{currentPlayer ? ` (${currentPlayer.category})` : ''}
                    </span>
                  </button>
                )}
              </div>
            )}

            {((!bidCheck.valid && !isRevealingLot && state.currentBidderId !== userFranchiseId && currentPlayer) || lastError) && (
              <div className="text-[11px] text-amber-500 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{lastError || bidCheck.reason}</span>
              </div>
            )}
          </div>

          {/* RESERVED EMPTY MOBILE AD BANNER SPACE BELOW BIDDING (Intentionally empty for future ad integration) */}
          <div
            data-ad-slot="auction-mobile-banner"
            aria-hidden="true"
            className="lg:hidden w-full h-[64px] shrink-0"
          />

          {/* ALL 10 FRANCHISES LIVE BOARD */}
          <div className="rounded-2xl bg-white dark:bg-[#0D1526] border border-slate-200 dark:border-slate-800 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                Franchise Purses & RTM Cards
              </h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Click any team to inspect squad
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {ALL_FRANCHISE_IDS.map((fid) => {
                const t = state.teams[fid];
                const isLeading = state.currentBidderId === fid;
                const isMe = fid === userFranchiseId;
                return (
                  <button
                    key={fid}
                    onClick={() => setInspectedTeamId(fid)}
                    className={`text-left rounded-xl p-2.5 border transition-all ${
                      isLeading
                        ? 'bg-amber-500/15 border-amber-500 shadow-sm'
                        : isMe
                        ? 'bg-sky-500/10 border-sky-500/40'
                        : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <FranchiseBadge franchiseId={fid} size="xs" />
                        <span className="font-display font-bold text-sm text-slate-900 dark:text-white truncate">
                          {fid}
                        </span>
                      </div>
                      <span className="text-[10px] font-bold text-sky-400 font-mono-num">
                        {t.rtmRemaining}R
                      </span>
                    </div>
                    <div className="font-mono-num text-xs font-bold text-amber-500 mt-1.5">
                      {formatCr(t.purseRemainingCr)}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono-num flex items-center justify-between mt-0.5">
                      <span>{t.squad.length}/{state.ruleset.maxSquadSize}</span>
                      <span>OS {t.overseasCount}/{state.ruleset.maxOverseasSquad}</span>
                    </div>
                    {isLeading && (
                      <div className="text-[10px] font-extrabold text-amber-400 mt-1 truncate">
                        LEADING
                      </div>
                    )}
                    {!isLeading && t.passedCurrentPlayer && (
                      <div className="text-[10px] text-slate-500 mt-1 truncate">Passed</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT ANALYTICS & LIVE MANAGEMENT COLUMN (5 cols) */}
        <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#0D1526] border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="flex border-b border-slate-200 dark:border-slate-800 p-1.5 gap-1 bg-slate-50 dark:bg-slate-900/60">
            {[
              { id: 'stats' as const, label: 'Bid Feed & Fit' },
              { id: 'squad' as const, label: `My Squad (${userTeam.squad.length})` },
              { id: 'queue' as const, label: `Upcoming (${state.playerQueue.length})` },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setRightTab(tab.id)}
                className={`flex-1 py-2 px-2 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                  rightTab === tab.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="p-4 space-y-4 max-h-[680px] overflow-y-auto">
            {rightTab === 'stats' && (
              <>
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5 text-amber-500" />
                    Live Strategy Advisor
                  </div>
                  <div className="space-y-1.5">
                    {liveAdvice.suggestions.map((s, idx) => (
                      <div
                        key={idx}
                        className={`rounded-lg px-3 py-2 text-xs flex items-start gap-2 ${
                          s.severity === 'urgent'
                            ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/20'
                            : s.severity === 'positive'
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
                            : 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        {s.severity === 'positive' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        )}
                        <span>{s.text}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-5 gap-1.5 text-center">
                  {[
                    { label: 'BAT', val: liveAdvice.counts.batters },
                    { label: 'WK', val: liveAdvice.counts.wicketkeepers },
                    { label: 'AR', val: liveAdvice.counts.allRounders },
                    { label: 'PACE', val: liveAdvice.counts.fastBowlers },
                    { label: 'SPIN', val: liveAdvice.counts.spinners },
                  ].map((r) => (
                    <div
                      key={r.label}
                      className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 py-2"
                    >
                      <div className="text-[10px] text-slate-500">{r.label}</div>
                      <div className="font-mono-num text-sm font-bold text-slate-900 dark:text-white">
                        {r.val}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    Current Lot Bid History ({state.bidHistory.length})
                  </div>
                  {state.bidHistory.length === 0 ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                      No paddles raised yet for {currentPlayer?.name}.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {[...state.bidHistory].reverse().map((bid, idx) => (
                        <div
                          key={bid.id}
                          className={`rounded-lg px-3 py-2 flex items-center justify-between gap-2 text-xs ${
                            idx === 0
                              ? 'bg-amber-500/10 border border-amber-500/30'
                              : 'bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <FranchiseBadge franchiseId={bid.franchiseId} size="xs" />
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900 dark:text-white truncate">
                                {FRANCHISE_MAP[bid.franchiseId].name}
                              </div>
                              {bid.aiReason && (
                                <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                                  AI: {bid.aiReason}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="font-mono-num font-bold text-amber-500 shrink-0">
                            {formatCr(bid.amountCr)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {rightTab === 'squad' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span>
                    Indian {liveAdvice.counts.indian} · Overseas {liveAdvice.counts.overseas}
                  </span>
                  <span className="font-mono-num">
                    Spent {formatCr(userTeam.totalSpentCr)}
                  </span>
                </div>
                {userTeam.squad.length === 0 ? (
                  <div className="text-xs text-slate-500 py-10 text-center">
                    No players signed yet. Raise the paddle to build your franchise!
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {userTeam.squad.map((sp) => {
                      const p = playerMap[sp.playerId];
                      if (!p) return null;
                      return (
                        <button
                          key={sp.playerId}
                          onClick={() => onInspectPlayer(p)}
                          className="w-full py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-900/50 px-2 rounded-lg transition text-left"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <PlayerAvatar player={p} size="sm" />
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                                {p.name} {p.isOverseas ? '✈' : ''}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                {p.secondaryRole}
                                {sp.isRetained ? ' · Retained' : sp.acquiredViaRTM ? ' · RTM' : ''}
                              </div>
                            </div>
                          </div>
                          <div className="font-mono-num text-xs font-bold text-amber-500 shrink-0">
                            {formatCr(sp.boughtPriceCr)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {rightTab === 'queue' && (
              <div className="space-y-2">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Next players lined up across IPL 2027 sets ({state.unsoldPool.length} unsold)
                </div>
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {state.playerQueue.slice(0, 30).map((pid, idx) => {
                    const p = playerMap[pid];
                    if (!p) return null;
                    return (
                      <button
                        key={pid}
                        onClick={() => onInspectPlayer(p)}
                        className="w-full py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-900/50 px-2 rounded-lg text-left transition"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PlayerAvatar player={p} size="sm" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900 dark:text-white truncate">
                              <span className="font-mono-num text-xs text-slate-500 mr-1.5">
                                #{idx + 1}
                              </span>
                              {p.name}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              {p.category} · {p.secondaryRole}
                            </div>
                          </div>
                        </div>
                        <div className="font-mono-num text-xs text-slate-600 dark:text-slate-300 shrink-0">
                          {formatCr(p.basePriceCr)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* RESERVED EMPTY DESKTOP WEB BOTTOM AD BANNER SPACE (Intentionally empty for future ad integration) */}
      <div
        data-ad-slot="auction-desktop-banner"
        aria-hidden="true"
        className="hidden lg:block w-full h-[96px] shrink-0"
      />

      {/* END AUCTION / EXIT CONFIRMATION MODAL (Navigation Lock Guard) */}
      {showEndModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
          onClick={() => setShowEndModal(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                End Live Auction?
              </h3>
              <button
                onClick={() => setShowEndModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              To protect live auction integrity, you can either pause for a break, auto-simulate the remaining lots to jump straight to Playing XI selection, or end and exit the session.
            </p>
            {userTeam.squad.length < MIN_MATCH_SQUAD_SIZE && (
              <div className="rounded-xl bg-amber-500/12 border border-amber-500/35 px-3.5 py-2.5 text-xs text-amber-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                <span>
                  Your squad currently has <strong>{userTeam.squad.length}/{MIN_MATCH_SQUAD_SIZE}</strong> players. A minimum of{' '}
                  <strong>{MIN_MATCH_SQUAD_SIZE} players</strong> per team is mandatory before the Playing XI Championship match can start.
                  {!isMultiplayer && ' Sim Rest will auto-complete all remaining lots to at least 14 players.'}
                </span>
              </div>
            )}
            <div className="space-y-2.5 pt-1">
              {!isMultiplayer ? (
                <button
                  onClick={() => {
                    setShowEndModal(false);
                    onSimulateRemaining();
                  }}
                  className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition"
                >
                  <FastForward className="w-4 h-4" />
                  Sim Rest & Pick Playing XI
                </button>
              ) : (
                <button
                  onClick={() => {
                    setShowEndModal(false);
                    onFinishNow();
                  }}
                  className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition"
                >
                  Complete Auction & Pick Playing XI
                </button>
              )}

              <button
                onClick={() => {
                  setShowEndModal(false);
                  onEndAndExit();
                }}
                className="w-full py-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-400 font-bold text-sm transition"
              >
                End Auction & Exit to Home
              </button>

              <button
                onClick={() => setShowEndModal(false)}
                className="w-full py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs transition"
              >
                Keep Bidding
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INSPECT RIVAL TEAM MODAL */}
      {inspectedTeam && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4"
          onClick={() => setInspectedTeamId(null)}
        >
          <div
            className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FranchiseBadge franchiseId={inspectedTeam.franchiseId} size="md" />
                <div>
                  <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                    {FRANCHISE_MAP[inspectedTeam.franchiseId].name}
                  </h3>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {inspectedTeam.ownerName} · Purse{' '}
                    <span className="font-mono-num font-semibold text-amber-500">
                      {formatCr(inspectedTeam.purseRemainingCr)}
                    </span>{' '}
                    · {inspectedTeam.rtmRemaining} RTM
                  </div>
                </div>
              </div>
              <button
                onClick={() => setInspectedTeamId(null)}
                className="text-xs font-semibold text-slate-400 hover:text-white"
              >
                Close
              </button>
            </div>

            {inspectedTeam.squad.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">No players acquired yet.</p>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {inspectedTeam.squad.map((sp) => {
                  const p = playerMap[sp.playerId];
                  if (!p) return null;
                  return (
                    <div key={sp.playerId} className="py-2.5 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2.5">
                        <PlayerAvatar player={p} size="sm" />
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {p.name} {p.isOverseas ? '✈' : ''}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {p.secondaryRole}
                            {sp.isRetained ? ' · Retained' : sp.acquiredViaRTM ? ' · RTM' : ''}
                          </div>
                        </div>
                      </div>
                      <span className="font-mono-num font-bold text-amber-500">
                        {formatCr(sp.boughtPriceCr)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* HOST MANAGER NOMINATION MODAL */}
      {showNominateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4"
          onClick={() => setShowNominateModal(false)}
        >
          <div
            className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                Nominate Next Player
              </h3>
              <button
                onClick={() => setShowNominateModal(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {state.playerQueue.slice(0, 30).map((pid) => {
                const p = playerMap[pid];
                if (!p) return null;
                return (
                  <button
                    key={pid}
                    onClick={() => {
                      onNominatePlayer(pid);
                      setShowNominateModal(false);
                    }}
                    className="w-full py-2.5 px-2 flex items-center justify-between hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-left"
                  >
                    <div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">
                        {p.name}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {p.category} · {p.secondaryRole}
                      </div>
                    </div>
                    <span className="font-mono-num text-xs font-bold text-amber-500">
                      {formatCr(p.basePriceCr)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
