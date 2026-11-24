import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from './data/franchises';
import { INITIAL_PLAYERS } from './data/players';
import { formatSpokenPrice, getRulesetById, MIN_MATCH_SQUAD_SIZE } from './data/rulesets';
import {
  decideAIRTMCounterBid,
  decideAIRTMFinalMatch,
  decideAIRTMOffer,
  selectNextAIBidder,
} from './engine/aiEngine';
import {
  applyRetentions,
  closeCurrentLot,
  completeAuction,
  createInitialAuctionState,
  enterRetentionPhase,
  formatPlayerIntroSpeech,
  getEffectiveTimerSeconds,
  nominateNextPlayer,
  passOnCurrentPlayer,
  pauseAuction,
  placeBid,
  respondToRtmFinalMatch,
  respondToRtmOffer,
  resumeAuction,
  startAuction,
  submitRtmCounter,
} from './engine/auctionStateMachine';
import { simulatePlayingXICompetition } from './engine/playingXICompetition';
import { evaluateAllFranchises, getRankedLeaderboard } from './engine/ratingEngine';
import {
  enableFastForwardCurrentLot,
  fillTeamToMinimumSquad,
  skipCurrentAuctionSet,
} from './engine/soloSkipEngine';
import {
  AIDifficulty,
  AuctionState,
  FranchiseId,
  GameMode,
  GameSettings,
  NominationMode,
  Player,
  SavedAuction,
  Tournament,
  UserProfile,
} from './engine/types';
import { audioService } from './services/audioService';
import {
  CloudAuctionSummary,
  deleteCloudAuctionHistory,
  ensureCloudUserProfile,
  loadCloudAuctionHistory,
  saveCloudAuctionHistory,
  signInWithGoogle,
  signOutFirebase,
  subscribeFirebaseAuth,
  updateCloudUserProfile,
} from './services/firebase';
import { ConnectionStatus, MultiplayerClient } from './services/multiplayerClient';
import {
  DEFAULT_SETTINGS,
  deleteSavedAuction,
  getOrCreateClientId,
  loadGuestProfile,
  loadSavedAuctions,
  loadSettings,
  loadTournaments,
  saveAuctionRecord,
  saveGuestProfile,
  saveSettings,
  saveTournaments,
} from './services/storageService';
import { voiceService } from './services/voiceService';
import { OfflineIndicator } from './components/PWAInstallButton';
import { PlayerDetailModal } from './components/PlayerDetailModal';
import { AdminStudioView } from './views/AdminStudioView';
import { AuctionLobbyView } from './views/AuctionLobbyView';
import { AuctionRoomView } from './views/AuctionRoomView';
import { HistoryView } from './views/HistoryView';
import { HomeView } from './views/HomeView';
import { PlayerDatabaseView } from './views/PlayerDatabaseView';
import { PostAuctionResultsView } from './views/PostAuctionResultsView';
import { ProfileAuthView } from './views/ProfileAuthView';
import { RetentionRoomView } from './views/RetentionRoomView';
import { SettingsView } from './views/SettingsView';
import { TournamentView } from './views/TournamentView';

type AppPage =
  | 'home'
  | 'lobby'
  | 'retention'
  | 'auction'
  | 'results'
  | 'players'
  | 'tournaments'
  | 'history'
  | 'settings'
  | 'profile'
  | 'admin';

export default function App() {
  const clientId = useMemo(() => getOrCreateClientId(), []);

  const [page, setPage] = useState<AppPage>('home');
  const [players, setPlayers] = useState<Player[]>(INITIAL_PLAYERS);
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings());
  const [profile, setProfile] = useState<UserProfile>(() => loadGuestProfile());
  const [firebaseUid, setFirebaseUid] = useState<string | null>(null);
  const [cloudSyncLoading, setCloudSyncLoading] = useState(false);
  const [cloudSummaries, setCloudSummaries] = useState<CloudAuctionSummary[]>([]);
  const [_authToken, setAuthToken] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [savedAuctions, setSavedAuctions] = useState<SavedAuction[]>(() => loadSavedAuctions());
  const [tournaments, setTournaments] = useState<Tournament[]>(() => loadTournaments());

  // Live Auction Session State
  const [auctionState, setAuctionState] = useState<AuctionState | null>(null);
  const [userFranchiseId, setUserFranchiseId] = useState<FranchiseId>('CSK');
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('DISCONNECTED');
  const [lastError, setLastError] = useState<string | null>(null);
  const [inspectedPlayer, setInspectedPlayer] = useState<Player | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Results View State (Stage 1: Pick Playing XI -> Stage 2: Compete & Celebration)
  const [resultsCompeted, setResultsCompeted] = useState<boolean>(false);
  const [resultsInitialXI, setResultsInitialXI] = useState<string[] | undefined>(undefined);

  const mpClientRef = useRef<MultiplayerClient | null>(null);
  const lastSpokenPlayerIdRef = useRef<string | null>(null);
  const lastSpokenPhaseRef = useRef<string>('');
  const lastBidCountRef = useRef<number>(0);
  const lastSpokenGoingRef = useRef<string>('');
  const lastSpokenRtmKeyRef = useRef<string>('');
  const savedIdsRef = useRef<Set<string>>(new Set());

  const soloLastAIBidRef = useRef<number>(0);
  const soloGoingOnceRef = useRef<boolean>(false);
  const soloGoingTwiceRef = useRef<boolean>(false);
  const soloTransitionAtRef = useRef<number | null>(null);
  const soloRtmDecisionAtRef = useRef<number | null>(null);

  const playerMap = useMemo(() => {
    const map: Record<string, Player> = {};
    for (const p of players) map[p.id] = p;
    return map;
  }, [players]);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => {
      setToastMsg((prev) => (prev === msg ? null : prev));
    }, 3500);
  }, []);

  // Live Auction Navigation Lock (Requirement #3)
  const isLiveAuctionLocked =
    page === 'auction' &&
    Boolean(auctionState) &&
    auctionState!.phase !== 'LOBBY' &&
    auctionState!.phase !== 'RETENTION' &&
    auctionState!.phase !== 'COMPLETED';

  // Warn before accidentally closing/reloading browser tab during an active live auction
  useEffect(() => {
    if (!isLiveAuctionLocked) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isLiveAuctionLocked]);

  // Subscribe to Firebase Google Auth & hydrate cloud profile + history
  useEffect(() => {
    const unsubscribe = subscribeFirebaseAuth(async (fbUser) => {
      if (!fbUser) {
        setFirebaseUid(null);
        setCloudSummaries([]);
        return;
      }
      setFirebaseUid(fbUser.uid);
      setCloudSyncLoading(true);
      try {
        const cloudProfile = await ensureCloudUserProfile(fbUser, profile.favoriteFranchise);
        setProfile({
          ...cloudProfile,
          photoURL: fbUser.photoURL ?? undefined,
          authProvider: 'google',
        });
        const history = await loadCloudAuctionHistory(fbUser.uid);
        setCloudSummaries(history);
      } catch (err) {
        console.error('Failed to sync Firebase profile/history:', err);
      } finally {
        setCloudSyncLoading(false);
      }
    });
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync theme on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
  }, [settings.theme]);

  // Sync inbuilt auctioneer voice volume + stadium audio settings (Req #9: voice is always enabled)
  useEffect(() => {
    voiceService.configure({
      volume: Math.max(0.5, settings.masterVolume),
    });
    audioService.configure({
      sfxEnabled: settings.sfxEnabled,
      musicEnabled: settings.musicEnabled,
      masterVolume: settings.masterVolume,
      sfxVolume: settings.sfxVolume,
      musicVolume: settings.musicVolume,
    });
  }, [settings]);

  // Fetch merged players (including any Admin Studio additions) from backend on mount
  useEffect(() => {
    fetch('/api/players')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.players && Array.isArray(data.players) && data.players.length > 0) {
          setPlayers(data.players);
        }
      })
      .catch(() => {
        // Offline PWA mode cleanly uses bundled INITIAL_PLAYERS
      });
  }, []);

  // Handle ?join=ROOMCODE deep link on initial load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode && joinCode.trim().length >= 4) {
      window.history.replaceState({}, '', window.location.pathname);
      joinMultiplayerRoom(joinCode.trim().toUpperCase());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up WebSocket & audio on unmount
  useEffect(() => {
    return () => {
      mpClientRef.current?.disconnect();
      voiceService.stopAll();
      audioService.stopAmbientLoop();
    };
  }, []);

  // ==================== REALISTIC VOICE SYNC & PHASE TRANSITIONS (REQ #2) ====================
  useEffect(() => {
    if (!auctionState) return;
    const phase = auctionState.phase;
    const prevPhase = lastSpokenPhaseRef.current;
    const curPlayer = auctionState.currentPlayerId ? playerMap[auctionState.currentPlayerId] : null;

    // 1) Pause silences active voice immediately
    if (phase === 'PAUSED' && prevPhase !== 'PAUSED') {
      voiceService.cancelActive();
    }

    // 2) New player nominated -> Speak concise intro ONLY ("The next player is... <Name>, <Role> from <Country>. Base price <spoken>.")
    if (
      curPlayer &&
      (phase === 'OPENING_BID' || phase === 'BIDDING') &&
      curPlayer.id !== lastSpokenPlayerIdRef.current
    ) {
      lastSpokenPlayerIdRef.current = curPlayer.id;
      lastBidCountRef.current = auctionState.bidHistory.length;
      lastSpokenGoingRef.current = '';
      lastSpokenRtmKeyRef.current = '';
      voiceService.announce(formatPlayerIntroSpeech(curPlayer), 'HIGH');

      // Quietly preload the current & next 2 players' official cutout photos + next player's intro voice
      const preloadIds = [curPlayer.id, auctionState.playerQueue[0], auctionState.playerQueue[1]].filter(
        (id): id is string => Boolean(id)
      );
      for (const pid of preloadIds) {
        const img = new Image();
        img.src = `/api/player-photo/${encodeURIComponent(pid)}?v=2`;
      }
      const upcomingId = auctionState.playerQueue[0];
      if (upcomingId && playerMap[upcomingId]) {
        voiceService.preload(formatPlayerIntroSpeech(playerMap[upcomingId]));
      }
    }

    // 3) Rapid bids -> NEVER speak on individual bids! Cancel any stale "Going once/twice" immediately.
    if (auctionState.bidHistory.length !== lastBidCountRef.current) {
      const increased = auctionState.bidHistory.length > lastBidCountRef.current;
      lastBidCountRef.current = auctionState.bidHistory.length;
      if (increased && lastSpokenGoingRef.current) {
        voiceService.cancelActive();
        lastSpokenGoingRef.current = '';
      }
    }

    // 4) Bid Hold -> Speak "CSK is with 5 crores, going once!" and "Going twice!" cleanly (skip during 4x fast-forward)
    if (
      phase === 'COUNTDOWN' &&
      !auctionState.fastForwardCurrentLot &&
      auctionState.hasOpeningBid &&
      auctionState.currentBidderId &&
      curPlayer
    ) {
      const leaderShort = FRANCHISE_MAP[auctionState.currentBidderId].shortName;
      const spokenPrice = formatSpokenPrice(auctionState.currentBidCr);
      const sec = auctionState.countdownRemainingSec;

      if (
        sec <= auctionState.ruleset.goingOnceAtSeconds &&
        sec > auctionState.ruleset.goingTwiceAtSeconds
      ) {
        const key = `${curPlayer.id}_ONCE_${auctionState.currentBidCr}_${auctionState.currentBidderId}`;
        if (lastSpokenGoingRef.current !== key) {
          lastSpokenGoingRef.current = key;
          voiceService.announce(`${leaderShort} is with ${spokenPrice}, going once!`, 'HIGH');
        }
      } else if (sec <= auctionState.ruleset.goingTwiceAtSeconds && sec > 0) {
        const key = `${curPlayer.id}_TWICE_${auctionState.currentBidCr}_${auctionState.currentBidderId}`;
        if (lastSpokenGoingRef.current !== key) {
          lastSpokenGoingRef.current = key;
          voiceService.announce('Going twice!', 'HIGH');
        }
      }
    }

    // 5) RTM Stages -> Concise spoken call
    if (
      (phase === 'RTM_OFFER' || phase === 'RTM_COUNTER' || phase === 'RTM_FINAL_MATCH') &&
      auctionState.rtmState
    ) {
      const rtmKey = `${auctionState.rtmState.playerId}_${phase}_${auctionState.rtmState.counterBidCr ?? ''}`;
      if (lastSpokenRtmKeyRef.current !== rtmKey) {
        lastSpokenRtmKeyRef.current = rtmKey;
        voiceService.announce(auctionState.lastAnnouncement, 'HIGH');
      }
    }

    // 6) Phase transitions: SOLD, UNSOLD, RETENTION, COMPLETED
    if (phase !== prevPhase) {
      lastSpokenPhaseRef.current = phase;

      if (phase === 'SOLD') {
        audioService.playSoldGavel();
        voiceService.announce(auctionState.lastAnnouncement, 'HIGH', undefined, {
          protectCompletion: true,
        });
      } else if (phase === 'UNSOLD') {
        audioService.playUnsold();
        if (curPlayer) {
          voiceService.announce(`Unsold. ${curPlayer.name} goes unsold.`, 'HIGH', undefined, {
            protectCompletion: true,
          });
        }
      } else if (phase === 'RETENTION') {
        setPage('retention');
      } else if (phase === 'COMPLETED') {
        audioService.playVictoryFanfare();
        voiceService.announce(
          'Auction complete! Select your Playing Eleven to compete for the championship.',
          'HIGH',
          undefined,
          { protectCompletion: true }
        );
        if (prevPhase !== '' && prevPhase !== 'COMPLETED') {
          setResultsCompeted(false);
          setResultsInitialXI(undefined);
        }
        setPage('results');
      } else if (
        (prevPhase === 'LOBBY' || prevPhase === 'RETENTION' || prevPhase === 'READY') &&
        (phase === 'OPENING_BID' || phase === 'BIDDING')
      ) {
        setPage('auction');
      }
    }
  }, [auctionState, playerMap]);

  // ==================== LOCAL SOLO AUCTION LOOP (WITH 3-STAGE AI RTM + EXACT PAUSE) ====================
  useEffect(() => {
    if (isMultiplayer || !auctionState) return;
    if (
      auctionState.phase === 'LOBBY' ||
      auctionState.phase === 'RETENTION' ||
      auctionState.phase === 'READY' ||
      auctionState.phase === 'COMPLETED' ||
      auctionState.phase === 'PAUSED'
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      setAuctionState((curr) => {
        if (
          !curr ||
          curr.phase === 'PAUSED' ||
          curr.phase === 'COMPLETED' ||
          curr.phase === 'LOBBY' ||
          curr.phase === 'RETENTION' ||
          curr.phase === 'READY'
        ) {
          return curr;
        }

        // Advance from SOLD / UNSOLD ONLY after the auctioneer finishes the complete SOLD/UNSOLD sentence
        if (curr.phase === 'SOLD' || curr.phase === 'UNSOLD') {
          const readyAt = soloTransitionAtRef.current;
          const voiceDone = !voiceService.isCurrentlySpeaking();
          const maxHoldExceeded = readyAt !== null && now >= readyAt + 4200;
          if (readyAt && now >= readyAt && (voiceDone || maxHoldExceeded)) {
            soloTransitionAtRef.current = null;
            soloGoingOnceRef.current = false;
            soloGoingTwiceRef.current = false;
            soloLastAIBidRef.current = now + 700;
            soloRtmDecisionAtRef.current = null;
            return nominateNextPlayer(curr, playerMap, now);
          }
          return curr;
        }

        // Handle 3-stage RTM phases in Solo mode (AI reacts automatically; Human has countdown)
        if (
          (curr.phase === 'RTM_OFFER' ||
            curr.phase === 'RTM_COUNTER' ||
            curr.phase === 'RTM_FINAL_MATCH') &&
          curr.rtmState
        ) {
          const rtm = curr.rtmState;
          const rtmPlayer = playerMap[rtm.playerId];
          const actingTeamId =
            curr.phase === 'RTM_COUNTER' ? rtm.winningFranchiseId : rtm.rtmFranchiseId;
          const actingTeam = curr.teams[actingTeamId];

          if (actingTeam?.controllerType === 'AI' && rtmPlayer) {
            if (!soloRtmDecisionAtRef.current) {
              soloRtmDecisionAtRef.current = now + (curr.fastForwardCurrentLot ? 350 : 1350);
              return curr;
            }
            if (now >= soloRtmDecisionAtRef.current) {
              soloRtmDecisionAtRef.current = null;
              let nextState = curr;
              if (curr.phase === 'RTM_OFFER') {
                const useRtm = decideAIRTMOffer(curr, rtm.rtmFranchiseId, rtmPlayer, rtm.initialBidCr, playerMap);
                nextState = respondToRtmOffer(curr, useRtm, playerMap, now);
              } else if (curr.phase === 'RTM_COUNTER') {
                const counter = decideAIRTMCounterBid(
                  curr,
                  rtm.winningFranchiseId,
                  rtmPlayer,
                  rtm.initialBidCr,
                  playerMap
                );
                nextState = submitRtmCounter(curr, counter, playerMap, now);
              } else if (curr.phase === 'RTM_FINAL_MATCH') {
                const match = decideAIRTMFinalMatch(
                  curr,
                  rtm.rtmFranchiseId,
                  rtmPlayer,
                  rtm.counterBidCr ?? rtm.initialBidCr,
                  playerMap
                );
                nextState = respondToRtmFinalMatch(curr, match, playerMap, now);
              }
              if (nextState.phase === 'SOLD') {
                soloTransitionAtRef.current = now + (curr.fastForwardCurrentLot ? 2000 : 4200);
              }
              return nextState;
            }
            return curr;
          }

          // Human RTM countdown
          if (curr.countdownEndsAt) {
            const remainingMs = curr.countdownEndsAt - now;
            const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
            if (remainingSec <= 0) {
              let nextState = curr;
              if (curr.phase === 'RTM_OFFER') {
                nextState = respondToRtmOffer(curr, false, playerMap, now);
              } else if (curr.phase === 'RTM_COUNTER') {
                nextState = submitRtmCounter(curr, null, playerMap, now);
              } else if (curr.phase === 'RTM_FINAL_MATCH') {
                nextState = respondToRtmFinalMatch(curr, false, playerMap, now);
              }
              if (nextState.phase === 'SOLD') {
                soloTransitionAtRef.current = now + 4200;
              }
              return nextState;
            }
            if (remainingSec !== curr.countdownRemainingSec) {
              if (remainingSec <= 3) audioService.playCountdownTick(remainingSec <= 2);
              return { ...curr, countdownRemainingSec: remainingSec };
            }
          }
          return curr;
        }

        if (!curr.countdownEndsAt) return curr;

        // Hold timer & AI bidding while auctioneer finishes introducing "The next player is..." (bypassed if 4x fast-forward active)
        if (!curr.fastForwardCurrentLot && curr.biddingOpensAt && now < curr.biddingOpensAt) {
          return curr;
        }

        const is4x = Boolean(curr.fastForwardCurrentLot);
        const remainingMs = curr.countdownEndsAt - now;
        const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

        // AI bidding cadence (4x faster when Solo Skip Player 4x is active)
        const baseAiCooldownMs =
          curr.auctionSpeed === 'BLITZ' ? 650 : curr.auctionSpeed === 'FAST' ? 950 : 1250;
        const aiCooldownMs = is4x ? Math.max(160, Math.round(baseAiCooldownMs / 4)) : baseAiCooldownMs;

        if (remainingMs > (is4x ? 180 : 700) && now - soloLastAIBidRef.current >= aiCooldownMs) {
          const decision = selectNextAIBidder(curr, playerMap);
          if (decision && curr.currentPlayerId) {
            const p = playerMap[curr.currentPlayerId];
            if (p) {
              const res = placeBid(curr, decision.franchiseId, p, {
                proposedAmountCr: decision.bidAmountCr,
                isAI: true,
                aiReason: decision.reason,
                now,
              });
              if (res.accepted) {
                soloLastAIBidRef.current = now;
                soloGoingOnceRef.current = false;
                soloGoingTwiceRef.current = false;
                audioService.playBid(false);
                if (is4x) {
                  const fastMs = Math.max(
                    1100,
                    Math.round((getEffectiveTimerSeconds(res.state) * 1000) / 4)
                  );
                  return {
                    ...res.state,
                    fastForwardCurrentLot: true,
                    countdownEndsAt: now + fastMs,
                    countdownRemainingSec: Math.max(1, Math.ceil(fastMs / 1000)),
                  };
                }
                return res.state;
              }
            }
          }
          soloLastAIBidRef.current = now;
        }

        // Close lot when countdown hits 0 (may enter RTM_OFFER or SOLD/UNSOLD)
        if (remainingSec <= 0) {
          const closed = closeCurrentLot(curr, playerMap, now);
          if (closed.phase === 'SOLD' || closed.phase === 'UNSOLD') {
            soloTransitionAtRef.current =
              now + (is4x ? 2200 : curr.auctionSpeed === 'BLITZ' ? 3200 : 4200);
          } else {
            soloRtmDecisionAtRef.current = null;
          }
          return closed;
        }

        if (remainingSec !== curr.countdownRemainingSec) {
          if (!is4x && remainingSec <= 3) audioService.playCountdownTick(remainingSec <= 2);

          let announcement = curr.lastAnnouncement;
          if (
            !is4x &&
            curr.hasOpeningBid &&
            remainingSec <= curr.ruleset.goingOnceAtSeconds &&
            remainingSec > curr.ruleset.goingTwiceAtSeconds &&
            !soloGoingOnceRef.current
          ) {
            soloGoingOnceRef.current = true;
            const leader = curr.currentBidderId ? FRANCHISE_MAP[curr.currentBidderId].shortName : '';
            announcement = `${leader} is with ${formatSpokenPrice(curr.currentBidCr)}, going once!`;
          } else if (
            !is4x &&
            curr.hasOpeningBid &&
            remainingSec <= curr.ruleset.goingTwiceAtSeconds &&
            !soloGoingTwiceRef.current
          ) {
            soloGoingTwiceRef.current = true;
            announcement = 'Going twice!';
          }

          return {
            ...curr,
            countdownRemainingSec: remainingSec,
            phase: remainingSec <= curr.ruleset.goingOnceAtSeconds ? 'COUNTDOWN' : curr.phase,
            lastAnnouncement: announcement,
          };
        }

        return curr;
      });
    }, 110);

    return () => window.clearInterval(timer);
  }, [isMultiplayer, auctionState?.phase, auctionState?.roomId, playerMap]);

  // ==================== PROFILE & GOOGLE AUTH ACTIONS ====================

  const handleGoogleSignIn = async () => {
    try {
      const fbUser = await signInWithGoogle();
      showToast(`Signed in as ${fbUser.displayName || fbUser.email || 'Franchise Owner'}!`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.toLowerCase().includes('popup-closed')) {
        showToast('Google Sign-In could not complete. Try again or continue as Guest.');
      }
      throw err;
    }
  };

  const handleSignOut = async () => {
    if (firebaseUid) {
      await signOutFirebase();
    }
    setAuthToken(null);
    setFirebaseUid(null);
    setCloudSummaries([]);
    setProfile(loadGuestProfile());
    showToast('Signed out. Switched to Guest Mode.');
  };

  const handleUpdateProfile = (patch: Partial<UserProfile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...patch };
      if (next.isGuest) {
        saveGuestProfile(next);
      } else if (firebaseUid) {
        void updateCloudUserProfile(firebaseUid, next).catch(() => {});
      }
      return next;
    });

    if (patch.username && auctionState && auctionState.phase === 'LOBBY') {
      setAuctionState((curr) => {
        if (!curr || !curr.teams[userFranchiseId]) return curr;
        return {
          ...curr,
          teams: {
            ...curr.teams,
            [userFranchiseId]: {
              ...curr.teams[userFranchiseId],
              ownerName: patch.username!,
            },
          },
        };
      });
    }
  };

  // ==================== SETTINGS & MULTIPLAYER ACTIONS ====================

  const updateSettings = (patch: Partial<GameSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
    showToast('Settings restored to defaults.');
  };

  const disconnectMultiplayer = () => {
    mpClientRef.current?.disconnect();
    mpClientRef.current = null;
    setIsMultiplayer(false);
    setConnectionStatus('DISCONNECTED');
  };

  const connectToMultiplayerRoom = (roomCode: string, desiredFranchise?: FranchiseId) => {
    disconnectMultiplayer();
    setIsMultiplayer(true);
    setLastError(null);
    const client = new MultiplayerClient({
      onStatus: setConnectionStatus,
      onState: (nextState, evtType) => {
        setAuctionState(nextState);
        if (evtType === 'bid:placed') audioService.playBid(false);
        if (nextState.phase === 'LOBBY') setPage('lobby');
        else if (nextState.phase === 'RETENTION') setPage('retention');
        else if (nextState.phase === 'COMPLETED') setPage('results');
        else setPage('auction');
      },
      onAssignedFranchise: (fid) => setUserFranchiseId(fid),
      onError: (msg) => {
        setLastError(msg);
        showToast(msg);
      },
    });
    mpClientRef.current = client;
    client.connect({
      roomCode,
      clientId,
      username: profile.username,
      franchiseId: desiredFranchise,
    });
  };

  const joinMultiplayerRoom = async (code: string) => {
    audioService.unlock();
    voiceService.unlock();
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || `Room ${code} not found.`);
        return;
      }
      connectToMultiplayerRoom(code, profile.favoriteFranchise);
    } catch {
      showToast('Could not connect to multiplayer server.');
    }
  };

  const launchMode = async (
    mode: GameMode,
    preselectedFranchise: FranchiseId = profile.favoriteFranchise,
    tournamentCtx?: { tournamentId: string; round: number; rulesetId: string; difficulty: AIDifficulty }
  ) => {
    audioService.unlock();
    voiceService.unlock();
    setLastError(null);
    lastSpokenPlayerIdRef.current = null;
    lastSpokenPhaseRef.current = '';
    lastBidCountRef.current = 0;
    lastSpokenGoingRef.current = '';
    lastSpokenRtmKeyRef.current = '';
    setResultsCompeted(false);
    setResultsInitialXI(undefined);

    const rulesetId =
      tournamentCtx?.rulesetId ??
      (mode === 'QUICK'
        ? 'sim-2026-quick'
        : mode === 'PRACTICE'
        ? 'sim-practice'
        : settings.defaultRulesetId);
    const ruleset = getRulesetById(rulesetId);
    const difficulty = tournamentCtx?.difficulty ?? settings.defaultDifficulty;

    if (mode === 'MULTIPLAYER') {
      try {
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId,
            username: profile.username,
            franchiseId: preselectedFranchise,
            mode: 'MULTIPLAYER',
            rulesetId,
            aiDifficulty: difficulty,
            nominationMode: settings.defaultNominationMode,
            auctionSpeed: settings.defaultAuctionSpeed,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Could not create multiplayer room.');
          return;
        }
        setUserFranchiseId(preselectedFranchise);
        setAuctionState(data.state);
        setPage('lobby');
        connectToMultiplayerRoom(data.roomCode, preselectedFranchise);
        return;
      } catch {
        showToast('Multiplayer server unreachable. Starting local Solo Lobby instead.');
      }
    }

    // Local Solo / Quick / Full / Practice / Tournament Round
    disconnectMultiplayer();
    const localCode = `SOLO${Math.floor(100 + Math.random() * 900)}`;
    const initial = createInitialAuctionState({
      roomId: `auc_${Date.now().toString(36)}`,
      roomCode: localCode,
      hostId: clientId,
      hostName: profile.username,
      hostFranchiseId: preselectedFranchise,
      mode,
      ruleset,
      aiDifficulty: difficulty,
      nominationMode: settings.defaultNominationMode,
      auctionSpeed: mode === 'QUICK' ? 'FAST' : settings.defaultAuctionSpeed,
      players,
      tournamentId: tournamentCtx?.tournamentId,
      tournamentRound: tournamentCtx?.round,
    });
    setUserFranchiseId(preselectedFranchise);
    setAuctionState(initial);
    setPage('lobby');
  };

  const handleSelectFranchise = (fid: FranchiseId) => {
    if (isMultiplayer) {
      mpClientRef.current?.selectFranchise(fid);
      return;
    }
    setAuctionState((curr) => {
      if (!curr || curr.phase !== 'LOBBY') return curr;
      const teams = { ...curr.teams };
      const oldCfg = FRANCHISE_MAP[userFranchiseId];
      teams[userFranchiseId] = {
        ...teams[userFranchiseId],
        controllerType: 'AI',
        ownerId: undefined,
        ownerName: `${oldCfg.ownerPersona} (AI)`,
        isReady: true,
      };
      teams[fid] = {
        ...teams[fid],
        controllerType: 'HUMAN',
        ownerId: clientId,
        ownerName: profile.username,
        isReady: true,
      };
      return { ...curr, teams };
    });
    setUserFranchiseId(fid);
  };

  const handleUpdateLobbySettings = (updates: {
    rulesetId?: string;
    aiDifficulty?: AIDifficulty;
    auctionSpeed?: 'NORMAL' | 'FAST' | 'BLITZ';
    nominationMode?: NominationMode;
    customPurseCr?: number;
    customMaxOverseas?: number;
  }) => {
    if (isMultiplayer) {
      mpClientRef.current?.updateLobbySettings(updates);
      return;
    }
    setAuctionState((curr) => {
      if (!curr || curr.phase !== 'LOBBY') return curr;
      const nextRuleset = updates.rulesetId
        ? { ...getRulesetById(updates.rulesetId) }
        : { ...curr.ruleset };
      if (updates.customPurseCr !== undefined) nextRuleset.initialPurseCr = updates.customPurseCr;
      if (updates.customMaxOverseas !== undefined)
        nextRuleset.maxOverseasSquad = updates.customMaxOverseas;

      return createInitialAuctionState({
        roomId: curr.roomId,
        roomCode: curr.roomCode,
        hostId: curr.hostId,
        hostName: profile.username,
        hostFranchiseId: userFranchiseId,
        mode: curr.mode,
        ruleset: nextRuleset,
        aiDifficulty: updates.aiDifficulty ?? curr.aiDifficulty,
        nominationMode: updates.nominationMode ?? curr.nominationMode,
        auctionSpeed: updates.auctionSpeed ?? curr.auctionSpeed,
        players,
        tournamentId: curr.tournamentId,
        tournamentRound: curr.tournamentRound,
      });
    });
  };

  // Lobby -> Pre-Auction Retention Desk (Requirement #5)
  const handleProceedToRetentions = () => {
    audioService.unlock();
    voiceService.unlock();
    if (isMultiplayer) {
      mpClientRef.current?.enterRetention();
      return;
    }
    setAuctionState((curr) => (curr ? enterRetentionPhase(curr, Date.now()) : curr));
    setPage('retention');
  };

  // Retention Desk -> Lock Retentions (deduct exact IPL 2026 prices & grant RTM cards) -> Launch Live Auction
  const handleConfirmRetentions = (selections: Partial<Record<FranchiseId, string[]>>) => {
    audioService.unlock();
    voiceService.unlock();
    if (isMultiplayer) {
      mpClientRef.current?.confirmRetentions(selections);
      return;
    }
    setAuctionState((curr) => {
      if (!curr) return curr;
      const now = Date.now();
      const retained = applyRetentions(curr, selections, playerMap, now);
      soloLastAIBidRef.current = now + 900;
      soloGoingOnceRef.current = false;
      soloGoingTwiceRef.current = false;
      soloTransitionAtRef.current = null;
      soloRtmDecisionAtRef.current = null;
      return startAuction(retained, playerMap, now);
    });
    setPage('auction');
  };

  const handlePlaceBid = (amountCr?: number) => {
    audioService.unlock();
    voiceService.unlock();
    setLastError(null);
    if (isMultiplayer) {
      audioService.playBid(true);
      mpClientRef.current?.placeBid(amountCr);
      return;
    }
    setAuctionState((curr) => {
      if (!curr || !curr.currentPlayerId) return curr;
      const p = playerMap[curr.currentPlayerId];
      if (!p) return curr;
      const res = placeBid(curr, userFranchiseId, p, { proposedAmountCr: amountCr, isAI: false });
      if (!res.accepted) {
        setLastError(res.error || 'Bid rejected.');
        return curr;
      }
      audioService.playBid(true);
      soloLastAIBidRef.current = Date.now();
      soloGoingOnceRef.current = false;
      soloGoingTwiceRef.current = false;
      return res.state;
    });
  };

  const handlePass = () => {
    if (isMultiplayer) {
      mpClientRef.current?.pass();
      return;
    }
    setAuctionState((curr) => (curr ? passOnCurrentPlayer(curr, userFranchiseId) : curr));
  };

  // 3-Stage Real IPL RTM Handlers (Requirement #5)
  const handleRespondRtmOffer = (useRtm: boolean) => {
    audioService.unlock();
    voiceService.unlock();
    if (isMultiplayer) {
      mpClientRef.current?.respondRtmOffer(useRtm);
      return;
    }
    setAuctionState((curr) => {
      if (!curr) return curr;
      const now = Date.now();
      const next = respondToRtmOffer(curr, useRtm, playerMap, now);
      if (next.phase === 'SOLD') {
        soloTransitionAtRef.current = now + 2400;
      } else {
        soloRtmDecisionAtRef.current = null;
      }
      return next;
    });
  };

  const handleSubmitRtmCounter = (counterBidCr: number | null) => {
    audioService.unlock();
    voiceService.unlock();
    if (isMultiplayer) {
      mpClientRef.current?.submitRtmCounter(counterBidCr);
      return;
    }
    setAuctionState((curr) => {
      if (!curr) return curr;
      const now = Date.now();
      const next = submitRtmCounter(curr, counterBidCr, playerMap, now);
      if (next.phase === 'SOLD') {
        soloTransitionAtRef.current = now + 2400;
      } else {
        soloRtmDecisionAtRef.current = null;
      }
      return next;
    });
  };

  const handleRespondRtmFinalMatch = (matchCounter: boolean) => {
    audioService.unlock();
    voiceService.unlock();
    if (isMultiplayer) {
      mpClientRef.current?.respondRtmFinalMatch(matchCounter);
      return;
    }
    setAuctionState((curr) => {
      if (!curr) return curr;
      const now = Date.now();
      const next = respondToRtmFinalMatch(curr, matchCounter, playerMap, now);
      if (next.phase === 'SOLD') {
        soloTransitionAtRef.current = now + 2400;
      }
      return next;
    });
  };

  // Exact Pause & Resume (Requirement #3)
  const handleTogglePause = () => {
    if (!auctionState) return;
    if (isMultiplayer) {
      if (auctionState.phase === 'PAUSED') mpClientRef.current?.resume();
      else mpClientRef.current?.pause();
      return;
    }
    setAuctionState((curr) => {
      if (!curr) return curr;
      if (curr.phase === 'PAUSED') {
        soloLastAIBidRef.current = Date.now() + 600;
        return resumeAuction(curr, Date.now());
      }
      return pauseAuction(curr, Date.now());
    });
  };

  const handleNominatePlayer = (playerId: string) => {
    if (isMultiplayer) {
      mpClientRef.current?.nominatePlayer(playerId);
      return;
    }
    setAuctionState((curr) => {
      if (!curr) return curr;
      soloTransitionAtRef.current = null;
      return nominateNextPlayer(curr, playerMap, Date.now(), playerId);
    });
  };

  // SOLO-ONLY: Fast-forward current player at 4x speed
  const handleSkipPlayer4x = () => {
    if (isMultiplayer || !auctionState || auctionState.mode === 'MULTIPLAYER') return;
    audioService.unlock();
    voiceService.unlock();
    voiceService.cancelActive();
    soloLastAIBidRef.current = 0;
    setAuctionState((curr) =>
      curr ? enableFastForwardCurrentLot(curr, userFranchiseId, Date.now()) : curr
    );
  };

  // SOLO-ONLY: Skip rest of the current player set and jump to the next set
  const handleSkipSet = () => {
    if (isMultiplayer || !auctionState || auctionState.mode === 'MULTIPLAYER') return;
    audioService.unlock();
    voiceService.unlock();
    voiceService.cancelActive();
    const now = Date.now();
    const result = skipCurrentAuctionSet(auctionState, userFranchiseId, playerMap, now);
    soloTransitionAtRef.current = null;
    soloGoingOnceRef.current = false;
    soloGoingTwiceRef.current = false;
    soloLastAIBidRef.current = now + 700;
    soloRtmDecisionAtRef.current = null;
    setAuctionState(result.state);
    if (result.skippedCategory) {
      const nextMsg = result.nextCategory
        ? `Next: ${result.nextCategory}`
        : 'Moving to final rounds';
      showToast(
        `Skipped ${result.skippedCategory}: ${result.soldCount} sold, ${result.unsoldCount} unsold · ${nextMsg}`
      );
    }
  };

  // Auto-draft remaining slots from unsold pool so teams under 14 reach the strict 14-player minimum
  const handleAutoFillMinSquad = () => {
    setAuctionState((curr) => {
      if (!curr) return curr;
      const now = Date.now();
      let updated = fillTeamToMinimumSquad(curr, userFranchiseId, playerMap, MIN_MATCH_SQUAD_SIZE, now);
      for (const fid of ALL_FRANCHISE_IDS) {
        if (updated.teams[fid].squad.length < MIN_MATCH_SQUAD_SIZE) {
          updated = fillTeamToMinimumSquad(updated, fid, playerMap, MIN_MATCH_SQUAD_SIZE, now + 1);
        }
      }
      return updated;
    });
    showToast(`Auto-drafted unsold players at base price so all squads meet the ${MIN_MATCH_SQUAD_SIZE}-player minimum.`);
  };

  // End Auction & Exit back to Home (Requirement #3)
  const handleEndAndExit = () => {
    voiceService.stopAll();
    audioService.stopAmbientLoop();
    disconnectMultiplayer();
    setAuctionState(null);
    setPage('home');
    showToast('Auction ended.');
  };

  /** Fast-forward remaining lots using the exact same strategic AI engine + AI RTM decisions */
  const handleSimulateRemaining = () => {
    if (isMultiplayer) return;
    voiceService.cancelActive();
    setAuctionState((curr) => {
      if (!curr) return curr;
      let sim: AuctionState =
        curr.phase === 'PAUSED' ? resumeAuction(curr, Date.now()) : { ...curr, teams: { ...curr.teams } };

      const origType = sim.teams[userFranchiseId].controllerType;
      sim.teams[userFranchiseId] = { ...sim.teams[userFranchiseId], controllerType: 'AI' };

      let safety = 0;
      const now = Date.now();
      while (sim.phase !== 'COMPLETED' && safety < 350) {
        safety++;
        const tickNow = now + safety * 100;

        if (sim.phase === 'RTM_OFFER' && sim.rtmState) {
          const p = playerMap[sim.rtmState.playerId];
          const useRtm = p
            ? decideAIRTMOffer(sim, sim.rtmState.rtmFranchiseId, p, sim.rtmState.initialBidCr, playerMap)
            : false;
          sim = respondToRtmOffer(sim, useRtm, playerMap, tickNow);
          continue;
        }
        if (sim.phase === 'RTM_COUNTER' && sim.rtmState) {
          const p = playerMap[sim.rtmState.playerId];
          const counter = p
            ? decideAIRTMCounterBid(
                sim,
                sim.rtmState.winningFranchiseId,
                p,
                sim.rtmState.initialBidCr,
                playerMap
              )
            : null;
          sim = submitRtmCounter(sim, counter, playerMap, tickNow);
          continue;
        }
        if (sim.phase === 'RTM_FINAL_MATCH' && sim.rtmState) {
          const p = playerMap[sim.rtmState.playerId];
          const match = p
            ? decideAIRTMFinalMatch(
                sim,
                sim.rtmState.rtmFranchiseId,
                p,
                sim.rtmState.counterBidCr ?? sim.rtmState.initialBidCr,
                playerMap
              )
            : false;
          sim = respondToRtmFinalMatch(sim, match, playerMap, tickNow);
          continue;
        }

        if (sim.phase === 'SOLD' || sim.phase === 'UNSOLD') {
          sim = nominateNextPlayer(sim, playerMap, tickNow);
          continue;
        }
        if (!sim.currentPlayerId) {
          sim = nominateNextPlayer(sim, playerMap, tickNow);
          continue;
        }
        const player = playerMap[sim.currentPlayerId];
        if (!player) {
          sim = closeCurrentLot(sim, playerMap, tickNow);
          continue;
        }

        let rounds = 0;
        while (rounds < 26) {
          rounds++;
          const decision = selectNextAIBidder(sim, playerMap);
          if (!decision) break;
          const res = placeBid(sim, decision.franchiseId, player, {
            proposedAmountCr: decision.bidAmountCr,
            isAI: true,
            aiReason: decision.reason,
            now: tickNow + rounds,
          });
          if (!res.accepted) break;
          sim = res.state;
        }
        sim = closeCurrentLot(sim, playerMap, tickNow + 50);

        // If closing lot triggered RTM, let the next iteration resolve it
        if (sim.phase === 'RTM_OFFER') continue;

        if (
          sim.playerQueue.length === 0 &&
          (!sim.ruleset.allowUnsoldReentry || sim.reentryRound || sim.unsoldPool.length === 0)
        ) {
          sim = completeAuction(sim, tickNow + 80);
          break;
        }
      }

      if (sim.phase !== 'COMPLETED') {
        sim = completeAuction(sim, now + 99999);
      }

      // Guarantee every franchise meets the strict 14-player minimum squad size
      for (const fid of ALL_FRANCHISE_IDS) {
        if (sim.teams[fid].squad.length < MIN_MATCH_SQUAD_SIZE) {
          sim = fillTeamToMinimumSquad(sim, fid, playerMap, MIN_MATCH_SQUAD_SIZE, now + 100001);
        }
      }

      sim.teams[userFranchiseId] = {
        ...sim.teams[userFranchiseId],
        controllerType: origType,
        ownerId: clientId,
        ownerName: profile.username,
      };
      return sim;
    });
  };

  // ==================== POST-AUCTION PLAYING XI COMPETITION & PERSISTENCE (REQ #7 & #8) ====================
  const handleConfirmPlayingXI = (starterIds: string[]) => {
    if (!auctionState) return;
    if (auctionState.teams[userFranchiseId].squad.length < MIN_MATCH_SQUAD_SIZE) {
      showToast(`Minimum ${MIN_MATCH_SQUAD_SIZE} players required before starting the championship.`);
      return;
    }
    setResultsCompeted(true);
    setResultsInitialXI(starterIds);

    const competition = simulatePlayingXICompetition(
      auctionState,
      playerMap,
      userFranchiseId,
      starterIds,
      settings.ratingWeights
    );
    const ratings = competition.ratings;
    const ranked = getRankedLeaderboard(auctionState, ratings);
    const winnerRow = competition.standings[0];
    const userStandingRow =
      competition.standings.find((r) => r.franchiseId === userFranchiseId) ?? competition.standings[0];

    // Speak championship winner celebration announcement
    voiceService.announce(
      `Championship complete! ${FRANCHISE_MAP[winnerRow.franchiseId].name} are the IPL 2027 Champions!`,
      'HIGH',
      undefined,
      { protectCompletion: true }
    );

    const record: SavedAuction = {
      id: auctionState.roomId,
      roomCode: auctionState.roomCode,
      completedAt: Date.now(),
      mode: auctionState.mode,
      rulesetName: auctionState.ruleset.name,
      aiDifficulty: auctionState.aiDifficulty,
      userFranchiseId,
      winnerFranchiseId: winnerRow.franchiseId,
      userScore: userStandingRow.xiStrength,
      winnerScore: winnerRow.xiStrength,
      userRank: userStandingRow.rank,
      stateSnapshot: auctionState,
      ratings,
      userPlayingXIIds: starterIds,
    };

    const userRankRow = {
      rank: userStandingRow.rank,
      rating: userStandingRow.rating,
    };

    setSavedAuctions(saveAuctionRecord(record));

    // Cloud-sync to Firestore if signed in with Google
    if (firebaseUid) {
      void saveCloudAuctionHistory(firebaseUid, record, starterIds)
        .then(() => loadCloudAuctionHistory(firebaseUid))
        .then((list) => setCloudSummaries(list))
        .catch(() => {});
    }

    // Update career stats & tournament standings once per roomId
    if (!savedIdsRef.current.has(auctionState.roomId)) {
      savedIdsRef.current.add(auctionState.roomId);

      if (auctionState.mode !== 'PRACTICE') {
        setProfile((prev) => {
          const played = prev.stats.auctionsPlayed + 1;
          const won = prev.stats.auctionsWon + (userRankRow.rank === 1 ? 1 : 0);
          const best = Math.max(prev.stats.bestRating, userRankRow.rating.winPercentage);
          const avg = Math.round(
            (prev.stats.avgRating * prev.stats.auctionsPlayed + userRankRow.rating.winPercentage) /
              played
          );
          const next: UserProfile = {
            ...prev,
            stats: {
              ...prev.stats,
              auctionsPlayed: played,
              auctionsWon: won,
              bestRating: best,
              avgRating: avg,
            },
          };
          if (next.isGuest) {
            saveGuestProfile(next);
          } else if (firebaseUid) {
            void updateCloudUserProfile(firebaseUid, next).catch(() => {});
          }
          return next;
        });
      }

      if (auctionState.tournamentId) {
        setTournaments((prevList) => {
          const updated = prevList.map((t) => {
            if (t.id !== auctionState.tournamentId) return t;
            const roundStandings = ranked.map((r) => {
              const squadRating = r.rating.winPercentage;
              const budgetPoints = Math.round(r.rating.budgetEfficiencyScore * 0.25);
              const strategyPoints = Math.round(r.rating.balanceScore * 0.25);
              return {
                franchiseId: r.franchiseId,
                ownerName: r.team.ownerName,
                squadRating,
                budgetPoints,
                strategyPoints,
                totalRoundPoints: squadRating + budgetPoints + strategyPoints,
                rank: r.rank,
              };
            });

            const nextRounds = [
              ...t.rounds,
              {
                roundNumber: auctionState.tournamentRound ?? t.currentRound,
                auctionId: auctionState.roomId,
                completedAt: Date.now(),
                standings: roundStandings,
              },
            ];

            const nextCum = { ...t.cumulativeScores };
            for (const rs of roundStandings) {
              const prevScore = nextCum[rs.franchiseId];
              const newTotal = (prevScore?.totalPoints ?? 0) + rs.totalRoundPoints;
              const roundsCount = nextRounds.length;
              const prevAvgSum = (prevScore?.avgRating ?? 0) * (roundsCount - 1);
              nextCum[rs.franchiseId] = {
                franchiseId: rs.franchiseId,
                ownerName: rs.ownerName,
                totalPoints: newTotal,
                avgRating: Math.round((prevAvgSum + rs.squadRating) / roundsCount),
                roundsWon: (prevScore?.roundsWon ?? 0) + (rs.rank === 1 ? 1 : 0),
              };
            }

            const completed = nextRounds.length >= t.totalRounds;
            return {
              ...t,
              rounds: nextRounds,
              currentRound: completed ? t.totalRounds : nextRounds.length + 1,
              status: completed ? ('COMPLETED' as const) : ('ACTIVE' as const),
              cumulativeScores: nextCum,
            };
          });
          saveTournaments(updated);
          return updated;
        });
      }
    }
  };

  const handleOpenSavedAuction = (saved: SavedAuction) => {
    disconnectMultiplayer();
    savedIdsRef.current.add(saved.id);
    setUserFranchiseId(saved.userFranchiseId);
    setAuctionState(saved.stateSnapshot);
    setResultsCompeted(true);
    setResultsInitialXI(saved.userPlayingXIIds);
    setPage('results');
  };

  const handleDeleteLocalAuction = (id: string) => {
    setSavedAuctions(deleteSavedAuction(id));
    if (firebaseUid) {
      void deleteCloudAuctionHistory(firebaseUid, id)
        .then(() => setCloudSummaries((prev) => prev.filter((c) => c.id !== id)))
        .catch(() => {});
    }
  };

  const handleDeleteCloudAuction = (id: string) => {
    if (!firebaseUid) return;
    void deleteCloudAuctionHistory(firebaseUid, id)
      .then(() => setCloudSummaries((prev) => prev.filter((c) => c.id !== id)))
      .catch(() => {});
  };

  const navigateIfUnlocked = (target: AppPage) => {
    if (isLiveAuctionLocked) {
      showToast('Live Auction is locked. Pause for a break or click End Auction to exit.');
      return;
    }
    setPage(target);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#070B14] text-slate-900 dark:text-slate-100 transition-colors">
      {/* STRICT 3-ZONE TOP BAR WITH LIVE AUCTION NAVIGATION LOCK (REQ #3) */}
      <header className="sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800/90 bg-white/90 dark:bg-[#070B14]/90 backdrop-blur-md">
        <div
          className={`max-w-7xl mx-auto px-3 sm:px-6 flex items-center justify-between gap-4 sm:gap-6 ${
            isLiveAuctionLocked ? 'h-11 sm:h-14' : 'h-14 sm:h-16'
          }`}
        >
          {/* Zone 1: Brand Wordmark */}
          <button
            onClick={() => navigateIfUnlocked('home')}
            disabled={isLiveAuctionLocked}
            className={`font-display ${
              isLiveAuctionLocked ? 'text-base sm:text-xl' : 'text-xl sm:text-2xl'
            } font-extrabold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 ${
              isLiveAuctionLocked ? 'cursor-not-allowed opacity-90' : 'hover:text-amber-500 transition'
            }`}
          >
            IPL AUCTION ARENA
          </button>

          {/* Zone 2: Primary Navigation (Hidden & Locked during Live Auction per Req #3) */}
          {isLiveAuctionLocked ? (
            <div className="hidden md:flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs font-semibold text-amber-600 dark:text-amber-400">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              Live Auction Active — Use Pause to take a break, or End Auction to exit
            </div>
          ) : (
            <nav
              aria-label="Primary navigation"
              className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300"
            >
              {[
                { id: 'home' as AppPage, label: 'Arena' },
                { id: 'players' as AppPage, label: 'Players' },
                { id: 'tournaments' as AppPage, label: 'Tournaments' },
                { id: 'history' as AppPage, label: 'History' },
                { id: 'settings' as AppPage, label: 'Settings' },
              ].map((nav) => (
                <button
                  key={nav.id}
                  onClick={() => navigateIfUnlocked(nav.id)}
                  className={`whitespace-nowrap shrink-0 transition-colors pb-0.5 ${
                    page === nav.id
                      ? 'text-amber-500 border-b-2 border-amber-500 font-semibold'
                      : 'hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {nav.label}
                </button>
              ))}
            </nav>
          )}

          {/* Zone 3: Single Primary Action / Locked Badge */}
          <div className="shrink-0 flex items-center gap-2">
            {isLiveAuctionLocked ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-300">
                <Lock className="w-3.5 h-3.5 text-amber-500" />
                {FRANCHISE_MAP[userFranchiseId].shortName} Live
              </span>
            ) : (
              <button
                onClick={() => launchMode('SOLO', profile.favoriteFranchise)}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs whitespace-nowrap shrink-0 transition"
              >
                Play IPL 2027
              </button>
            )}
          </div>
        </div>

        {/* Mobile Compact Nav Row (hidden during Live Auction lock) */}
        {!isLiveAuctionLocked && (
          <div className="flex md:hidden items-center justify-around border-t border-slate-200 dark:border-slate-800/80 px-2 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400">
            {[
              { id: 'home' as AppPage, label: 'Arena' },
              { id: 'players' as AppPage, label: 'Players' },
              { id: 'tournaments' as AppPage, label: 'Cups' },
              { id: 'history' as AppPage, label: 'History' },
              { id: 'settings' as AppPage, label: 'Settings' },
            ].map((nav) => (
              <button
                key={nav.id}
                onClick={() => navigateIfUnlocked(nav.id)}
                className={`px-2 py-1 whitespace-nowrap ${
                  page === nav.id ? 'text-amber-500 font-semibold' : ''
                }`}
              >
                {nav.label}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* TOAST NOTIFICATION */}
      {toastMsg && (
        <div
          role="status"
          className="fixed top-20 right-4 z-50 rounded-xl bg-slate-900 dark:bg-slate-800 border border-amber-500/40 text-white px-4 py-2.5 text-xs font-medium shadow-xl"
        >
          {toastMsg}
        </div>
      )}

      {/* MAIN CONTENT VIEWPORT */}
      <main
        className={`max-w-7xl mx-auto ${
          page === 'auction'
            ? 'px-2.5 sm:px-6 pt-2 sm:pt-4'
            : 'px-4 sm:px-6 pt-6'
        }`}
      >
        {page === 'home' && (
          <HomeView
            players={players}
            profile={profile}
            savedAuctions={savedAuctions}
            onStartMode={(mode, fid) => launchMode(mode, fid)}
            onJoinRoomCode={joinMultiplayerRoom}
            onGoogleSignIn={() => void handleGoogleSignIn()}
            onNavigate={(target) => navigateIfUnlocked(target)}
            onInspectPlayer={setInspectedPlayer}
            onOpenSavedAuction={handleOpenSavedAuction}
          />
        )}

        {page === 'lobby' && auctionState && (
          <AuctionLobbyView
            state={auctionState}
            userFranchiseId={userFranchiseId}
            clientId={clientId}
            ownerName={profile.username}
            isMultiplayer={isMultiplayer}
            connectionStatus={connectionStatus}
            onUpdateOwnerName={(name) => handleUpdateProfile({ username: name })}
            onSelectFranchise={handleSelectFranchise}
            onToggleReady={() => mpClientRef.current?.toggleReady()}
            onUpdateLobbySettings={handleUpdateLobbySettings}
            onProceedToRetentions={handleProceedToRetentions}
            onLeave={() => {
              disconnectMultiplayer();
              setAuctionState(null);
              setPage('home');
            }}
          />
        )}

        {page === 'retention' && auctionState && (
          <RetentionRoomView
            state={auctionState}
            userFranchiseId={userFranchiseId}
            players={players}
            playerMap={playerMap}
            isHost={!isMultiplayer || auctionState.hostId === clientId}
            onConfirmRetentions={handleConfirmRetentions}
            onInspectPlayer={setInspectedPlayer}
          />
        )}

        {page === 'auction' && auctionState && (
          <AuctionRoomView
            state={auctionState}
            playerMap={playerMap}
            userFranchiseId={userFranchiseId}
            clientId={clientId}
            isMultiplayer={isMultiplayer}
            connectionStatus={connectionStatus}
            settings={settings}
            lastError={lastError}
            onPlaceBid={handlePlaceBid}
            onPass={handlePass}
            onRespondRtmOffer={handleRespondRtmOffer}
            onSubmitRtmCounter={handleSubmitRtmCounter}
            onRespondRtmFinalMatch={handleRespondRtmFinalMatch}
            onTogglePause={handleTogglePause}
            onNominatePlayer={handleNominatePlayer}
            onSkipPlayer4x={
              !isMultiplayer && auctionState.mode !== 'MULTIPLAYER'
                ? handleSkipPlayer4x
                : undefined
            }
            onSkipSet={
              !isMultiplayer && auctionState.mode !== 'MULTIPLAYER'
                ? handleSkipSet
                : undefined
            }
            onSimulateRemaining={handleSimulateRemaining}
            onEndAndExit={handleEndAndExit}
            onFinishNow={() => mpClientRef.current?.finishNow()}
            onInspectPlayer={setInspectedPlayer}
          />
        )}

        {page === 'results' && auctionState && (
          <PostAuctionResultsView
            state={auctionState}
            playerMap={playerMap}
            userFranchiseId={userFranchiseId}
            settings={settings}
            initialCompeted={resultsCompeted}
            initialUserXIIds={resultsInitialXI}
            onAutoFillMinSquad={handleAutoFillMinSquad}
            onConfirmPlayingXI={handleConfirmPlayingXI}
            onRematch={() => launchMode(auctionState.mode, userFranchiseId)}
            onBackHome={() => setPage('home')}
            onInspectPlayer={setInspectedPlayer}
          />
        )}

        {page === 'players' && (
          <PlayerDatabaseView players={players} onInspectPlayer={setInspectedPlayer} />
        )}

        {page === 'tournaments' && (
          <TournamentView
            tournaments={tournaments}
            profile={profile}
            onCreateTournament={(t) => {
              const next = [t, ...tournaments];
              setTournaments(next);
              saveTournaments(next);
              showToast(`Tournament "${t.name}" created!`);
            }}
            onStartRound={(t) =>
              launchMode('TOURNAMENT', t.userFranchiseId, {
                tournamentId: t.id,
                round: t.currentRound,
                rulesetId: t.rulesetId,
                difficulty: t.aiDifficulty,
              })
            }
            onDeleteTournament={(id) => {
              const next = tournaments.filter((t) => t.id !== id);
              setTournaments(next);
              saveTournaments(next);
            }}
          />
        )}

        {page === 'history' && (
          <HistoryView
            savedAuctions={savedAuctions}
            cloudSummaries={cloudSummaries}
            profile={profile}
            onGoogleSignIn={() => void handleGoogleSignIn()}
            onOpenAuction={handleOpenSavedAuction}
            onDeleteAuction={handleDeleteLocalAuction}
            onDeleteCloudAuction={handleDeleteCloudAuction}
            onStartNew={() => launchMode('SOLO', profile.favoriteFranchise)}
          />
        )}

        {page === 'settings' && (
          <SettingsView
            settings={settings}
            onUpdate={updateSettings}
            onReset={resetSettings}
            onOpenAdmin={() => navigateIfUnlocked('admin')}
          />
        )}

        {page === 'profile' && (
          <ProfileAuthView
            profile={profile}
            cloudSyncLoading={cloudSyncLoading}
            onGoogleSignIn={handleGoogleSignIn}
            onUpdateProfile={handleUpdateProfile}
            onAuthSuccess={(newProfile, token) => {
              setAuthToken(token);
              setProfile(newProfile);
              showToast(`Welcome, ${newProfile.username}!`);
            }}
            onSignOut={handleSignOut}
          />
        )}

        {page === 'admin' && (
          <AdminStudioView
            players={players}
            adminToken={adminToken}
            onAdminToken={setAdminToken}
            onPlayersUpdated={(updated) => setPlayers(updated)}
          />
        )}
      </main>

      {/* GLOBAL PLAYER DETAIL MODAL */}
      <PlayerDetailModal
        player={inspectedPlayer}
        onClose={() => setInspectedPlayer(null)}
        userTeam={auctionState?.teams[userFranchiseId]}
        playerMap={playerMap}
        boughtInfo={
          inspectedPlayer && auctionState
            ? (() => {
                for (const fid of ALL_FRANCHISE_IDS) {
                  const found = auctionState.teams[fid].squad.find(
                    (s) => s.playerId === inspectedPlayer.id
                  );
                  if (found) {
                    return { franchiseName: FRANCHISE_MAP[fid].name, priceCr: found.boughtPriceCr };
                  }
                }
                return undefined;
              })()
            : undefined
        }
      />

      {/* PWA OFFLINE INDICATOR */}
      <OfflineIndicator />
    </div>
  );
}
