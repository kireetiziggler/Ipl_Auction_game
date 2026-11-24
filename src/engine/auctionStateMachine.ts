import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { DEFAULT_FRANCHISE_RETENTIONS, getPlayerRetentionCostCr } from '../data/retentions';
import { formatCr, formatSpokenPrice, getNextBidIncrement, roundCr } from '../data/rulesets';
import {
  AIDifficulty,
  AuctionEvent,
  AuctionPhase,
  AuctionState,
  BidRecord,
  FranchiseId,
  GameMode,
  NominationMode,
  ParticipantPsychology,
  Player,
  RTMState,
  SeasonRuleset,
  TeamState,
} from './types';

export interface CreateAuctionOptions {
  roomId: string;
  roomCode: string;
  hostId: string;
  hostName: string;
  hostFranchiseId: FranchiseId;
  mode: GameMode;
  ruleset: SeasonRuleset;
  aiDifficulty: AIDifficulty;
  nominationMode?: NominationMode;
  auctionSpeed?: 'NORMAL' | 'FAST' | 'BLITZ';
  players: Player[];
  tournamentId?: string;
  tournamentRound?: number;
}

const MIN_RESERVE_PER_SLOT_CR = 0.3;

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Concise, realistic IPL auctioneer player introduction.
 * Example: "Virat Kohli, Batsman from India. Base price 2 crores."
 * Example: "Rishabh Pant, Wicketkeeper and Batsman from India. Base price 2 crores."
 */
export function formatPlayerIntroSpeech(player: Player): string {
  let roleSpoken: string;
  switch (player.primaryRole) {
    case 'Batter':
      roleSpoken = 'Batsman';
      break;
    case 'Wicketkeeper':
      roleSpoken = 'Wicketkeeper and Batsman';
      break;
    case 'All-rounder':
      roleSpoken = 'All-rounder';
      break;
    case 'Fast Bowler':
    case 'Spinner':
    default:
      roleSpoken = 'Bowler';
      break;
  }
  return `The next player is... ${player.name}, ${roleSpoken} from ${player.country}. Base price ${formatSpokenPrice(
    player.basePriceCr
  )}.`;
}

export function buildPlayerQueue(players: Player[], ruleset: SeasonRuleset): string[] {
  const ordered: Player[] = [];
  for (const cat of ruleset.categoryOrder) {
    const inCat = players
      .filter((p) => p.category === cat)
      .sort((a, b) => b.basePriceCr - a.basePriceCr || b.stats.matches - a.stats.matches);
    ordered.push(...inCat);
  }
  // Include any custom-added players outside listed categories
  const seen = new Set(ordered.map((p) => p.id));
  for (const p of players) {
    if (!seen.has(p.id)) {
      ordered.push(p);
    }
  }
  if (ruleset.maxPoolSize && ordered.length > ruleset.maxPoolSize) {
    const perCat = Math.max(4, Math.floor(ruleset.maxPoolSize / ruleset.categoryOrder.length));
    const trimmed: Player[] = [];
    for (const cat of ruleset.categoryOrder) {
      const catPlayers = ordered.filter((p) => p.category === cat).slice(0, perCat);
      trimmed.push(...catPlayers);
    }
    return trimmed.slice(0, ruleset.maxPoolSize).map((p) => p.id);
  }
  return ordered.map((p) => p.id);
}

function createEmptyPsychology(franchiseId: FranchiseId): ParticipantPsychology {
  return {
    franchiseId,
    bidsPlaced: 0,
    aggressiveBids: 0,
    roleInterest: {
      Batter: 0,
      Wicketkeeper: 0,
      'All-rounder': 0,
      'Fast Bowler': 0,
      Spinner: 0,
    },
    avgBidOverEstimate: 0,
    recentWithdrawals: 0,
  };
}

export function createInitialAuctionState(opts: CreateAuctionOptions): AuctionState {
  const now = Date.now();
  const teams = {} as Record<FranchiseId, TeamState>;
  const psychology = {} as Record<FranchiseId, ParticipantPsychology>;

  for (const fid of ALL_FRANCHISE_IDS) {
    const cfg = FRANCHISE_MAP[fid];
    const isHost = fid === opts.hostFranchiseId;
    teams[fid] = {
      franchiseId: fid,
      controllerType: isHost ? 'HUMAN' : 'AI',
      ownerId: isHost ? opts.hostId : undefined,
      ownerName: isHost ? opts.hostName : `${cfg.ownerPersona} (AI)`,
      isConnected: true,
      isReady: !isHost,
      purseRemainingCr: opts.ruleset.initialPurseCr,
      totalSpentCr: 0,
      squad: [],
      overseasCount: 0,
      rtmRemaining: opts.ruleset.allowRTM ? opts.ruleset.rtmCardsPerTeam : 0,
      aiPersonality: cfg.aiPersonality,
      passedCurrentPlayer: false,
    };
    psychology[fid] = createEmptyPsychology(fid);
  }

  return {
    roomId: opts.roomId,
    roomCode: opts.roomCode,
    hostId: opts.hostId,
    mode: opts.mode,
    phase: 'LOBBY',
    ruleset: opts.ruleset,
    aiDifficulty: opts.aiDifficulty,
    nominationMode: opts.nominationMode ?? 'SET_ORDER',
    auctionSpeed: opts.auctionSpeed ?? (opts.mode === 'QUICK' ? 'FAST' : 'NORMAL'),
    teams,
    playerQueue: buildPlayerQueue(opts.players, opts.ruleset),
    unsoldPool: [],
    reentryRound: false,
    currentPlayerIndex: 0,
    currentPlayerId: null,
    currentBidCr: 0,
    currentBidderId: null,
    hasOpeningBid: false,
    countdownEndsAt: null,
    countdownRemainingSec: opts.ruleset.bidTimerSeconds,
    pausedFromPhase: undefined,
    pausedRemainingMs: undefined,
    rtmState: null,
    retentionsApplied: false,
    lastAnnouncement: 'Welcome to IPL Auction Arena! Select your franchise and complete retentions.',
    bidHistory: [],
    allBids: [],
    events: [],
    psychology,
    processedRequestIds: [],
    createdAt: now,
    updatedAt: now,
    tournamentId: opts.tournamentId,
    tournamentRound: opts.tournamentRound,
  };
}

export function enterRetentionPhase(state: AuctionState, now = Date.now()): AuctionState {
  if (state.phase !== 'LOBBY' && state.phase !== 'READY') return state;
  return {
    ...state,
    phase: 'RETENTION',
    lastAnnouncement: 'Pre-Auction Retention Window open! Lock your retained players and RTM cards.',
    updatedAt: now,
  };
}

/**
 * Applies pre-auction retentions for all 10 franchises:
 * - Deducts exact IPL 2026 retention/auction prices (or basePriceCr if unsold) from each team's purse.
 * - Sets RTM cards remaining to `max(0, maxRetentionsPerTeam - retainedCount)` (real IPL rule).
 * - Removes all retained players from the live auction `playerQueue`.
 */
export function applyRetentions(
  state: AuctionState,
  customSelections: Partial<Record<FranchiseId, string[]>>,
  playerMap: Record<string, Player>,
  now = Date.now()
): AuctionState {
  if (state.retentionsApplied) return state;

  const updatedTeams: Record<FranchiseId, TeamState> = { ...state.teams };
  const retainedIdsGlobal = new Set<string>();
  const events: AuctionEvent[] = [...state.events];
  const maxRet = state.ruleset.maxRetentionsPerTeam ?? 6;

  for (const fid of ALL_FRANCHISE_IDS) {
    const team = updatedTeams[fid];
    const desiredIds =
      customSelections[fid] !== undefined
        ? customSelections[fid]!
        : (DEFAULT_FRANCHISE_RETENTIONS[fid] ?? []).map((r) => r.playerId);

    let purse = team.purseRemainingCr;
    let spent = team.totalSpentCr;
    let overseasCount = team.overseasCount;
    const squad = [...team.squad];
    let retainedForTeam = 0;

    for (const pid of desiredIds) {
      if (retainedForTeam >= maxRet) break;
      if (retainedIdsGlobal.has(pid)) continue;
      const player = playerMap[pid];
      if (!player) continue;
      if (player.isOverseas && overseasCount >= state.ruleset.maxOverseasSquad) continue;

      const costCr = roundCr(getPlayerRetentionCostCr(player));
      // Leave minimum reserve for remaining squad slots
      const slotsAfter = Math.max(0, state.ruleset.minSquadSize - (squad.length + 1));
      if (purse - costCr < slotsAfter * MIN_RESERVE_PER_SLOT_CR) continue;

      purse = roundCr(purse - costCr);
      spent = roundCr(spent + costCr);
      if (player.isOverseas) overseasCount += 1;
      squad.push({
        playerId: player.id,
        boughtPriceCr: costCr,
        boughtAt: now,
        round: 0,
        isRetained: true,
      });
      retainedIdsGlobal.add(player.id);
      retainedForTeam += 1;

      events.push({
        id: uid('evt'),
        type: 'PLAYER_RETAINED',
        timestamp: now,
        playerId: player.id,
        franchiseId: fid,
        amountCr: costCr,
        message: `${FRANCHISE_MAP[fid].shortName} retained ${player.name} for ${formatCr(costCr)}`,
      });
    }

    const rtmCards = state.ruleset.allowRTM ? Math.max(0, maxRet - retainedForTeam) : 0;

    updatedTeams[fid] = {
      ...team,
      purseRemainingCr: purse,
      totalSpentCr: spent,
      squad,
      overseasCount,
      rtmRemaining: rtmCards,
      lastActionNote:
        retainedForTeam > 0
          ? `Retained ${retainedForTeam} · ${rtmCards} RTM`
          : `0 Retained · ${rtmCards} RTM`,
    };
  }

  const remainingQueue = state.playerQueue.filter((id) => !retainedIdsGlobal.has(id));

  return {
    ...state,
    phase: 'READY',
    teams: updatedTeams,
    playerQueue: remainingQueue,
    retentionsApplied: true,
    lastAnnouncement: `Retentions locked (${retainedIdsGlobal.size} players retained across 10 franchises). Live Auction is ready!`,
    events,
    updatedAt: now,
  };
}

export function getEffectiveTimerSeconds(state: AuctionState): number {
  const base = state.ruleset.bidTimerSeconds;
  if (state.auctionSpeed === 'BLITZ') return Math.max(6, Math.round(base * 0.6));
  if (state.auctionSpeed === 'FAST') return Math.max(8, Math.round(base * 0.78));
  return base;
}

export function getMaxAllowedBidCr(team: TeamState, ruleset: SeasonRuleset): number {
  const slotsLeftForMin = Math.max(0, ruleset.minSquadSize - team.squad.length - 1);
  const reserve = slotsLeftForMin * MIN_RESERVE_PER_SLOT_CR;
  return Math.max(0, roundCr(team.purseRemainingCr - reserve));
}

export function getRequiredNextBidCr(state: AuctionState, player: Player): number {
  if (!state.hasOpeningBid) {
    return roundCr(player.basePriceCr);
  }
  const inc = getNextBidIncrement(state.currentBidCr, state.ruleset);
  return roundCr(state.currentBidCr + inc);
}

export interface BidValidationResult {
  valid: boolean;
  reason?: string;
  requiredAmountCr?: number;
}

export function validateBid(
  state: AuctionState,
  franchiseId: FranchiseId,
  player: Player,
  proposedAmountCr?: number,
  requestId?: string
): BidValidationResult {
  if (
    state.phase !== 'OPENING_BID' &&
    state.phase !== 'BIDDING' &&
    state.phase !== 'COUNTDOWN'
  ) {
    return { valid: false, reason: 'Bidding is currently closed for this lot.' };
  }

  if (!state.currentPlayerId || state.currentPlayerId !== player.id) {
    return { valid: false, reason: 'This player is not currently on the auction block.' };
  }

  if (requestId && state.processedRequestIds.includes(requestId)) {
    return { valid: false, reason: 'Duplicate bid request ignored.' };
  }

  const team = state.teams[franchiseId];
  if (!team) {
    return { valid: false, reason: 'Unknown franchise.' };
  }

  if (state.currentBidderId === franchiseId) {
    return { valid: false, reason: 'Your franchise already holds the highest bid.' };
  }

  if (team.squad.length >= state.ruleset.maxSquadSize) {
    return {
      valid: false,
      reason: `Squad is full (${state.ruleset.maxSquadSize}/${state.ruleset.maxSquadSize}).`,
    };
  }

  if (player.isOverseas && team.overseasCount >= state.ruleset.maxOverseasSquad) {
    return {
      valid: false,
      reason: `Overseas limit reached (${state.ruleset.maxOverseasSquad}/${state.ruleset.maxOverseasSquad}).`,
    };
  }

  const minNext = getRequiredNextBidCr(state, player);
  const amount = proposedAmountCr !== undefined ? roundCr(proposedAmountCr) : minNext;

  if (amount < minNext) {
    return {
      valid: false,
      reason: `Minimum valid bid is ${formatCr(minNext)}.`,
      requiredAmountCr: minNext,
    };
  }

  if (amount > team.purseRemainingCr) {
    return { valid: false, reason: 'Insufficient purse remaining.' };
  }

  const maxAllowed = getMaxAllowedBidCr(team, state.ruleset);
  if (amount > maxAllowed) {
    return {
      valid: false,
      reason: `Must reserve purse for minimum squad size (${state.ruleset.minSquadSize} players). Max bid: ${formatCr(maxAllowed)}.`,
    };
  }

  const alreadyOwned = Object.values(state.teams).some((t) =>
    t.squad.some((sp) => sp.playerId === player.id)
  );
  if (alreadyOwned) {
    return { valid: false, reason: 'Player has already been sold.' };
  }

  return { valid: true, requiredAmountCr: amount };
}

export function startAuction(
  state: AuctionState,
  playerMap: Record<string, Player>,
  now = Date.now()
): AuctionState {
  if (state.phase !== 'LOBBY' && state.phase !== 'READY' && state.phase !== 'RETENTION') {
    return state;
  }
  const welcomeMsg =
    'Welcome to the IPL 2027 Mega Auction! Franchises are locked in and the bidding begins now.';
  const startEvent: AuctionEvent = {
    id: uid('evt'),
    type: 'AUCTION_START',
    timestamp: now,
    message: welcomeMsg,
  };
  const next: AuctionState = {
    ...state,
    phase: 'STARTING',
    lastAnnouncement: welcomeMsg,
    events: [...state.events, startEvent],
    updatedAt: now,
  };
  return nominateNextPlayer(next, playerMap, now);
}

export function nominateNextPlayer(
  state: AuctionState,
  playerMap: Record<string, Player>,
  now = Date.now(),
  specificPlayerId?: string
): AuctionState {
  let queue = [...state.playerQueue];
  let unsoldPool = [...state.unsoldPool];
  let reentryRound = state.reentryRound;
  const events = [...state.events];

  const anyTeamCanBuy = Object.values(state.teams).some(
    (t) => t.squad.length < state.ruleset.maxSquadSize && t.purseRemainingCr >= 0.3
  );
  if (!anyTeamCanBuy) {
    return completeAuction(state, now);
  }

  if (queue.length === 0) {
    const minRequired = Math.max(14, state.ruleset.minSquadSize);
    const anyTeamNeedsMin = Object.values(state.teams).some(
      (t) => t.squad.length < minRequired && t.purseRemainingCr >= 0.3
    );
    if ((state.ruleset.allowUnsoldReentry || anyTeamNeedsMin) && !reentryRound && unsoldPool.length > 0) {
      queue = [...unsoldPool];
      unsoldPool = [];
      reentryRound = true;
      events.push({
        id: uid('evt'),
        type: 'REENTRY_START',
        timestamp: now,
        message: 'Accelerated Re-Entry Round begins! Unsold players return so teams can complete their squads.',
      });
    } else {
      return completeAuction({ ...state, events }, now);
    }
  }

  let nextId: string;
  if (specificPlayerId && queue.includes(specificPlayerId)) {
    nextId = specificPlayerId;
    queue = queue.filter((id) => id !== specificPlayerId);
  } else {
    nextId = queue.shift()!;
  }

  const player = playerMap[nextId];
  if (!player) {
    return nominateNextPlayer(
      { ...state, playerQueue: queue, unsoldPool, reentryRound, events },
      playerMap,
      now
    );
  }

  // Skip players already retained or owned
  const alreadyOwned = Object.values(state.teams).some((t) =>
    t.squad.some((sp) => sp.playerId === player.id)
  );
  if (alreadyOwned) {
    return nominateNextPlayer(
      { ...state, playerQueue: queue, unsoldPool, reentryRound, events },
      playerMap,
      now
    );
  }

  const timerSec = getEffectiveTimerSeconds(state);
  const resetTeams = { ...state.teams };
  for (const fid of ALL_FRANCHISE_IDS) {
    resetTeams[fid] = {
      ...resetTeams[fid],
      passedCurrentPlayer: false,
      lastActionNote: undefined,
    };
  }

  const introMsg = formatPlayerIntroSpeech(player);

  events.push({
    id: uid('evt'),
    type: 'PLAYER_NOMINATED',
    timestamp: now,
    playerId: player.id,
    amountCr: player.basePriceCr,
    message: `${player.category}: ${introMsg}`,
  });

  const revealDelayMs = state.auctionSpeed === 'BLITZ' ? 1200 : 1700;
  const biddingOpenDelayMs = state.auctionSpeed === 'BLITZ' ? 2400 : 3500;

  return {
    ...state,
    phase: 'OPENING_BID',
    teams: resetTeams,
    playerQueue: queue,
    unsoldPool,
    reentryRound,
    currentPlayerIndex: state.currentPlayerIndex + 1,
    currentPlayerId: player.id,
    currentBidCr: player.basePriceCr,
    currentBidderId: null,
    hasOpeningBid: false,
    lotRevealAt: now + revealDelayMs,
    biddingOpensAt: now + biddingOpenDelayMs,
    fastForwardCurrentLot: false,
    countdownEndsAt: now + biddingOpenDelayMs + timerSec * 1000,
    countdownRemainingSec: timerSec,
    pausedFromPhase: undefined,
    pausedRemainingMs: undefined,
    rtmState: null,
    lastAnnouncement: introMsg,
    bidHistory: [],
    events,
    updatedAt: now,
  };
}

export function placeBid(
  state: AuctionState,
  franchiseId: FranchiseId,
  player: Player,
  options: {
    proposedAmountCr?: number;
    requestId?: string;
    isAI?: boolean;
    aiReason?: string;
    now?: number;
  } = {}
): { state: AuctionState; accepted: boolean; error?: string } {
  const now = options.now ?? Date.now();
  const reqId = options.requestId ?? uid('req');
  const validation = validateBid(state, franchiseId, player, options.proposedAmountCr, reqId);
  if (!validation.valid || validation.requiredAmountCr === undefined) {
    return { state, accepted: false, error: validation.reason };
  }

  const amountCr = validation.requiredAmountCr;
  const franchise = FRANCHISE_MAP[franchiseId];
  const timerSec = getEffectiveTimerSeconds(state);

  const bidRecord: BidRecord = {
    id: uid('bid'),
    requestId: reqId,
    playerId: player.id,
    franchiseId,
    amountCr,
    timestamp: now,
    isAI: Boolean(options.isAI),
    aiReason: options.aiReason,
  };

  const bidVerb = !state.hasOpeningBid
    ? `${franchise.shortName} opens at ${formatCr(amountCr)}`
    : `${franchise.shortName} raises to ${formatCr(amountCr)}`;

  const bidEvent: AuctionEvent = {
    id: uid('evt'),
    type: 'BID_PLACED',
    timestamp: now,
    playerId: player.id,
    franchiseId,
    amountCr,
    message: bidVerb,
    aiReason: options.aiReason,
  };

  const prevPsych = state.psychology[franchiseId];
  const overEstimateRatio = amountCr / Math.max(1, player.ratings.estimatedValueCr);
  const newBidsPlaced = prevPsych.bidsPlaced + 1;
  const updatedPsych: ParticipantPsychology = {
    ...prevPsych,
    bidsPlaced: newBidsPlaced,
    aggressiveBids: prevPsych.aggressiveBids + (overEstimateRatio > 1.15 ? 1 : 0),
    roleInterest: {
      ...prevPsych.roleInterest,
      [player.primaryRole]: (prevPsych.roleInterest[player.primaryRole] ?? 0) + 1,
    },
    avgBidOverEstimate:
      (prevPsych.avgBidOverEstimate * prevPsych.bidsPlaced + overEstimateRatio) / newBidsPlaced,
  };

  const updatedTeams = { ...state.teams };
  updatedTeams[franchiseId] = {
    ...updatedTeams[franchiseId],
    passedCurrentPlayer: false,
    lastActionNote: `Bid ${formatCr(amountCr)}`,
  };

  const nextState: AuctionState = {
    ...state,
    phase: 'BIDDING',
    teams: updatedTeams,
    currentBidCr: amountCr,
    currentBidderId: franchiseId,
    hasOpeningBid: true,
    lotRevealAt: undefined,
    biddingOpensAt: undefined,
    countdownEndsAt: now + timerSec * 1000,
    countdownRemainingSec: timerSec,
    lastAnnouncement: bidVerb,
    bidHistory: [...state.bidHistory, bidRecord],
    allBids: [...state.allBids, bidRecord],
    events: [...state.events, bidEvent],
    psychology: {
      ...state.psychology,
      [franchiseId]: updatedPsych,
    },
    processedRequestIds: [...state.processedRequestIds.slice(-300), reqId],
    updatedAt: now,
  };

  return { state: nextState, accepted: true };
}

export function passOnCurrentPlayer(
  state: AuctionState,
  franchiseId: FranchiseId,
  now = Date.now()
): AuctionState {
  if (
    state.phase !== 'OPENING_BID' &&
    state.phase !== 'BIDDING' &&
    state.phase !== 'COUNTDOWN'
  ) {
    return state;
  }
  if (state.currentBidderId === franchiseId) return state;

  const team = state.teams[franchiseId];
  if (!team || team.passedCurrentPlayer) return state;

  const updatedTeams = {
    ...state.teams,
    [franchiseId]: {
      ...team,
      passedCurrentPlayer: true,
      lastActionNote: 'Passed',
    },
  };

  const prevPsych = state.psychology[franchiseId];
  const updatedPsych = {
    ...prevPsych,
    recentWithdrawals: prevPsych.recentWithdrawals + 1,
  };

  const activeContenders = Object.values(updatedTeams).filter(
    (t) =>
      t.franchiseId !== state.currentBidderId &&
      !t.passedCurrentPlayer &&
      t.squad.length < state.ruleset.maxSquadSize
  );

  let countdownEndsAt = state.countdownEndsAt;
  let countdownRemainingSec = state.countdownRemainingSec;
  if (activeContenders.length === 0 && countdownRemainingSec > 4) {
    countdownRemainingSec = 4;
    countdownEndsAt = now + 4000;
  }

  return {
    ...state,
    teams: updatedTeams,
    countdownEndsAt,
    countdownRemainingSec,
    psychology: {
      ...state.psychology,
      [franchiseId]: updatedPsych,
    },
    updatedAt: now,
  };
}

/** Checks if the player's IPL 2025 franchise is eligible to exercise a Right To Match (RTM) card. */
export function getEligibleRtmFranchise(
  state: AuctionState,
  player: Player,
  winningFranchiseId: FranchiseId,
  bidCr: number
): FranchiseId | null {
  if (!state.ruleset.allowRTM) return null;
  const formerId = player.ipl2025Franchise;
  if (!formerId || formerId === winningFranchiseId) return null;
  const formerTeam = state.teams[formerId];
  if (!formerTeam || formerTeam.rtmRemaining <= 0) return null;
  if (formerTeam.squad.length >= state.ruleset.maxSquadSize) return null;
  if (player.isOverseas && formerTeam.overseasCount >= state.ruleset.maxOverseasSquad) return null;
  if (bidCr > getMaxAllowedBidCr(formerTeam, state.ruleset)) return null;
  return formerId;
}

function finalizeSale(
  state: AuctionState,
  player: Player,
  winnerId: FranchiseId,
  finalPriceCr: number,
  options: { viaRtm?: boolean; now?: number } = {}
): AuctionState {
  const now = options.now ?? Date.now();
  const winnerTeam = state.teams[winnerId];
  const finalPrice = roundCr(finalPriceCr);
  const franchise = FRANCHISE_MAP[winnerId];

  const alreadyOwned = Object.values(state.teams).some((t) =>
    t.squad.some((sp) => sp.playerId === player.id)
  );
  if (alreadyOwned || finalPrice > winnerTeam.purseRemainingCr) {
    return { ...state, phase: 'UNSOLD', rtmState: null, updatedAt: now };
  }

  const updatedWinner: TeamState = {
    ...winnerTeam,
    purseRemainingCr: roundCr(winnerTeam.purseRemainingCr - finalPrice),
    totalSpentCr: roundCr(winnerTeam.totalSpentCr + finalPrice),
    squad: [
      ...winnerTeam.squad,
      {
        playerId: player.id,
        boughtPriceCr: finalPrice,
        boughtAt: now,
        round: state.reentryRound ? 2 : 1,
        acquiredViaRTM: Boolean(options.viaRtm),
      },
    ],
    overseasCount: winnerTeam.overseasCount + (player.isOverseas ? 1 : 0),
    rtmRemaining: options.viaRtm
      ? Math.max(0, winnerTeam.rtmRemaining - 1)
      : winnerTeam.rtmRemaining,
    lastActionNote: options.viaRtm ? `RTM ${player.name}` : `Signed ${player.name}`,
  };

  const spokenPrice = formatSpokenPrice(finalPrice);
  const msg = options.viaRtm
    ? `RTM exercised! ${player.name} returns to ${franchise.name} for ${spokenPrice}.`
    : `Sold! ${player.name} to ${franchise.name} for ${spokenPrice}.`;

  const evt: AuctionEvent = {
    id: uid('evt'),
    type: options.viaRtm ? 'RTM_USED' : 'PLAYER_SOLD',
    timestamp: now,
    playerId: player.id,
    franchiseId: winnerId,
    amountCr: finalPrice,
    message: options.viaRtm
      ? `RTM USED! ${franchise.shortName} reclaims ${player.name} for ${formatCr(finalPrice)}`
      : `SOLD! ${player.name} to ${franchise.shortName} for ${formatCr(finalPrice)}`,
  };

  return {
    ...state,
    phase: 'SOLD',
    currentBidCr: finalPrice,
    currentBidderId: winnerId,
    rtmState: null,
    teams: {
      ...state.teams,
      [winnerId]: updatedWinner,
    },
    countdownEndsAt: null,
    countdownRemainingSec: 0,
    lastAnnouncement: msg,
    events: [...state.events, evt],
    updatedAt: now,
  };
}

export function closeCurrentLot(
  state: AuctionState,
  playerMap: Record<string, Player>,
  now = Date.now()
): AuctionState {
  if (!state.currentPlayerId) return state;
  const player = playerMap[state.currentPlayerId];
  if (!player) return state;

  if (state.hasOpeningBid && state.currentBidderId) {
    const winnerId = state.currentBidderId;
    const finalPrice = roundCr(state.currentBidCr);

    // Check Real IPL 2025/2026 Right To Match (RTM) eligibility!
    const rtmFranchiseId = getEligibleRtmFranchise(state, player, winnerId, finalPrice);
    if (rtmFranchiseId) {
      const rtmState: RTMState = {
        playerId: player.id,
        rtmFranchiseId,
        winningFranchiseId: winnerId,
        initialBidCr: finalPrice,
        stage: 'OFFER',
      };
      const rtmFranchise = FRANCHISE_MAP[rtmFranchiseId];
      const msg = `Right To Match option for ${rtmFranchise.name} on ${player.name} at ${formatSpokenPrice(
        finalPrice
      )}.`;
      return {
        ...state,
        phase: 'RTM_OFFER',
        rtmState,
        countdownEndsAt: now + 15000,
        countdownRemainingSec: 15,
        lastAnnouncement: msg,
        events: [
          ...state.events,
          {
            id: uid('evt'),
            type: 'RTM_TRIGGERED',
            timestamp: now,
            playerId: player.id,
            franchiseId: rtmFranchiseId,
            amountCr: finalPrice,
            message: `RTM Offer to ${rtmFranchise.shortName} for ${player.name} at ${formatCr(finalPrice)}`,
          },
        ],
        updatedAt: now,
      };
    }

    return finalizeSale(state, player, winnerId, finalPrice, { viaRtm: false, now });
  }

  // Unsold
  const msg = `Unsold! ${player.name} goes unsold.`;
  const evt: AuctionEvent = {
    id: uid('evt'),
    type: 'PLAYER_UNSOLD',
    timestamp: now,
    playerId: player.id,
    message: `UNSOLD: ${player.name} (${formatCr(player.basePriceCr)})`,
  };

  return {
    ...state,
    phase: 'UNSOLD',
    rtmState: null,
    unsoldPool:
      !state.reentryRound && !state.unsoldPool.includes(player.id)
        ? [...state.unsoldPool, player.id]
        : state.unsoldPool,
    countdownEndsAt: null,
    countdownRemainingSec: 0,
    lastAnnouncement: msg,
    events: [...state.events, evt],
    updatedAt: now,
  };
}

/**
 * RTM Stage 1: Former franchise chooses whether to exercise RTM card.
 * Real IPL 2025/2026 rule: if exercised, winning bidder gets ONE final counter-raise chance.
 */
export function respondToRtmOffer(
  state: AuctionState,
  useRtm: boolean,
  playerMap: Record<string, Player>,
  now = Date.now()
): AuctionState {
  if (state.phase !== 'RTM_OFFER' || !state.rtmState) return state;
  const rtm = state.rtmState;
  const player = playerMap[rtm.playerId];
  if (!player) return state;

  if (!useRtm) {
    const rtmFranchise = FRANCHISE_MAP[rtm.rtmFranchiseId];
    const declinedState: AuctionState = {
      ...state,
      events: [
        ...state.events,
        {
          id: uid('evt'),
          type: 'RTM_DECLINED',
          timestamp: now,
          playerId: player.id,
          franchiseId: rtm.rtmFranchiseId,
          amountCr: rtm.initialBidCr,
          message: `${rtmFranchise.shortName} declined RTM on ${player.name}`,
        },
      ],
    };
    return finalizeSale(declinedState, player, rtm.winningFranchiseId, rtm.initialBidCr, {
      viaRtm: false,
      now,
    });
  }

  // Check if winning bidder can afford any raise above initialBidCr
  const winTeam = state.teams[rtm.winningFranchiseId];
  const minRaise = roundCr(rtm.initialBidCr + getNextBidIncrement(rtm.initialBidCr, state.ruleset));
  const winMax = getMaxAllowedBidCr(winTeam, state.ruleset);

  if (minRaise > winMax) {
    // Winning bidder cannot counter-raise -> RTM succeeds immediately at initialBidCr
    return finalizeSale(state, player, rtm.rtmFranchiseId, rtm.initialBidCr, {
      viaRtm: true,
      now,
    });
  }

  const nextRtm: RTMState = {
    ...rtm,
    stage: 'COUNTER',
  };
  const winFranchise = FRANCHISE_MAP[rtm.winningFranchiseId];
  const rtmFranchise = FRANCHISE_MAP[rtm.rtmFranchiseId];
  const msg = `${rtmFranchise.name} exercises Right To Match! ${winFranchise.name} gets one final counter-bid.`;

  return {
    ...state,
    phase: 'RTM_COUNTER',
    rtmState: nextRtm,
    countdownEndsAt: now + 15000,
    countdownRemainingSec: 15,
    lastAnnouncement: msg,
    events: [
      ...state.events,
      {
        id: uid('evt'),
        type: 'RTM_TRIGGERED',
        timestamp: now,
        playerId: player.id,
        franchiseId: rtm.rtmFranchiseId,
        amountCr: rtm.initialBidCr,
        message: `${rtmFranchise.shortName} invoked RTM! ${winFranchise.shortName} may submit one final counter-bid.`,
      },
    ],
    updatedAt: now,
  };
}

/**
 * RTM Stage 2: Winning bidder either submits a single higher counter-bid (`counterBidCr`)
 * or declines to raise (`null`).
 */
export function submitRtmCounter(
  state: AuctionState,
  counterBidCr: number | null,
  playerMap: Record<string, Player>,
  now = Date.now()
): AuctionState {
  if (state.phase !== 'RTM_COUNTER' || !state.rtmState) return state;
  const rtm = state.rtmState;
  const player = playerMap[rtm.playerId];
  if (!player) return state;

  if (counterBidCr === null || counterBidCr <= rtm.initialBidCr) {
    // Winning bidder chose not to raise -> former franchise gets player at initialBidCr via RTM
    return finalizeSale(state, player, rtm.rtmFranchiseId, rtm.initialBidCr, {
      viaRtm: true,
      now,
    });
  }

  const winTeam = state.teams[rtm.winningFranchiseId];
  const winMax = getMaxAllowedBidCr(winTeam, state.ruleset);
  const clampedCounter = roundCr(Math.min(counterBidCr, winMax));
  if (clampedCounter <= rtm.initialBidCr) {
    return finalizeSale(state, player, rtm.rtmFranchiseId, rtm.initialBidCr, {
      viaRtm: true,
      now,
    });
  }

  // Check if RTM franchise can even afford the counter-bid
  const rtmTeam = state.teams[rtm.rtmFranchiseId];
  if (clampedCounter > getMaxAllowedBidCr(rtmTeam, state.ruleset)) {
    // Former franchise cannot afford the counter -> winning bidder wins at clampedCounter!
    return finalizeSale(state, player, rtm.winningFranchiseId, clampedCounter, {
      viaRtm: false,
      now,
    });
  }

  const winFranchise = FRANCHISE_MAP[rtm.winningFranchiseId];
  const rtmFranchise = FRANCHISE_MAP[rtm.rtmFranchiseId];
  const msg = `${winFranchise.name} counters with ${formatSpokenPrice(
    clampedCounter
  )}. Will ${rtmFranchise.name} match?`;

  return {
    ...state,
    phase: 'RTM_FINAL_MATCH',
    rtmState: {
      ...rtm,
      counterBidCr: clampedCounter,
      stage: 'FINAL_MATCH',
    },
    countdownEndsAt: now + 15000,
    countdownRemainingSec: 15,
    lastAnnouncement: msg,
    events: [
      ...state.events,
      {
        id: uid('evt'),
        type: 'RTM_COUNTERED',
        timestamp: now,
        playerId: player.id,
        franchiseId: rtm.winningFranchiseId,
        amountCr: clampedCounter,
        message: `${winFranchise.shortName} countered at ${formatCr(clampedCounter)}! Waiting on ${rtmFranchise.shortName} to match.`,
      },
    ],
    updatedAt: now,
  };
}

/**
 * RTM Stage 3: Former franchise matches the counter-bid (and claims player via RTM)
 * or declines (winning bidder claims player at their counter-bid).
 */
export function respondToRtmFinalMatch(
  state: AuctionState,
  matchCounter: boolean,
  playerMap: Record<string, Player>,
  now = Date.now()
): AuctionState {
  if (state.phase !== 'RTM_FINAL_MATCH' || !state.rtmState) return state;
  const rtm = state.rtmState;
  const player = playerMap[rtm.playerId];
  if (!player) return state;
  const finalPrice = rtm.counterBidCr ?? rtm.initialBidCr;

  if (matchCounter) {
    const rtmTeam = state.teams[rtm.rtmFranchiseId];
    if (finalPrice <= getMaxAllowedBidCr(rtmTeam, state.ruleset)) {
      return finalizeSale(state, player, rtm.rtmFranchiseId, finalPrice, {
        viaRtm: true,
        now,
      });
    }
  }

  return finalizeSale(state, player, rtm.winningFranchiseId, finalPrice, {
    viaRtm: false,
    now,
  });
}

export function completeAuction(state: AuctionState, now = Date.now()): AuctionState {
  if (state.phase === 'COMPLETED') return state;
  const msg =
    'The auction gavel falls for the final time! Pick your Playing Eleven now to compete for the IPL Championship.';
  return {
    ...state,
    phase: 'COMPLETED',
    currentPlayerId: null,
    countdownEndsAt: null,
    countdownRemainingSec: 0,
    rtmState: null,
    pausedFromPhase: undefined,
    pausedRemainingMs: undefined,
    lastAnnouncement: msg,
    events: [
      ...state.events,
      {
        id: uid('evt'),
        type: 'AUCTION_COMPLETED',
        timestamp: now,
        message: msg,
      },
    ],
    updatedAt: now,
  };
}

const PAUSABLE_PHASES: AuctionPhase[] = [
  'OPENING_BID',
  'BIDDING',
  'COUNTDOWN',
  'RTM_OFFER',
  'RTM_COUNTER',
  'RTM_FINAL_MATCH',
];

/**
 * Exact pause: snapshots the active phase and remaining milliseconds so resuming
 * continues from the exact lot, bidder, bid, and millisecond without skipping or resetting.
 */
export function pauseAuction(state: AuctionState, now = Date.now()): AuctionState {
  if (!PAUSABLE_PHASES.includes(state.phase)) {
    return state;
  }
  const remainingMs = state.countdownEndsAt
    ? Math.max(500, state.countdownEndsAt - now)
    : Math.max(1000, (state.countdownRemainingSec || 5) * 1000);
  const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));

  return {
    ...state,
    phase: 'PAUSED',
    pausedFromPhase: state.phase,
    pausedRemainingMs: remainingMs,
    countdownEndsAt: null,
    countdownRemainingSec: remainingSec,
    lastAnnouncement: 'Auction paused. Resume anytime to continue from this exact moment.',
    events: [
      ...state.events,
      {
        id: uid('evt'),
        type: 'AUCTION_PAUSED',
        timestamp: now,
        message: 'Auction paused.',
      },
    ],
    updatedAt: now,
  };
}

/**
 * Exact resume: restores `pausedFromPhase` and `pausedRemainingMs` seamlessly.
 */
export function resumeAuction(state: AuctionState, now = Date.now()): AuctionState {
  if (state.phase !== 'PAUSED') return state;
  const restoredPhase: AuctionPhase =
    state.pausedFromPhase ?? (state.hasOpeningBid ? 'BIDDING' : 'OPENING_BID');
  const remainingMs = Math.max(1500, state.pausedRemainingMs ?? Math.max(2, state.countdownRemainingSec) * 1000);
  const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));

  return {
    ...state,
    phase: restoredPhase,
    lotRevealAt: undefined,
    biddingOpensAt: undefined,
    pausedFromPhase: undefined,
    pausedRemainingMs: undefined,
    countdownEndsAt: now + remainingMs,
    countdownRemainingSec: remainingSec,
    lastAnnouncement: 'Auction resumed! Continuing right where we paused.',
    events: [
      ...state.events,
      {
        id: uid('evt'),
        type: 'AUCTION_RESUMED',
        timestamp: now,
        message: 'Auction resumed.',
      },
    ],
    updatedAt: now,
  };
}

export interface LiveSquadAdvice {
  counts: {
    total: number;
    indian: number;
    overseas: number;
    batters: number;
    wicketkeepers: number;
    allRounders: number;
    fastBowlers: number;
    spinners: number;
    deathBowlers: number;
    powerplayBowlers: number;
    finishers: number;
    openers: number;
  };
  suggestions: { severity: 'urgent' | 'advisory' | 'positive'; text: string }[];
}

export function computeLiveTeamSuggestions(
  team: TeamState,
  ruleset: SeasonRuleset,
  playerMap: Record<string, Player>
): LiveSquadAdvice {
  const players = team.squad
    .map((sp) => playerMap[sp.playerId])
    .filter((p): p is Player => Boolean(p));

  const counts = {
    total: players.length,
    indian: players.filter((p) => !p.isOverseas).length,
    overseas: players.filter((p) => p.isOverseas).length,
    batters: players.filter((p) => p.primaryRole === 'Batter').length,
    wicketkeepers: players.filter((p) => p.primaryRole === 'Wicketkeeper').length,
    allRounders: players.filter((p) => p.primaryRole === 'All-rounder').length,
    fastBowlers: players.filter((p) => p.primaryRole === 'Fast Bowler').length,
    spinners: players.filter((p) => p.primaryRole === 'Spinner').length,
    deathBowlers: players.filter(
      (p) =>
        p.secondaryRole === 'Death-over Specialist' ||
        p.specialtyTags.some((t) => t.toLowerCase().includes('death'))
    ).length,
    powerplayBowlers: players.filter(
      (p) =>
        p.secondaryRole === 'Powerplay Specialist' ||
        p.specialtyTags.some((t) => t.toLowerCase().includes('powerplay'))
    ).length,
    finishers: players.filter(
      (p) =>
        p.secondaryRole === 'Finisher' ||
        p.specialtyTags.some((t) => t.toLowerCase().includes('finisher'))
    ).length,
    openers: players.filter(
      (p) =>
        p.secondaryRole === 'Top-order Batter' ||
        p.specialtyTags.some((t) => t.toLowerCase().includes('opener'))
    ).length,
  };

  const suggestions: { severity: 'urgent' | 'advisory' | 'positive'; text: string }[] = [];
  const slotsToMin = Math.max(0, ruleset.minSquadSize - counts.total);

  if (slotsToMin > 0) {
    suggestions.push({
      severity: slotsToMin >= 5 && team.purseRemainingCr < slotsToMin * 2.5 ? 'urgent' : 'advisory',
      text: `You need ${slotsToMin} more player${slotsToMin === 1 ? '' : 's'} to reach minimum squad (${ruleset.minSquadSize}) with ${formatCr(team.purseRemainingCr)} left.`,
    });
  }

  if (counts.wicketkeepers === 0 && counts.total >= 2) {
    suggestions.push({
      severity: 'urgent',
      text: 'Your squad still needs a specialist wicketkeeper-batter.',
    });
  }

  if (counts.deathBowlers === 0 && counts.total >= 4) {
    suggestions.push({
      severity: 'urgent',
      text: 'Your squad lacks a specialist death-over bowler for overs 16–20.',
    });
  }

  if (counts.finishers === 0 && counts.total >= 4) {
    suggestions.push({
      severity: 'advisory',
      text: 'Your team needs a reliable lower-order finisher.',
    });
  }

  if (counts.spinners === 0 && counts.total >= 5) {
    suggestions.push({
      severity: 'advisory',
      text: 'Consider strengthening your middle-over spin attack.',
    });
  }

  if (counts.allRounders < 2 && counts.total >= 6) {
    suggestions.push({
      severity: 'advisory',
      text: 'Add a versatile all-rounder to unlock 6 bowling options in your Playing XI.',
    });
  }

  if (counts.overseas >= ruleset.maxOverseasSquad - 1 && counts.total < ruleset.minSquadSize - 2) {
    suggestions.push({
      severity: 'urgent',
      text: `Overseas quota nearly full (${counts.overseas}/${ruleset.maxOverseasSquad}). Focus on Indian core talent.`,
    });
  }

  if (
    counts.batters >= 4 &&
    counts.fastBowlers >= 2 &&
    counts.spinners >= 1 &&
    counts.wicketkeepers >= 1
  ) {
    suggestions.push({
      severity: 'positive',
      text: 'Strong core spine assembled! Target high-value bench depth and impact players.',
    });
  }

  return { counts, suggestions: suggestions.slice(0, 4) };
}
