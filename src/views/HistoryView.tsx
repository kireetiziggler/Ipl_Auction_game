import React from 'react';
import { History, Trash2, ArrowRight, Cloud, Trophy, LogIn } from 'lucide-react';
import { FRANCHISE_MAP } from '../data/franchises';
import { SavedAuction, UserProfile } from '../engine/types';
import { CloudAuctionSummary } from '../services/firebase';
import { FranchiseBadge } from '../components/FranchiseBadge';

interface HistoryViewProps {
  savedAuctions: SavedAuction[];
  cloudSummaries: CloudAuctionSummary[];
  profile: UserProfile;
  onGoogleSignIn: () => void;
  onOpenAuction: (auction: SavedAuction) => void;
  onDeleteAuction: (id: string) => void;
  onDeleteCloudAuction: (id: string) => void;
  onStartNew: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  savedAuctions,
  cloudSummaries,
  profile,
  onGoogleSignIn,
  onOpenAuction,
  onDeleteAuction,
  onDeleteCloudAuction,
  onStartNew,
}) => {
  const localIds = new Set(savedAuctions.map((s) => s.id));
  const cloudOnly = cloudSummaries.filter((c) => !localIds.has(c.id));
  const isGoogleSignedIn = !profile.isGuest && profile.authProvider === 'google';

  return (
    <div className="space-y-6 pb-16">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white">
            Auction History & Saved Replays
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Revisit completed IPL 2027 auctions, inspect Playing XI championship results, and replay every bid.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isGoogleSignedIn ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              <Cloud className="w-3.5 h-3.5" />
              Cloud Synced ({profile.email})
            </span>
          ) : (
            <button
              onClick={onGoogleSignIn}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-950 font-bold text-xs whitespace-nowrap transition hover:opacity-90"
            >
              <LogIn className="w-3.5 h-3.5" />
              Sign in with Google to Sync
            </button>
          )}
          <button
            onClick={onStartNew}
            className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs whitespace-nowrap transition"
          >
            New Auction
          </button>
        </div>
      </div>

      {savedAuctions.length === 0 && cloudOnly.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 py-16 text-center space-y-3">
          <History className="w-8 h-8 text-slate-400 mx-auto" />
          <div className="font-display text-xl font-bold text-slate-900 dark:text-white">
            No Completed Auctions Saved Yet
          </div>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Finish a Solo, Quick, or Multiplayer auction and lock your Playing XI to compete — every game is automatically saved here.
          </p>
          <button
            onClick={onStartNew}
            className="mt-2 px-5 py-2.5 rounded-xl bg-amber-500 text-slate-950 font-bold text-xs"
          >
            Play Your First Auction
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {savedAuctions.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {savedAuctions.map((a) => {
                const isCloudBacked = cloudSummaries.some((c) => c.id === a.id);
                return (
                  <div
                    key={a.id}
                    className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 flex flex-col justify-between gap-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <FranchiseBadge franchiseId={a.userFranchiseId} size="lg" />
                        <div>
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span>
                              {a.mode} · {a.rulesetName} · {new Date(a.completedAt).toLocaleDateString()}
                            </span>
                            {isCloudBacked && (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
                                <Cloud className="w-3 h-3" /> Synced
                              </span>
                            )}
                          </div>
                          <div className="font-display text-2xl font-bold text-slate-900 dark:text-white mt-0.5">
                            {FRANCHISE_MAP[a.userFranchiseId].name}
                          </div>
                          <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 tabular-nums">
                            Finished{' '}
                            <strong className="text-amber-500">
                              #{a.userRank}
                              {a.userRank === 1 ? ' Champion' : ''}
                            </strong>{' '}
                            · Win Strength{' '}
                            <span className="font-mono-num font-bold">{a.userScore}%</span> · Winner:{' '}
                            {FRANCHISE_MAP[a.winnerFranchiseId].shortName} ({a.winnerScore}%)
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => onDeleteAuction(a.id)}
                        className="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                        aria-label="Delete saved auction"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <button
                      onClick={() => onOpenAuction(a)}
                      className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-900 dark:text-white transition"
                    >
                      Open Championship Leaderboard, Playing XI & Replay
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {cloudOnly.length > 0 && (
            <div className="space-y-3">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Cloud className="w-5 h-5 text-emerald-500" />
                Cloud-Synced Past Games (From Other Devices)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {cloudOnly.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 flex items-start justify-between gap-3"
                  >
                    <div className="flex items-center gap-3">
                      <FranchiseBadge franchiseId={c.userFranchiseId} size="lg" />
                      <div>
                        <div className="text-xs text-slate-500">
                          {c.mode} · {c.rulesetName} · {new Date(c.completedAt).toLocaleDateString()}
                        </div>
                        <div className="font-display text-xl font-bold text-slate-900 dark:text-white mt-0.5">
                          {FRANCHISE_MAP[c.userFranchiseId].name}
                        </div>
                        <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 flex items-center gap-1.5 tabular-nums">
                          {c.userRank === 1 && <Trophy className="w-3.5 h-3.5 text-amber-500" />}
                          Finished <strong className="text-amber-500">#{c.userRank}</strong> · Win Strength{' '}
                          <span className="font-mono-num font-bold">{c.userScore}%</span> · Winner:{' '}
                          {FRANCHISE_MAP[c.winnerFranchiseId].shortName} ({c.winnerScore}%)
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1">
                          Squad: {c.userSquadPlayerIds.length} players · Playing XI: {c.userPlayingXIIds.length}/11
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => onDeleteCloudAuction(c.id)}
                      className="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                      aria-label="Delete cloud history entry"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
