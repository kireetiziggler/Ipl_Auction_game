import { describe, expect, it } from 'vitest';
import { INITIAL_PLAYERS } from '../../data/players';
import { getPlayerRetentionCostCr } from '../../data/retentions';
import {
  formatSpokenPrice,
  FULL_IPL_SET_ORDER,
  getRulesetById,
  MIN_MATCH_SQUAD_SIZE,
  SEASON_RULESETS,
} from '../../data/rulesets';
import {
  applyRetentions,
  closeCurrentLot,
  createInitialAuctionState,
  formatPlayerIntroSpeech,
  pauseAuction,
  placeBid,
  respondToRtmFinalMatch,
  respondToRtmOffer,
  resumeAuction,
  startAuction,
  submitRtmCounter,
} from '../auctionStateMachine';
import { computeCardAttributes } from '../cardAttributes';
import { simulatePlayingXICompetition } from '../playingXICompetition';
import { computeSecretPlayerStrength, evaluateAllFranchises } from '../ratingEngine';
import {
  enableFastForwardCurrentLot,
  fillTeamToMinimumSquad,
  skipCurrentAuctionSet,
} from '../soloSkipEngine';
import { Player } from '../types';
import { DEFAULT_SETTINGS } from '../../services/storageService';
import { sanitizeForAuctionSpeech } from '../../services/voiceService';

const playerMap: Record<string, Player> = Object.fromEntries(
  INITIAL_PLAYERS.map((p) => [p.id, p])
);

describe('IPL 2027 Complete 307-Player Pool, All 12 Sets & Min 14 Rulesets', () => {
  it('contains all 307 players across all 12 official IPL auction sets with IPL 2027 team updates', () => {
    expect(INITIAL_PLAYERS.length).toBeGreaterThanOrEqual(307);
    const categories = new Set(INITIAL_PLAYERS.map((p) => p.category));
    for (const set of FULL_IPL_SET_ORDER) {
      expect(categories.has(set)).toBe(true);
    }
    // Verify key IPL 2027 franchise trade/retention updates
    expect(playerMap['arshdeep-singh']?.ipl2025Franchise).toBe('MI');
    expect(playerMap['sanju-samson']?.ipl2025Franchise).toBe('CSK');
    expect(playerMap['hardik-pandya']?.ipl2025Franchise).toBe('PBKS');
    expect(playerMap['rishabh-pant']?.ipl2025Franchise).toBe('DC');
    expect(playerMap['kuldeep-yadav']?.ipl2025Franchise).toBe('LSG');
  });

  it('has no duplicate player IDs', () => {
    const ids = INITIAL_PLAYERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes all 307 players (no maxPoolSize truncation) and enforces min 14 players on every ruleset', () => {
    expect(MIN_MATCH_SQUAD_SIZE).toBe(14);
    for (const r of SEASON_RULESETS) {
      expect(r.maxPoolSize).toBeUndefined();
      expect(r.minSquadSize).toBeGreaterThanOrEqual(14);
      expect(r.allowUnsoldReentry).toBe(true);
      expect(r.name).toContain('2027');
    }

    const quickState = createInitialAuctionState({
      roomId: 'test_full_pool',
      roomCode: 'ALL307',
      hostId: 'h1',
      hostName: 'Owner',
      hostFranchiseId: 'CSK',
      mode: 'QUICK',
      ruleset: getRulesetById('sim-2026-quick'),
      aiDifficulty: 'NORMAL',
      players: INITIAL_PLAYERS,
    });
    expect(quickState.playerQueue.length).toBe(INITIAL_PLAYERS.length);
  });
});

describe('Natural Auctioneer Speech & Pronunciation', () => {
  it('formats crores and lakhs naturally without currency symbols or abbreviations', () => {
    expect(formatSpokenPrice(2)).toBe('2 crores');
    expect(formatSpokenPrice(1)).toBe('1 crore');
    expect(formatSpokenPrice(5.5)).toBe('5 crore 50 lakhs');
    expect(formatSpokenPrice(0.75)).toBe('75 lakhs');
    expect(formatSpokenPrice(0.3)).toBe('30 lakhs');
  });

  it('sanitizes ₹ / Cr strings and expands franchise acronyms into natural spoken speech', () => {
    const cleaned = sanitizeForAuctionSpeech('CSK leads at ₹5.50 Cr over RCB at ₹75 L');
    expect(cleaned).not.toContain('₹');
    expect(cleaned).not.toMatch(/\bCr\b/);
    expect(cleaned).toContain('Chennai Super Kings');
    expect(cleaned).toContain('Royal Challengers Bengaluru');
    expect(cleaned).toContain('5 crore 50 lakhs');
    expect(cleaned).toContain('75 lakhs');
  });

  it('creates concise player introduction speech starting with "The next player is..."', () => {
    const kohli = playerMap['virat-kohli'];
    expect(kohli).toBeDefined();
    const intro = formatPlayerIntroSpeech(kohli);
    expect(intro).toBe('The next player is... Virat Kohli, Batsman from India. Base price 2 crores.');
  });

  it('schedules synchronized lotRevealAt and biddingOpensAt intervals on player nomination', () => {
    const ruleset = getRulesetById('ipl-2026-mega');
    const state = startAuction(
      createInitialAuctionState({
        roomId: 'test_reveal',
        roomCode: 'REV001',
        hostId: 'h1',
        hostName: 'Owner',
        hostFranchiseId: 'CSK',
        mode: 'SOLO',
        ruleset,
        aiDifficulty: 'NORMAL',
        players: INITIAL_PLAYERS,
      }),
      playerMap,
      50000
    );
    expect(state.lotRevealAt).toBeGreaterThan(50000);
    expect(state.biddingOpensAt).toBeGreaterThan(state.lotRevealAt!);
    expect(state.countdownEndsAt).toBeGreaterThan(state.biddingOpensAt!);
  });
});

describe('Pre-Auction Retentions, Purse Deduction & Real 3-Stage IPL RTM', () => {
  it('deducts exact IPL 2026 retention prices, removes retained players from queue, and sets RTM = 6 - retained', () => {
    const ruleset = getRulesetById('ipl-2026-mega');
    const state = createInitialAuctionState({
      roomId: 'test_ret_1',
      roomCode: 'TEST01',
      hostId: 'host_1',
      hostName: 'Test Owner',
      hostFranchiseId: 'RCB',
      mode: 'SOLO',
      ruleset,
      aiDifficulty: 'NORMAL',
      players: INITIAL_PLAYERS,
    });

    const kohli = playerMap['virat-kohli'];
    const patidar = playerMap['rajat-patidar'];
    const expectedCost = getPlayerRetentionCostCr(kohli) + getPlayerRetentionCostCr(patidar);

    const afterRet = applyRetentions(
      state,
      { RCB: ['virat-kohli', 'rajat-patidar'], CSK: [] },
      playerMap,
      1000
    );

    expect(afterRet.teams.RCB.squad.length).toBe(2);
    expect(afterRet.teams.RCB.squad.every((s) => s.isRetained)).toBe(true);
    expect(afterRet.teams.RCB.purseRemainingCr).toBeCloseTo(
      ruleset.initialPurseCr - expectedCost,
      2
    );
    expect(afterRet.teams.RCB.rtmRemaining).toBe(4); // 6 - 2 retained
    expect(afterRet.teams.CSK.rtmRemaining).toBe(6); // 6 - 0 retained
    expect(afterRet.playerQueue).not.toContain('virat-kohli');
    expect(afterRet.playerQueue).not.toContain('rajat-patidar');
  });

  it('executes the full 3-stage IPL RTM workflow (OFFER -> COUNTER -> FINAL_MATCH -> SOLD via RTM)', () => {
    const ruleset = getRulesetById('ipl-2026-mega');
    const initial = createInitialAuctionState({
      roomId: 'test_rtm_1',
      roomCode: 'TEST02',
      hostId: 'host_1',
      hostName: 'Owner',
      hostFranchiseId: 'CSK',
      mode: 'SOLO',
      ruleset,
      aiDifficulty: 'NORMAL',
      players: INITIAL_PLAYERS,
    });

    // Clear retentions for RCB and CSK so Virat Kohli (former RCB) enters the live pool and RCB has 6 RTMs
    const retained = applyRetentions(initial, { RCB: [], CSK: [] }, playerMap, 1000);
    let live = startAuction(retained, playerMap, 2000);
    // Force Virat Kohli onto the block cleanly
    live = {
      ...live,
      currentPlayerId: 'virat-kohli',
      phase: 'OPENING_BID',
      hasOpeningBid: false,
      currentBidCr: playerMap['virat-kohli'].basePriceCr,
      currentBidderId: null,
    };

    const bidRes = placeBid(live, 'CSK', playerMap['virat-kohli'], {
      proposedAmountCr: 10,
      isAI: false,
      now: 3000,
    });
    expect(bidRes.accepted).toBe(true);

    // Close lot -> should trigger RTM_OFFER for RCB (former franchise)
    const stage1 = closeCurrentLot(bidRes.state, playerMap, 4000);
    expect(stage1.phase).toBe('RTM_OFFER');
    expect(stage1.rtmState?.rtmFranchiseId).toBe('RCB');
    expect(stage1.rtmState?.winningFranchiseId).toBe('CSK');

    // Stage 1: RCB invokes RTM -> CSK gets 1 counter-bid
    const stage2 = respondToRtmOffer(stage1, true, playerMap, 5000);
    expect(stage2.phase).toBe('RTM_COUNTER');

    // Stage 2: CSK counters at 12 Cr -> RCB gets final match decision
    const stage3 = submitRtmCounter(stage2, 12, playerMap, 6000);
    expect(stage3.phase).toBe('RTM_FINAL_MATCH');
    expect(stage3.rtmState?.counterBidCr).toBe(12);

    // Stage 3: RCB matches 12 Cr -> Sold to RCB via RTM, RTM card decremented
    const sold = respondToRtmFinalMatch(stage3, true, playerMap, 7000);
    expect(sold.phase).toBe('SOLD');
    expect(sold.teams.RCB.rtmRemaining).toBe(5);
    const bought = sold.teams.RCB.squad.find((s) => s.playerId === 'virat-kohli');
    expect(bought?.boughtPriceCr).toBe(12);
    expect(bought?.acquiredViaRTM).toBe(true);
  });
});

describe('Exact Pause & Resume State Preservation', () => {
  it('preserves exact phase, lot, bid, bidder, and remaining milliseconds on pause and resume', () => {
    const ruleset = getRulesetById('ipl-2026-mega');
    const state = startAuction(
      createInitialAuctionState({
        roomId: 'test_pause',
        roomCode: 'PAUSE1',
        hostId: 'h1',
        hostName: 'Owner',
        hostFranchiseId: 'MI',
        mode: 'SOLO',
        ruleset,
        aiDifficulty: 'NORMAL',
        players: INITIAL_PLAYERS,
      }),
      playerMap,
      10000
    );

    const activePlayer = playerMap[state.currentPlayerId!];
    const bidRes = placeBid(state, 'MI', activePlayer, { now: 12000 });
    const prePause = { ...bidRes.state, countdownEndsAt: 20000 };

    const paused = pauseAuction(prePause, 15500);
    expect(paused.phase).toBe('PAUSED');
    expect(paused.pausedFromPhase).toBe('BIDDING');
    expect(paused.pausedRemainingMs).toBe(4500);
    expect(paused.currentPlayerId).toBe(activePlayer.id);
    expect(paused.currentBidderId).toBe('MI');

    const resumed = resumeAuction(paused, 90000);
    expect(resumed.phase).toBe('BIDDING');
    expect(resumed.countdownEndsAt).toBe(94500);
    expect(resumed.currentPlayerId).toBe(activePlayer.id);
    expect(resumed.currentBidderId).toBe('MI');
  });
});

describe('Deterministic Secret Stat-Based Strength & Leaderboard', () => {
  it('computes 100% deterministic secret player strength from real career stats with zero randomness', () => {
    const bumrah = playerMap['jasprit-bumrah'];
    const s1 = computeSecretPlayerStrength(bumrah);
    const s2 = computeSecretPlayerStrength(bumrah);
    expect(s1).toStrictEqual(s2);
    expect(s1.winImpact).toBeGreaterThan(75);
    expect(s1.winImpact).toBeLessThanOrEqual(99);
  });

  it('produces identical deterministic team win percentages on repeated evaluations', () => {
    const ruleset = getRulesetById('ipl-2026-mega');
    const state = applyRetentions(
      createInitialAuctionState({
        roomId: 'test_det',
        roomCode: 'DET001',
        hostId: 'h1',
        hostName: 'Owner',
        hostFranchiseId: 'CSK',
        mode: 'SOLO',
        ruleset,
        aiDifficulty: 'NORMAL',
        players: INITIAL_PLAYERS,
      }),
      {},
      playerMap,
      1000
    );

    const r1 = evaluateAllFranchises(state, playerMap, DEFAULT_SETTINGS.ratingWeights);
    const r2 = evaluateAllFranchises(state, playerMap, DEFAULT_SETTINGS.ratingWeights);
    expect(r1.CSK.winPercentage).toBe(r2.CSK.winPercentage);
    expect(r1.MI.winPercentage).toBe(r2.MI.winPercentage);
  });

  it('assigns Gold, Silver, and Bronze tiers with 6 deterministic cricket card attributes', () => {
    const kohli = computeCardAttributes(playerMap['virat-kohli']);
    expect(kohli.tier).toBe('GOLD');
    expect(kohli.roleCode).toBe('BAT');
    expect(kohli.bat).toBeGreaterThanOrEqual(90);
    expect(kohli.run).toBeGreaterThanOrEqual(70);

    const tiers = new Set(INITIAL_PLAYERS.map((p) => computeCardAttributes(p).tier));
    expect(tiers.has('GOLD')).toBe(true);
    expect(tiers.has('SILVER')).toBe(true);
    expect(tiers.has('BRONZE')).toBe(true);
  });

  it('simulates a complete deterministic 9-round (45-match) Playing XI Championship League', () => {
    const ruleset = getRulesetById('ipl-2026-mega');
    const state = applyRetentions(
      createInitialAuctionState({
        roomId: 'test_league',
        roomCode: 'LGE001',
        hostId: 'h1',
        hostName: 'Owner',
        hostFranchiseId: 'RCB',
        mode: 'SOLO',
        ruleset,
        aiDifficulty: 'NORMAL',
        players: INITIAL_PLAYERS,
      }),
      {},
      playerMap,
      1000
    );

    const sim1 = simulatePlayingXICompetition(state, playerMap, 'RCB', []);
    const sim2 = simulatePlayingXICompetition(state, playerMap, 'RCB', []);
    expect(sim1.matches.length).toBe(45);
    expect(sim1.userMatches.length).toBe(9);
    expect(sim1.standings.length).toBe(10);
    expect(sim1.championId).toBe(sim2.championId);
    expect(sim1.standings[0].rank).toBe(1);
    expect(sim1.standings[0].played).toBe(9);
  });
});

describe('Solo-Only 4x Skip Player, Skip Set & Minimum 14 Squad Enforcement', () => {
  it('enables 4x fast-forward in SOLO mode and blocks it completely in MULTIPLAYER mode', () => {
    const ruleset = getRulesetById('sim-2026-mega');
    const soloLive = startAuction(
      createInitialAuctionState({
        roomId: 'test_skip_solo',
        roomCode: 'SKP001',
        hostId: 'h1',
        hostName: 'Owner',
        hostFranchiseId: 'CSK',
        mode: 'SOLO',
        ruleset,
        aiDifficulty: 'NORMAL',
        players: INITIAL_PLAYERS,
      }),
      playerMap,
      50000
    );

    const fastSolo = enableFastForwardCurrentLot(soloLive, 'CSK', 50100);
    expect(fastSolo.fastForwardCurrentLot).toBe(true);
    expect(fastSolo.teams.CSK.passedCurrentPlayer).toBe(true);

    const mpLive = { ...soloLive, mode: 'MULTIPLAYER' as const };
    const mpResult = enableFastForwardCurrentLot(mpLive, 'CSK', 50100);
    expect(mpResult.fastForwardCurrentLot).toBeFalsy();
  });

  it('skips the entire current set cleanly to the next set in SOLO and is a no-op in MULTIPLAYER', () => {
    const ruleset = getRulesetById('sim-2026-mega');
    const soloLive = startAuction(
      applyRetentions(
        createInitialAuctionState({
          roomId: 'test_skip_set',
          roomCode: 'SET001',
          hostId: 'h1',
          hostName: 'Owner',
          hostFranchiseId: 'CSK',
          mode: 'SOLO',
          ruleset,
          aiDifficulty: 'NORMAL',
          players: INITIAL_PLAYERS,
        }),
        {},
        playerMap,
        1000
      ),
      playerMap,
      2000
    );

    const initialCategory = playerMap[soloLive.currentPlayerId!].category;
    const mpSkipped = skipCurrentAuctionSet(
      { ...soloLive, mode: 'MULTIPLAYER' },
      'CSK',
      playerMap,
      3000
    );
    expect(mpSkipped.skippedCategory).toBeNull();
    expect(mpSkipped.state.currentPlayerId).toBe(soloLive.currentPlayerId);

    const skipped = skipCurrentAuctionSet(soloLive, 'CSK', playerMap, 3000);
    expect(skipped.skippedCategory).toBe(initialCategory);
    expect(skipped.soldCount + skipped.unsoldCount).toBeGreaterThan(0);
    expect(skipped.nextCategory).not.toBe(initialCategory);
    expect(skipped.state.fastForwardCurrentLot).toBe(false);
  });

  it('auto-drafts missing players from unsold pool so a team under 14 reaches exactly 14 players', () => {
    const ruleset = getRulesetById('sim-2026-mega');
    const state = applyRetentions(
      createInitialAuctionState({
        roomId: 'test_min14',
        roomCode: 'MIN014',
        hostId: 'h1',
        hostName: 'Owner',
        hostFranchiseId: 'CSK',
        mode: 'SOLO',
        ruleset,
        aiDifficulty: 'NORMAL',
        players: INITIAL_PLAYERS,
      }),
      {},
      playerMap,
      1000
    );

    expect(state.teams.CSK.squad.length).toBeLessThan(14);
    const filled = fillTeamToMinimumSquad(state, 'CSK', playerMap, MIN_MATCH_SQUAD_SIZE, 2000);
    expect(filled.teams.CSK.squad.length).toBe(14);
  });
});

