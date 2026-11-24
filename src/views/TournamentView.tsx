import React, { useState } from 'react';
import { Trophy, Plus, Play, Trash2 } from 'lucide-react';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { SEASON_RULESETS } from '../data/rulesets';
import { AIDifficulty, FranchiseId, Tournament, UserProfile } from '../engine/types';
import { FranchiseBadge } from '../components/FranchiseBadge';

interface TournamentViewProps {
  tournaments: Tournament[];
  profile: UserProfile;
  onCreateTournament: (t: Tournament) => void;
  onStartRound: (tournament: Tournament) => void;
  onDeleteTournament: (id: string) => void;
}

export const TournamentView: React.FC<TournamentViewProps> = ({
  tournaments,
  profile,
  onCreateTournament,
  onStartRound,
  onDeleteTournament,
}) => {
  const [name, setName] = useState('Premier Franchise Cup 2027');
  const [rounds, setRounds] = useState(3);
  const [rulesetId, setRulesetId] = useState('sim-2026-quick');
  const [difficulty, setDifficulty] = useState<AIDifficulty>('HARD');
  const [franchiseId, setFranchiseId] = useState<FranchiseId>(profile.favoriteFranchise);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const cumulativeScores = {} as Tournament['cumulativeScores'];
    for (const fid of ALL_FRANCHISE_IDS) {
      cumulativeScores[fid] = {
        franchiseId: fid,
        ownerName:
          fid === franchiseId ? profile.username : `${FRANCHISE_MAP[fid].ownerPersona} (AI)`,
        totalPoints: 0,
        avgRating: 0,
        roundsWon: 0,
      };
    }

    const tournament: Tournament = {
      id: `trn_${Date.now().toString(36)}`,
      name: name.trim() || 'Auction Championship Series',
      createdAt: Date.now(),
      createdBy: profile.username,
      totalRounds: rounds,
      currentRound: 1,
      rulesetId,
      aiDifficulty: difficulty,
      userFranchiseId: franchiseId,
      status: 'ACTIVE',
      rounds: [],
      cumulativeScores,
    };
    onCreateTournament(tournament);
  };

  return (
    <div className="space-y-8 pb-16">
      <div>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white">
          Multi-Auction Tournaments
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Compete across multiple auction rounds. Cumulative tournament points combine Squad Rating,
          Budget Efficiency, and Strategic Balance.
        </p>
      </div>

      {/* Create Tournament Form */}
      <form
        onSubmit={handleCreate}
        className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 grid grid-cols-1 md:grid-cols-12 gap-4 items-end"
      >
        <div className="md:col-span-3 space-y-1">
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
            Tournament Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          />
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
            Your Franchise
          </label>
          <select
            value={franchiseId}
            onChange={(e) => setFranchiseId(e.target.value as FranchiseId)}
            className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          >
            {ALL_FRANCHISE_IDS.map((fid) => (
              <option key={fid} value={fid}>
                {FRANCHISE_MAP[fid].name}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
            Format
          </label>
          <select
            value={rulesetId}
            onChange={(e) => setRulesetId(e.target.value)}
            className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          >
            {SEASON_RULESETS.filter((r) => r.id !== 'sim-practice').map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
            Rounds & AI
          </label>
          <div className="flex gap-1.5">
            <select
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              className="w-1/2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-2 py-2 text-xs text-slate-900 dark:text-white"
            >
              {[2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} Rds
                </option>
              ))}
            </select>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as AIDifficulty)}
              className="w-1/2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-2 py-2 text-xs text-slate-900 dark:text-white"
            >
              <option value="NORMAL">Normal</option>
              <option value="HARD">Hard</option>
              <option value="EXPERT">Expert</option>
            </select>
          </div>
        </div>

        <div className="md:col-span-3">
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition"
          >
            <Plus className="w-4 h-4" />
            Create Tournament
          </button>
        </div>
      </form>

      {/* Active & Past Tournaments */}
      {tournaments.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 py-14 text-center space-y-2">
          <Trophy className="w-8 h-8 text-amber-500 mx-auto opacity-75" />
          <div className="font-display text-xl font-bold text-slate-900 dark:text-white">
            No Tournaments Created Yet
          </div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Launch a multi-round championship series above to test your drafting consistency across
            multiple auctions.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {tournaments.map((t) => {
            const standings = Object.values(t.cumulativeScores).sort(
              (a, b) => b.totalPoints - a.totalPoints
            );
            const leader = standings[0];
            return (
              <div
                key={t.id}
                className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="text-xs text-slate-500">
                      {t.status === 'COMPLETED' ? 'Completed Championship' : `Round ${t.currentRound} of ${t.totalRounds}`} ·{' '}
                      AI {t.aiDifficulty} · Your Franchise: {FRANCHISE_MAP[t.userFranchiseId].name}
                    </div>
                    <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white mt-0.5">
                      {t.name}
                    </h2>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {t.status === 'ACTIVE' && (
                      <button
                        onClick={() => onStartRound(t)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Play Round {t.currentRound}
                      </button>
                    )}
                    <button
                      onClick={() => onDeleteTournament(t.id)}
                      className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                      title="Delete Tournament"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Top 5 Cumulative Standings */}
                <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
                  {standings.slice(0, 5).map((row, idx) => (
                    <div
                      key={row.franchiseId}
                      className={`rounded-xl p-3 border ${
                        row.franchiseId === t.userFranchiseId
                          ? 'bg-sky-500/10 border-sky-500/40'
                          : idx === 0 && t.rounds.length > 0
                          ? 'bg-amber-500/10 border-amber-500/40'
                          : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono-num text-xs font-bold text-slate-400">#{idx + 1}</span>
                        <FranchiseBadge franchiseId={row.franchiseId} size="xs" />
                        <span className="font-display font-bold text-sm text-slate-900 dark:text-white">
                          {row.franchiseId}
                        </span>
                      </div>
                      <div className="font-mono-num text-lg font-extrabold text-amber-500 mt-1.5">
                        {row.totalPoints} pts
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Avg {row.avgRating}/100 · {row.roundsWon} Wins
                      </div>
                    </div>
                  ))}
                </div>

                {t.status === 'COMPLETED' && leader && (
                  <div className="text-xs font-semibold text-emerald-500">
                    Tournament Champion: {FRANCHISE_MAP[leader.franchiseId].name} ({leader.totalPoints} pts)
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
