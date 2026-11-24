import { FRANCHISE_MAP } from '../data/franchises';
import {
  decideAIRTMCounterBid,
  decideAIRTMFinalMatch,
  decideAIRTMOffer,
  selectNextAIBidder,
} from './aiEngine';
import {
  closeCurrentLot,
  completeAuction,
  nominateNextPlayer,
  placeBid,
  respondToRtmFinalMatch,
  respondToRtmOffer,
  resumeAuction,
  submitRtmCounter,
} from './auctionStateMachine';
import { AuctionCategory, AuctionState, FranchiseId, Player } from './types';

/**
 * Enables 4x fast-forward on the currently active lot (SOLO ONLY).
 * - Immediately clears reveal / intro hold delays.
 * - Marks the human franchise as passed (unless currently winning) so AI rivals resolve the lot at 4x tempo.
 * - Automatically resets to 1x when the next player is nominated.
 */
export function enableFastForwardCurrentLot(
  state: AuctionState,
  userFranchiseId: FranchiseId,
  now = Date.now()
): AuctionState {
  if (state.mode === 'MULTIPLAYER') return state;
  let next = state.phase === 'PAUSED' ? resumeAuction(state, now) : state;

  if (
    next.phase !== 'OPENING_BID' &&
    next.phase !== 'BIDDING' &&
    next.phase !== 'COUNTDOWN'
  ) {
    return next;
  }

  const teams = { ...next.teams };
  if (next.currentBidderId !== userFranchiseId && teams[userFranchiseId]) {
    teams[userFranchiseId] = {
      ...teams[userFranchiseId],
      passedCurrentPlayer: true,
      lastActionNote: 'Skipped (4x)',
    };
  }

  return {
    ...next,
    teams,
    fastForwardCurrentLot: true,
    lotRevealAt: undefined,
    biddingOpensAt: undefined,
    countdownEndsAt: Math.min(next.countdownEndsAt ?? now + 1800, now + 1800),
    countdownRemainingSec: Math.min(next.countdownRemainingSec, 2),
    updatedAt: now,
  };
}

export interface SkipSetResult {
  state: AuctionState;
  skippedCategory: AuctionCategory | null;
  soldCount: number;
  unsoldCount: number;
  nextCategory: AuctionCategory | null;
}

/**
 * Skips the current player and all remaining players in the SAME auction set (SOLO ONLY).
 * Rival AI teams realistically bid/pass/use RTM on skipped players; unclaimed players go UNSOLD.
 * Stops cleanly on the very first player of the NEXT set (or completes the auction if it was the last set).
 */
export function skipCurrentAuctionSet(
  state: AuctionState,
  userFranchiseId: FranchiseId,
  playerMap: Record<string, Player>,
  now = Date.now()
): SkipSetResult {
  if (state.mode === 'MULTIPLAYER') {
    return {
      state,
      skippedCategory: null,
      soldCount: 0,
      unsoldCount: 0,
      nextCategory: null,
    };
  }

  let sim: AuctionState =
    state.phase === 'PAUSED' ? resumeAuction(state, now) : { ...state, teams: { ...state.teams } };

  const currentPlayer = sim.currentPlayerId ? playerMap[sim.currentPlayerId] : null;
  const targetCategory: AuctionCategory | null =
    currentPlayer?.category ??
    (sim.playerQueue[0] ? playerMap[sim.playerQueue[0]]?.category ?? null : null);

  if (!targetCategory) {
    return {
      state: sim,
      skippedCategory: null,
      soldCount: 0,
      unsoldCount: 0,
      nextCategory: null,
    };
  }

  let soldCount = 0;
  let unsoldCount = 0;
  let safety = 0;
  let tick = now;

  // Resolve current lot (if belonging to targetCategory) and every remaining player in targetCategory
  while (sim.phase !== 'COMPLETED' && safety < 140) {
    safety++;
    tick += 40;

    // Resolve any pending RTM stage automatically via AI rules
    if (sim.phase === 'RTM_OFFER' && sim.rtmState) {
      const p = playerMap[sim.rtmState.playerId];
      const useRtm =
        p && sim.rtmState.rtmFranchiseId !== userFranchiseId
          ? decideAIRTMOffer(sim, sim.rtmState.rtmFranchiseId, p, sim.rtmState.initialBidCr, playerMap)
          : false;
      sim = respondToRtmOffer(sim, useRtm, playerMap, tick);
      if (sim.phase === 'SOLD') soldCount++;
      continue;
    }
    if (sim.phase === 'RTM_COUNTER' && sim.rtmState) {
      const p = playerMap[sim.rtmState.playerId];
      const counter =
        p && sim.rtmState.winningFranchiseId !== userFranchiseId
          ? decideAIRTMCounterBid(
              sim,
              sim.rtmState.winningFranchiseId,
              p,
              sim.rtmState.initialBidCr,
              playerMap
            )
          : null;
      sim = submitRtmCounter(sim, counter, playerMap, tick);
      if (sim.phase === 'SOLD') soldCount++;
      continue;
    }
    if (sim.phase === 'RTM_FINAL_MATCH' && sim.rtmState) {
      const p = playerMap[sim.rtmState.playerId];
      const match =
        p && sim.rtmState.rtmFranchiseId !== userFranchiseId
          ? decideAIRTMFinalMatch(
              sim,
              sim.rtmState.rtmFranchiseId,
              p,
              sim.rtmState.counterBidCr ?? sim.rtmState.initialBidCr,
              playerMap
            )
          : false;
      sim = respondToRtmFinalMatch(sim, match, playerMap, tick);
      if (sim.phase === 'SOLD') soldCount++;
      continue;
    }

    // If current lot already settled, nominate next
    if (sim.phase === 'SOLD' || sim.phase === 'UNSOLD' || !sim.currentPlayerId) {
      const nextQueued = sim.playerQueue[0] ? playerMap[sim.playerQueue[0]] : null;
      if (nextQueued && nextQueued.category !== targetCategory) {
        // Reached the start of the NEXT set! Nominate cleanly at normal 1x speed and stop.
        sim = nominateNextPlayer(sim, playerMap, tick);
        break;
      }
      sim = nominateNextPlayer(sim, playerMap, tick);
      if (sim.phase === 'COMPLETED') break;
      const nominated = sim.currentPlayerId ? playerMap[sim.currentPlayerId] : null;
      if (nominated && nominated.category !== targetCategory) {
        // Crossed into the next set (or re-entry round with different category) -> stop here!
        break;
      }
      continue;
    }

    const activePlayer = playerMap[sim.currentPlayerId];
    if (!activePlayer) {
      sim = closeCurrentLot(sim, playerMap, tick);
      continue;
    }

    if (activePlayer.category !== targetCategory) {
      // Already on the next set!
      break;
    }

    // Mark human team as passed on this skipped set player (unless already leading)
    if (sim.currentBidderId !== userFranchiseId) {
      sim = {
        ...sim,
        teams: {
          ...sim.teams,
          [userFranchiseId]: {
            ...sim.teams[userFranchiseId],
            passedCurrentPlayer: true,
          },
        },
      };
    }

    // Let AI franchises bid naturally among themselves (or leave unsold if nobody wants them)
    let rounds = 0;
    while (rounds < 24) {
      rounds++;
      const decision = selectNextAIBidder(sim, playerMap);
      if (!decision) break;
      const res = placeBid(sim, decision.franchiseId, activePlayer, {
        proposedAmountCr: decision.bidAmountCr,
        isAI: true,
        aiReason: decision.reason,
        now: tick + rounds,
      });
      if (!res.accepted) break;
      sim = res.state;
    }

    sim = closeCurrentLot(sim, playerMap, tick + 30);
    if (sim.phase === 'SOLD') soldCount++;
    else if (sim.phase === 'UNSOLD') unsoldCount++;
    // If RTM_OFFER triggered, next loop iteration resolves it automatically
  }

  // Ensure human team's passed flag is clean for the newly nominated next-set player
  if (sim.phase !== 'COMPLETED' && sim.teams[userFranchiseId]) {
    const nextPlayer = sim.currentPlayerId ? playerMap[sim.currentPlayerId] : null;
    sim = {
      ...sim,
      fastForwardCurrentLot: false,
      teams: {
        ...sim.teams,
        [userFranchiseId]: {
          ...sim.teams[userFranchiseId],
          passedCurrentPlayer: false,
        },
      },
      lastAnnouncement: nextPlayer
        ? `Skipped ${targetCategory}. Moving to ${nextPlayer.category}: ${sim.lastAnnouncement}`
        : sim.lastAnnouncement,
    };
  }

  const nextCategory =
    sim.currentPlayerId && playerMap[sim.currentPlayerId]
      ? playerMap[sim.currentPlayerId].category
      : null;

  return {
    state: sim,
    skippedCategory: targetCategory,
    soldCount,
    unsoldCount,
    nextCategory,
  };
}

/**
 * Auto-drafts remaining players from the unsold pool (or cheapest remaining players)
 * so any team below the mandatory 14-player minimum reaches 14 players cleanly.
 */
export function fillTeamToMinimumSquad(
  state: AuctionState,
  franchiseId: FranchiseId,
  playerMap: Record<string, Player>,
  minRequired = 14,
  now = Date.now()
): AuctionState {
  const team = state.teams[franchiseId];
  if (!team || team.squad.length >= minRequired) return state;

  const ownedGlobal = new Set<string>();
  for (const t of Object.values(state.teams)) {
    for (const sp of t.squad) ownedGlobal.add(sp.playerId);
  }

  // Prefer unsold players + remaining queued players sorted by base price ascending then overall descending
  const candidateIds = [
    ...state.unsoldPool,
    ...state.playerQueue,
    ...Object.keys(playerMap),
  ].filter((id, idx, arr) => arr.indexOf(id) === idx && !ownedGlobal.has(id));

  const candidates = candidateIds
    .map((id) => playerMap[id])
    .filter((p): p is Player => Boolean(p))
    .sort((a, b) => a.basePriceCr - b.basePriceCr || b.ratings.overall - a.ratings.overall);

  let purse = team.purseRemainingCr;
  let spent = team.totalSpentCr;
  let overseasCount = team.overseasCount;
  const squad = [...team.squad];
  const events = [...state.events];
  const addedIds = new Set<string>();

  for (const p of candidates) {
    if (squad.length >= minRequired) break;
    if (p.isOverseas && overseasCount >= state.ruleset.maxOverseasSquad) continue;
    const priceCr = Math.min(p.basePriceCr, Math.max(0.3, Math.round(purse * 100) / 100));
    if (purse < 0.3 && p.basePriceCr > purse) {
      // Allow base sign at 0.30 Cr minimum if purse is depleted during emergency squad fill
      purse = Math.max(0, Math.round((purse - Math.min(purse, 0.3)) * 100) / 100);
    } else {
      const finalPrice = Math.min(p.basePriceCr, purse);
      purse = Math.max(0, Math.round((purse - finalPrice) * 100) / 100);
      spent = Math.round((spent + finalPrice) * 100) / 100;
    }
    if (p.isOverseas) overseasCount++;
    squad.push({
      playerId: p.id,
      boughtPriceCr: priceCr,
      boughtAt: now,
      round: state.reentryRound ? 2 : 1,
    });
    addedIds.add(p.id);
    events.push({
      id: `evt_fill_${now.toString(36)}_${squad.length}`,
      type: 'PLAYER_SOLD',
      timestamp: now,
      playerId: p.id,
      franchiseId,
      amountCr: priceCr,
      message: `ACCELERATED SIGNING: ${FRANCHISE_MAP[franchiseId].shortName} signed ${p.name} at base price`,
    });
  }

  return {
    ...state,
    teams: {
      ...state.teams,
      [franchiseId]: {
        ...team,
        purseRemainingCr: purse,
        totalSpentCr: spent,
        overseasCount,
        squad,
      },
    },
    unsoldPool: state.unsoldPool.filter((id) => !addedIds.has(id)),
    playerQueue: state.playerQueue.filter((id) => !addedIds.has(id)),
    events,
    updatedAt: now,
  };
}

export { completeAuction };
