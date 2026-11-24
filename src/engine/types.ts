export type FranchiseId =
  | 'CSK'
  | 'MI'
  | 'RCB'
  | 'KKR'
  | 'SRH'
  | 'RR'
  | 'DC'
  | 'PBKS'
  | 'GT'
  | 'LSG';

export type AIPersonality =
  | 'AGGRESSIVE_BIDDER'
  | 'VALUE_STRATEGIST'
  | 'BATTING_SPECIALIST'
  | 'BOWLING_SPECIALIST'
  | 'ALL_ROUNDER_SPECIALIST'
  | 'YOUTH_STRATEGIST'
  | 'SUPERSTAR_COLLECTOR'
  | 'BUDGET_STRATEGIST'
  | 'BALANCED_STRATEGIST';

export type AIDifficulty = 'EASY' | 'NORMAL' | 'HARD' | 'EXPERT';

export type PrimaryRole =
  | 'Batter'
  | 'Wicketkeeper'
  | 'All-rounder'
  | 'Fast Bowler'
  | 'Spinner';

export type RoleSpecialty =
  | 'Top-order Batter'
  | 'Middle-order Batter'
  | 'Finisher'
  | 'Wicketkeeper-Batter'
  | 'Pace All-rounder'
  | 'Spin All-rounder'
  | 'Fast Bowler'
  | 'Swing Bowler'
  | 'Death-over Specialist'
  | 'Powerplay Specialist'
  | 'Leg Spinner'
  | 'Off Spinner'
  | 'Left-arm Spinner';

export type AuctionCategory =
  | 'Marquee Set 1'
  | 'Marquee Set 2'
  | 'Capped Batters'
  | 'Capped All-Rounders'
  | 'Capped Wicketkeepers'
  | 'Capped Fast Bowlers'
  | 'Capped Spinners'
  | 'Uncapped Batters'
  | 'Uncapped All-Rounders'
  | 'Uncapped Wicketkeepers'
  | 'Uncapped Fast Bowlers'
  | 'Uncapped Spinners'
  // Legacy compatibility labels for imported custom CSV/JSON pools
  | 'Marquee'
  | 'Batters'
  | 'All-Rounders'
  | 'Wicketkeepers'
  | 'Fast Bowlers'
  | 'Spinners'
  | 'Emerging Stars';

export type GameMode =
  | 'SOLO'
  | 'MULTIPLAYER'
  | 'QUICK'
  | 'FULL'
  | 'PRACTICE'
  | 'TOURNAMENT';

export type AuctionPhase =
  | 'LOBBY'
  | 'RETENTION'
  | 'READY'
  | 'STARTING'
  | 'NOMINATION'
  | 'OPENING_BID'
  | 'BIDDING'
  | 'COUNTDOWN'
  | 'RTM_OFFER'
  | 'RTM_COUNTER'
  | 'RTM_FINAL_MATCH'
  | 'SOLD'
  | 'UNSOLD'
  | 'NEXT_PLAYER'
  | 'PAUSED'
  | 'COMPLETED';

export type NominationMode = 'SET_ORDER' | 'MANAGER_NOMINATION';

export interface FranchiseConfig {
  id: FranchiseId;
  name: string;
  shortName: string;
  city: string;
  homeVenue: string;
  primaryColor: string;
  secondaryColor: string;
  accentText: string;
  ownerPersona: string;
  strategyLabel: string;
  aiPersonality: AIPersonality;
  preferredRoles: PrimaryRole[];
  riskTolerance: number;
  description: string;
}

export interface PlayerSeasonStat {
  season: number;
  team: string;
  matches: number;
  runs: number;
  strikeRate: number;
  wickets: number;
  economy: number;
}

export interface PlayerCareerStats {
  matches: number;
  runs: number;
  battingAvg: number;
  strikeRate: number;
  highestScore: string;
  fifties: number;
  hundreds: number;
  wickets: number;
  bowlingAvg: number;
  economy: number;
  bowlingStrikeRate: number;
  bestBowling: string;
  catches: number;
}

/** Internal AI valuation & hidden competition ratings (never exposed as OVR on auction cards) */
export interface PlayerGameRatings {
  overall: number;
  batting: number;
  bowling: number;
  fielding: number;
  form: number;
  potential: number;
  captaincy: number;
  estimatedValueCr: number;
}

export interface Player {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  isOverseas: boolean;
  isCapped: boolean;
  age: number;
  battingStyle: 'Right-hand bat' | 'Left-hand bat';
  bowlingStyle: string;
  primaryRole: PrimaryRole;
  secondaryRole: RoleSpecialty;
  specialtyTags: string[];
  previousFranchises: string[];
  ipl2025Franchise?: FranchiseId;
  ipl2026RetentionPriceCr?: number;
  category: AuctionCategory;
  basePriceCr: number;
  jerseyNumber: number;
  portraitUrl?: string;
  stats: PlayerCareerStats;
  recentSeasons: PlayerSeasonStat[];
  strengths: string[];
  weaknesses: string[];
  ratings: PlayerGameRatings;
  dataSource: string;
  lastUpdated: string;
}

export interface BidIncrementTier {
  upToCr: number;
  incrementCr: number;
}

export interface SeasonRuleset {
  id: string;
  name: string;
  seasonLabel: string;
  isOfficialVerified: boolean;
  disclaimerLabel: string;
  initialPurseCr: number;
  minSquadSize: number;
  maxSquadSize: number;
  maxOverseasSquad: number;
  maxOverseasPlayingXI: number;
  minWicketkeepers: number;
  minBowlers: number;
  minBatters: number;
  bidTimerSeconds: number;
  goingOnceAtSeconds: number;
  goingTwiceAtSeconds: number;
  allowUnsoldReentry: boolean;
  allowRTM: boolean;
  rtmCardsPerTeam: number;
  maxRetentionsPerTeam: number;
  bidIncrements: BidIncrementTier[];
  categoryOrder: AuctionCategory[];
  maxPoolSize?: number;
}

export interface SquadPlayer {
  playerId: string;
  boughtPriceCr: number;
  boughtAt: number;
  round: number;
  isRetained?: boolean;
  acquiredViaRTM?: boolean;
}

export interface TeamState {
  franchiseId: FranchiseId;
  controllerType: 'HUMAN' | 'AI';
  ownerId?: string;
  ownerName: string;
  isConnected: boolean;
  isReady: boolean;
  purseRemainingCr: number;
  totalSpentCr: number;
  squad: SquadPlayer[];
  overseasCount: number;
  rtmRemaining: number;
  aiPersonality: AIPersonality;
  passedCurrentPlayer: boolean;
  lastActionNote?: string;
}

export interface BidRecord {
  id: string;
  requestId: string;
  playerId: string;
  franchiseId: FranchiseId;
  amountCr: number;
  timestamp: number;
  isAI: boolean;
  aiReason?: string;
}

export interface RTMState {
  playerId: string;
  rtmFranchiseId: FranchiseId;
  winningFranchiseId: FranchiseId;
  initialBidCr: number;
  counterBidCr?: number;
  stage: 'OFFER' | 'COUNTER' | 'FINAL_MATCH';
}

export interface AuctionEvent {
  id: string;
  type:
    | 'AUCTION_START'
    | 'PLAYER_RETAINED'
    | 'PLAYER_NOMINATED'
    | 'BID_PLACED'
    | 'TEAM_PASSED'
    | 'GOING_ONCE'
    | 'GOING_TWICE'
    | 'RTM_TRIGGERED'
    | 'RTM_COUNTERED'
    | 'RTM_USED'
    | 'RTM_DECLINED'
    | 'PLAYER_SOLD'
    | 'PLAYER_UNSOLD'
    | 'REENTRY_START'
    | 'AUCTION_PAUSED'
    | 'AUCTION_RESUMED'
    | 'AUCTION_COMPLETED';
  timestamp: number;
  playerId?: string;
  franchiseId?: FranchiseId;
  amountCr?: number;
  message: string;
  aiReason?: string;
}

export interface ParticipantPsychology {
  franchiseId: FranchiseId;
  bidsPlaced: number;
  aggressiveBids: number;
  roleInterest: Record<PrimaryRole, number>;
  avgBidOverEstimate: number;
  recentWithdrawals: number;
}

export interface AuctionState {
  roomId: string;
  roomCode: string;
  hostId: string;
  mode: GameMode;
  phase: AuctionPhase;
  ruleset: SeasonRuleset;
  aiDifficulty: AIDifficulty;
  nominationMode: NominationMode;
  auctionSpeed: 'NORMAL' | 'FAST' | 'BLITZ';
  teams: Record<FranchiseId, TeamState>;
  playerQueue: string[];
  unsoldPool: string[];
  reentryRound: boolean;
  currentPlayerIndex: number;
  currentPlayerId: string | null;
  currentBidCr: number;
  currentBidderId: FranchiseId | null;
  hasOpeningBid: boolean;
  countdownEndsAt: number | null;
  countdownRemainingSec: number;
  lotRevealAt?: number;
  biddingOpensAt?: number;
  fastForwardCurrentLot?: boolean;
  pausedFromPhase?: AuctionPhase;
  pausedRemainingMs?: number;
  rtmState?: RTMState | null;
  retentionsApplied?: boolean;
  lastAnnouncement: string;
  bidHistory: BidRecord[];
  allBids: BidRecord[];
  events: AuctionEvent[];
  psychology: Record<FranchiseId, ParticipantPsychology>;
  processedRequestIds: string[];
  createdAt: number;
  updatedAt: number;
  tournamentId?: string;
  tournamentRound?: number;
}

export interface RatingWeights {
  batting: number;
  bowling: number;
  allRounders: number;
  balance: number;
  overseasBalance: number;
  squadDepth: number;
  budgetEfficiency: number;
}

export interface TeamRatingBreakdown {
  franchiseId: FranchiseId;
  overallScore: number; // 0-100 deterministic team score / win probability index
  winPercentage: number; // 0-100 deterministic hidden stat-based XI competition win strength
  battingScore: number;
  bowlingScore: number;
  allRoundScore: number;
  fieldingScore: number;
  balanceScore: number;
  overseasScore: number;
  depthScore: number;
  budgetEfficiencyScore: number;
  weightedPoints: {
    batting: number;
    bowling: number;
    allRounders: number;
    balance: number;
    overseasBalance: number;
    squadDepth: number;
    budgetEfficiency: number;
  };
  strengths: string[];
  weaknesses: string[];
  summary: string;
  awards: {
    highestPriced?: { player: Player; priceCr: number };
    bestBargain?: { player: Player; priceCr: number; valueGapCr: number };
    bestIndian?: { player: Player; priceCr: number };
    bestOverseas?: { player: Player; priceCr: number };
    bestBatter?: { player: Player; priceCr: number };
    bestBowler?: { player: Player; priceCr: number };
    bestAllRounder?: { player: Player; priceCr: number };
  };
}

export type PlayingXIPreset =
  | 'BALANCED'
  | 'BATTING_HEAVY'
  | 'BOWLING_HEAVY'
  | 'SPIN_FOCUSED'
  | 'PACE_FOCUSED';

export interface PlayingXISlot {
  order: number;
  player: Player;
  priceCr: number;
  roleLabel: string;
  selectionReason: string;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isWicketkeeper: boolean;
}

export interface PlayingXIConfig {
  preset: PlayingXIPreset;
  starters: PlayingXISlot[];
  impactPlayer: { player: Player; reason: string } | null;
  bench: Player[];
  overseasCount: number;
  isValid: boolean;
  validationErrors: string[];
  bowlingOptionsCount: number;
  xiRating: number;
}

export interface SavedAuction {
  id: string;
  roomCode: string;
  completedAt: number;
  mode: GameMode;
  rulesetName: string;
  aiDifficulty: AIDifficulty;
  userFranchiseId: FranchiseId;
  winnerFranchiseId: FranchiseId;
  userScore: number;
  winnerScore: number;
  userRank: number;
  stateSnapshot: AuctionState;
  ratings: Record<FranchiseId, TeamRatingBreakdown>;
  userPlayingXIIds?: string[];
}

export interface TournamentRoundResult {
  roundNumber: number;
  auctionId: string;
  completedAt: number;
  standings: {
    franchiseId: FranchiseId;
    ownerName: string;
    squadRating: number;
    budgetPoints: number;
    strategyPoints: number;
    totalRoundPoints: number;
    rank: number;
  }[];
}

export interface Tournament {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  totalRounds: number;
  currentRound: number;
  rulesetId: string;
  aiDifficulty: AIDifficulty;
  userFranchiseId: FranchiseId;
  status: 'ACTIVE' | 'COMPLETED';
  rounds: TournamentRoundResult[];
  cumulativeScores: Record<
    FranchiseId,
    {
      franchiseId: FranchiseId;
      ownerName: string;
      totalPoints: number;
      avgRating: number;
      roundsWon: number;
    }
  >;
}

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  photoURL?: string;
  isGuest: boolean;
  authProvider?: 'guest' | 'google' | 'local';
  favoriteFranchise: FranchiseId;
  avatarColor: string;
  stats: {
    auctionsPlayed: number;
    auctionsWon: number;
    bestRating: number;
    avgRating: number;
    tournamentsWon: number;
  };
}

export interface GameSettings {
  theme: 'dark' | 'light';
  voiceEnabled: boolean;
  voiceVolume: number;
  voiceSpeed: number;
  captionsEnabled: boolean;
  sfxEnabled: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicEnabled: boolean;
  musicVolume: number;
  reducedMotion: boolean;
  defaultDifficulty: AIDifficulty;
  defaultRulesetId: string;
  defaultAuctionSpeed: 'NORMAL' | 'FAST' | 'BLITZ';
  defaultNominationMode: NominationMode;
  confirmBeforeHighBidCr: number;
  ratingWeights: RatingWeights;
}
