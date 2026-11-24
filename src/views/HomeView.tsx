import React, { useState } from 'react';
import {
  Play,
  Users,
  Zap,
  Trophy,
  BookOpen,
  ArrowRight,
  GraduationCap,
  History,
  Settings,
  Database,
  Shield,
  Sparkles,
  LogIn,
} from 'lucide-react';
import { FRANCHISES } from '../data/franchises';
import { getPlayerRetentionCostCr } from '../data/retentions';
import { formatCr } from '../data/rulesets';
import { FranchiseId, GameMode, Player, SavedAuction, UserProfile } from '../engine/types';
import { FranchiseBadge } from '../components/FranchiseBadge';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { PWAInstallButton } from '../components/PWAInstallButton';

interface HomeViewProps {
  players: Player[];
  profile: UserProfile;
  savedAuctions: SavedAuction[];
  onStartMode: (mode: GameMode, preselectedFranchise?: FranchiseId) => void;
  onJoinRoomCode: (code: string) => void;
  onGoogleSignIn?: () => void;
  onNavigate: (
    page: 'players' | 'tournaments' | 'history' | 'settings' | 'admin' | 'profile'
  ) => void;
  onInspectPlayer: (player: Player) => void;
  onOpenSavedAuction: (auction: SavedAuction) => void;
}

const HERO_IMG = '/src/assets/images/hero_stadium_arena_1795354541599.jpg';

export const HomeView: React.FC<HomeViewProps> = ({
  players,
  profile,
  savedAuctions,
  onStartMode,
  onJoinRoomCode,
  onGoogleSignIn,
  onNavigate,
  onInspectPlayer,
  onOpenSavedAuction,
}) => {
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [showTutorial, setShowTutorial] = useState(false);

  const marqueePlayers = players
    .filter(
      (p) =>
        p.category === 'Marquee Set 1' ||
        p.category === 'Marquee Set 2' ||
        p.category === 'Marquee'
    )
    .sort((a, b) => getPlayerRetentionCostCr(b) - getPlayerRetentionCostCr(a))
    .slice(0, 6);

  const latestAuction = savedAuctions[0];

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = roomCodeInput.trim().toUpperCase();
    if (cleaned.length >= 4) {
      onJoinRoomCode(cleaned);
    }
  };

  return (
    <div className="space-y-12 pb-16">
      {/* FLOODLIT BROADCAST HERO SECTION */}
      <section className="relative overflow-hidden rounded-3xl border border-amber-500/20 bg-[#060A14] shadow-2xl shadow-slate-950/60">
        <img
          src={HERO_IMG}
          alt="Floodlit IPL cricket auction stadium stage at night"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-50 scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#060A14] via-[#060A14]/85 to-[#060A14]/45" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#060A14] via-transparent to-amber-500/10" />

        <div className="relative z-10 px-6 py-12 sm:px-10 sm:py-16 lg:px-14 lg:py-20 grid grid-cols-1 lg:grid-cols-12 gap-8 items-end">
          <div className="lg:col-span-8 space-y-5">
            <div className="inline-flex items-center gap-2 text-xs font-bold tracking-widest uppercase text-amber-400">
              <Sparkles className="w-3.5 h-3.5" />
              IPL 2027 Mega Auction · 12 Official Sets · {players.length} Players · Retentions & RTM
            </div>
            <h1 className="font-display text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white leading-[0.94]">
              IPL AUCTION{' '}
              <span className="bg-gradient-to-r from-amber-300 via-amber-400 to-orange-500 bg-clip-text text-transparent">
                ARENA
              </span>
            </h1>
            <p className="text-base sm:text-lg text-slate-200 max-w-2xl leading-relaxed">
              Lock your franchise retentions, deploy Right To Match cards in live bidding wars,
              scout real career numbers across all 12 IPL sets, and pick your championship Playing XI
              to lift the trophy.
            </p>

            {/* Primary CTA + Secondary Actions */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                onClick={() => onStartMode('SOLO', profile.favoriteFranchise)}
                className="inline-flex items-center gap-2.5 px-7 py-4 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 text-slate-950 font-display font-extrabold text-base tracking-wide hover:from-amber-300 hover:to-amber-400 active:scale-[0.99] transition whitespace-nowrap shrink-0 shadow-xl shadow-amber-500/25"
              >
                <Play className="w-4 h-4 fill-current" />
                Play Solo Mega Auction
              </button>

              <button
                onClick={() => onStartMode('MULTIPLAYER', profile.favoriteFranchise)}
                className="inline-flex items-center gap-2 px-5 py-4 rounded-xl bg-white/10 hover:bg-white/15 text-white border border-white/15 font-semibold text-sm backdrop-blur-sm transition whitespace-nowrap shrink-0"
              >
                <Users className="w-4 h-4 text-sky-400" />
                Play with Friends
              </button>

              <button
                onClick={() => onStartMode('QUICK', profile.favoriteFranchise)}
                className="inline-flex items-center gap-2 px-5 py-4 rounded-xl bg-white/5 hover:bg-white/10 text-slate-100 border border-white/10 font-semibold text-sm transition whitespace-nowrap shrink-0"
              >
                <Zap className="w-4 h-4 text-amber-400" />
                Quick Blitz
              </button>

              <PWAInstallButton variant="compact" />
            </div>
          </div>

          {/* Join Room & Account Quick Box */}
          <div className="lg:col-span-4 rounded-2xl bg-slate-950/85 backdrop-blur-md border border-slate-700/70 p-5 space-y-4 shadow-xl">
            <div className="space-y-1">
              <div className="text-sm font-bold text-white">Join a Live Multiplayer Room</div>
              <p className="text-xs text-slate-400">
                Enter a 6-character room code shared by your friend to claim a franchise and bid live.
              </p>
            </div>
            <form onSubmit={handleJoinSubmit} className="flex gap-2">
              <input
                type="text"
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase().slice(0, 8))}
                placeholder="e.g. K7M4P9"
                aria-label="Private room code"
                className="flex-1 min-w-0 rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2.5 text-sm font-mono-num uppercase tracking-widest text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
              />
              <button
                type="submit"
                disabled={roomCodeInput.trim().length < 4}
                className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold text-sm transition whitespace-nowrap shrink-0"
              >
                Join
              </button>
            </form>

            <div className="pt-3 border-t border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span className="truncate">
                  Owner: <strong className="text-white">{profile.username}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate('profile')}
                  className="text-amber-400 hover:text-amber-300 font-semibold shrink-0"
                >
                  {profile.isGuest ? 'Account' : 'Profile'}
                </button>
              </div>
              {profile.isGuest && onGoogleSignIn && (
                <button
                  type="button"
                  onClick={onGoogleSignIn}
                  className="w-full py-2.5 px-3 rounded-lg bg-white hover:bg-slate-100 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 transition"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Sign in with Google to Save History
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* GAME MODES & ECOSYSTEM GRID */}
      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white">
              Game Modes & Command Center
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              Play offline solo anytime, host 10-player live rooms, or run multi-round championship series.
            </p>
          </div>
          <button
            onClick={() => setShowTutorial((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-500 hover:text-amber-400 whitespace-nowrap shrink-0"
          >
            <BookOpen className="w-4 h-4" />
            {showTutorial ? 'Hide Guide' : 'How to Play'}
          </button>
        </div>

        {showTutorial && (
          <div className="rounded-2xl bg-slate-50 dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="font-bold text-slate-900 dark:text-white">1. Franchise & Retentions</div>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                Pick your franchise and retain up to 6 core stars at exact IPL 2027 prices. Unused slots become live RTM cards.
              </p>
            </div>
            <div>
              <div className="font-bold text-slate-900 dark:text-white">2. Bid & Deploy RTM Cards</div>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                Outbid AI and friends across 12 authentic sets. Exercise Right To Match when rivals win your released stars.
              </p>
            </div>
            <div>
              <div className="font-bold text-slate-900 dark:text-white">3. Pause Anytime, No Interruptions</div>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                Need a break? Pause the auction to freeze the exact lot and countdown, then resume without losing a beat.
              </p>
            </div>
            <div>
              <div className="font-bold text-slate-900 dark:text-white">4. Pick Playing XI & Compete</div>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                Select your best Playing XI from your final squad and compete on real player performance metrics to win the title!
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              title: 'Full IPL 2027 Mega Auction',
              meta: `₹120 Cr Purse · 12 IPL Sets · ${players.length} Players`,
              desc: 'Complete pre-auction retentions, real IPL 3-stage RTM battles, and unsold accelerated re-entry round.',
              icon: Trophy,
              action: () => onStartMode('FULL', profile.favoriteFranchise),
              cta: 'Launch Mega Auction',
            },
            {
              title: 'Tournament Mode',
              meta: 'Multi-Round Series · Cumulative Standings',
              desc: 'Compete across 2 to 5 auction seasons combining Playing XI strength, budget craft, and strategy.',
              icon: Shield,
              action: () => onNavigate('tournaments'),
              cta: 'Open Tournaments',
            },
            {
              title: 'Practice Sandbox',
              meta: 'Unranked · Relaxed Timer · Learn RTM & AI',
              desc: 'Experiment with retention strategies, purse splits, and RTM counter-bids without affecting stats.',
              icon: GraduationCap,
              action: () => onStartMode('PRACTICE', profile.favoriteFranchise),
              cta: 'Enter Practice',
            },
            {
              title: 'IPL 2027 Player Pool',
              meta: `${players.length} Players · All 12 Official Sets`,
              desc: 'Scout every capped & uncapped cricketer with real IPL career stats, base prices, and IPL 2027 franchises.',
              icon: Database,
              action: () => onNavigate('players'),
              cta: 'Scout Full Pool',
            },
            {
              title: 'Saved History & Replays',
              meta: `${savedAuctions.length} Saved Session${savedAuctions.length === 1 ? '' : 's'}`,
              desc: 'Revisit completed auctions synced to your account, review Playing XIs, and scrub full bid timelines.',
              icon: History,
              action: () => onNavigate('history'),
              cta: 'View History',
            },
            {
              title: 'Arena Settings & Studio',
              meta: 'Theme · Stadium SFX · Rules · Custom Pool',
              desc: 'Customize visual theme, stadium effects, high-bid protection, or import custom player pools.',
              icon: Settings,
              action: () => onNavigate('settings'),
              cta: 'Configure Arena',
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.title}
                onClick={item.action}
                className="group text-left rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 hover:border-amber-500/60 hover:shadow-lg hover:shadow-amber-500/5 p-5 transition-all flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {item.meta}
                    </span>
                    <Icon className="w-4 h-4 text-slate-400 group-hover:text-amber-400 transition-colors" />
                  </div>
                  <h3 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                    {item.title}
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                    {item.desc}
                  </p>
                </div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-500 group-hover:translate-x-0.5 transition-transform">
                  {item.cta}
                  <ArrowRight className="w-3.5 h-3.5" />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* LATEST SAVED AUCTION BANNER */}
      {latestAuction && (
        <section className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <FranchiseBadge franchiseId={latestAuction.userFranchiseId} size="lg" />
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Latest Completed Auction · {latestAuction.rulesetName} ·{' '}
                {new Date(latestAuction.completedAt).toLocaleDateString()}
              </div>
              <div className="font-display text-xl font-bold text-slate-900 dark:text-white mt-0.5">
                Finished #{latestAuction.userRank} · Championship Strength{' '}
                <span className="font-mono-num text-amber-500">{latestAuction.userScore}%</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => onOpenSavedAuction(latestAuction)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 dark:hover:bg-slate-700 text-white text-xs font-semibold transition whitespace-nowrap shrink-0"
          >
            Inspect Results & Replay
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </section>
      )}

      {/* FEATURED MARQUEE PLAYERS (Realistic Photos, Zero OVR Spoilers) */}
      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white">
              Marquee Auction Headliners
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              Tap any cricketer to study their real IPL career record, recent form, and 2027 retention value.
            </p>
          </div>
          <button
            onClick={() => onNavigate('players')}
            className="text-xs font-bold text-amber-500 hover:text-amber-400 whitespace-nowrap shrink-0"
          >
            Explore All {players.length} Players →
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {marqueePlayers.map((player) => (
            <button
              key={player.id}
              onClick={() => onInspectPlayer(player)}
              className="group text-left rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 hover:border-amber-500/60 hover:shadow-lg p-4 transition-all flex items-center gap-4"
            >
              <PlayerAvatar player={player} size="lg" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {player.country} · {player.secondaryRole}
                </div>
                <div className="font-display text-xl font-bold text-slate-900 dark:text-white group-hover:text-amber-500 transition-colors truncate">
                  {player.name}
                </div>
                <div className="flex items-center gap-2.5 text-xs font-mono-num text-slate-600 dark:text-slate-300 pt-1">
                  {player.primaryRole === 'Fast Bowler' || player.primaryRole === 'Spinner' ? (
                    <>
                      <span>{player.stats.wickets} Wkts</span>
                      <span>·</span>
                      <span>Econ {player.stats.economy.toFixed(2)}</span>
                    </>
                  ) : (
                    <>
                      <span>{player.stats.runs} Runs</span>
                      <span>·</span>
                      <span>SR {player.stats.strikeRate.toFixed(1)}</span>
                    </>
                  )}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 pt-1">
                  Base{' '}
                  <span className="font-mono-num text-slate-900 dark:text-slate-200 font-semibold">
                    {formatCr(player.basePriceCr)}
                  </span>
                  {' · '}
                  2027{' '}
                  <span className="font-mono-num text-amber-500 font-bold">
                    {formatCr(getPlayerRetentionCostCr(player))}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ALL 10 IPL FRANCHISES */}
      <section className="space-y-4">
        <div>
          <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white">
            Select a Franchise to Lead
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Each franchise brings its real IPL 2027 retention pool and a unique AI strategy persona.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {FRANCHISES.map((f) => (
            <button
              key={f.id}
              onClick={() => onStartMode('SOLO', f.id)}
              className="group text-left rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 hover:border-amber-500/60 p-4 transition-all space-y-3"
            >
              <div className="flex items-center gap-3">
                <FranchiseBadge franchiseId={f.id} size="md" />
                <div className="min-w-0">
                  <div className="font-display text-lg font-bold text-slate-900 dark:text-white truncate">
                    {f.name}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {f.city}
                  </div>
                </div>
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
                {f.strategyLabel}
              </div>
              <div className="text-[11px] font-bold text-amber-500 opacity-90 group-hover:opacity-100">
                Lead {f.shortName} →
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="pt-6 border-t border-slate-200 dark:border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-slate-500">
        <div>
          IPL Auction Arena · Fan-made IPL 2027 auction strategy simulator with real career stats,
          pre-auction retentions, RTM rules, and Playing XI championship competition.
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <button onClick={() => onNavigate('admin')} className="hover:text-slate-300">
            Admin Studio
          </button>
          <button onClick={() => onNavigate('settings')} className="hover:text-slate-300">
            Settings
          </button>
        </div>
      </footer>
    </div>
  );
};
