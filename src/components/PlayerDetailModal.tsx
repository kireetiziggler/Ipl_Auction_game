import React from 'react';
import { X, ShieldCheck, TrendingUp, AlertTriangle } from 'lucide-react';
import { COUNTRY_FLAGS } from '../data/players';
import { getPlayerRetentionCostCr } from '../data/retentions';
import { formatCr } from '../data/rulesets';
import { Player, TeamState } from '../engine/types';
import { PlayerAvatar } from './PlayerAvatar';

interface PlayerDetailModalProps {
  player: Player | null;
  onClose: () => void;
  userTeam?: TeamState;
  playerMap?: Record<string, Player>;
  boughtInfo?: { franchiseName: string; priceCr: number };
}

export const PlayerDetailModal: React.FC<PlayerDetailModalProps> = ({
  player,
  onClose,
  userTeam,
  playerMap,
  boughtInfo,
}) => {
  if (!player) return null;

  let suitabilityNote: string | null = null;
  if (userTeam && playerMap) {
    const roleCount = userTeam.squad
      .map((s) => playerMap[s.playerId])
      .filter((p) => p && p.primaryRole === player.primaryRole).length;
    if (roleCount === 0) {
      suitabilityNote = `High Fit: Fills an immediate ${player.primaryRole} vacancy in your squad.`;
    } else if (roleCount <= 2) {
      suitabilityNote = `Good Fit: Strengthens your ${player.primaryRole.toLowerCase()} core.`;
    } else {
      suitabilityNote = `Depth Pick: You already have ${roleCount} ${player.primaryRole.toLowerCase()}s — bid selectively for balance.`;
    }
  }

  const ref2026Price = getPlayerRetentionCostCr(player);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${player.name} scouting profile`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-6 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-4">
            <PlayerAvatar player={player} size="lg" />
            <div>
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {player.category} · {player.isCapped ? 'Capped' : 'Uncapped'} · {player.country}{' '}
                {COUNTRY_FLAGS[player.countryCode] ?? ''} ·{' '}
                {player.isOverseas ? 'Overseas' : 'Indian'}
              </div>
              <h2 className="font-display text-3xl font-bold tracking-tight text-slate-900 dark:text-white mt-0.5">
                {player.name}
              </h2>
              <div className="text-sm text-slate-600 dark:text-slate-300 mt-1">
                {player.secondaryRole} · Age {player.age} · {player.battingStyle}
                {player.bowlingStyle !== 'None' ? ` · ${player.bowlingStyle}` : ''}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-slate-500 dark:text-slate-400">
                <span>
                  Base Price:{' '}
                  <strong className="font-mono-num text-slate-900 dark:text-slate-100">
                    {formatCr(player.basePriceCr)}
                  </strong>
                </span>
                <span>
                  IPL 2026 Price:{' '}
                  <strong className="font-mono-num text-amber-500">
                    {formatCr(ref2026Price)}
                  </strong>
                </span>
                {player.ipl2025Franchise && (
                  <span>
                    RTM Eligible Team:{' '}
                    <strong className="text-sky-500">{player.ipl2025Franchise}</strong>
                  </span>
                )}
              </div>
              {boughtInfo && (
                <div className="mt-2 text-xs font-semibold text-emerald-500">
                  Signed by {boughtInfo.franchiseName} for{' '}
                  <span className="font-mono-num">{formatCr(boughtInfo.priceCr)}</span>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Close player details"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {suitabilityNote && (
            <div className="rounded-xl bg-sky-500/10 border border-sky-500/25 px-4 py-3 text-sm text-sky-900 dark:text-sky-200 flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-sky-500 shrink-0" />
              <span>{suitabilityNote}</span>
            </div>
          )}

          {/* Career IPL Statistics */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                Career T20 & IPL Statistics
              </h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {player.dataSource}
              </span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {[
                { label: 'Matches', value: player.stats.matches },
                { label: 'Runs', value: player.stats.runs },
                { label: 'Bat Avg', value: player.stats.battingAvg > 0 ? player.stats.battingAvg.toFixed(1) : '-' },
                { label: 'Strike Rate', value: player.stats.strikeRate > 0 ? player.stats.strikeRate.toFixed(1) : '-' },
                { label: '50s / 100s', value: `${player.stats.fifties}/${player.stats.hundreds}` },
                { label: 'Highest', value: player.stats.highestScore },
                { label: 'Wickets', value: player.stats.wickets },
                { label: 'Economy', value: player.stats.economy > 0 ? player.stats.economy.toFixed(2) : '-' },
                { label: 'Bowl Avg', value: player.stats.bowlingAvg > 0 ? player.stats.bowlingAvg.toFixed(1) : '-' },
                { label: 'Bowl SR', value: player.stats.bowlingStrikeRate > 0 ? player.stats.bowlingStrikeRate.toFixed(1) : '-' },
                { label: 'Best Bowl', value: player.stats.bestBowling },
                { label: 'Catches', value: player.stats.catches },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-lg bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 px-3 py-2.5"
                >
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{stat.label}</div>
                  <div className="font-mono-num text-base font-bold text-slate-900 dark:text-white mt-0.5">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Seasons */}
          {player.recentSeasons.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-2.5">
                Recent Season Form
              </h3>
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-900/90 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="py-2 px-3 font-medium">Season</th>
                      <th className="py-2 px-3 font-medium">Franchise</th>
                      <th className="py-2 px-3 font-medium text-right">Matches</th>
                      <th className="py-2 px-3 font-medium text-right">Runs</th>
                      <th className="py-2 px-3 font-medium text-right">SR</th>
                      <th className="py-2 px-3 font-medium text-right">Wkts</th>
                      <th className="py-2 px-3 font-medium text-right">Econ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono-num">
                    {player.recentSeasons.map((rs) => (
                      <tr key={rs.season} className="text-slate-800 dark:text-slate-200">
                        <td className="py-2 px-3 font-semibold">{rs.season}</td>
                        <td className="py-2 px-3 font-sans">{rs.team}</td>
                        <td className="py-2 px-3 text-right">{rs.matches}</td>
                        <td className="py-2 px-3 text-right">{rs.runs}</td>
                        <td className="py-2 px-3 text-right">{rs.strikeRate.toFixed(1)}</td>
                        <td className="py-2 px-3 text-right">{rs.wickets}</td>
                        <td className="py-2 px-3 text-right">
                          {rs.economy > 0 ? rs.economy.toFixed(2) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Strengths & Weaknesses */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-2">
                <TrendingUp className="w-4 h-4" />
                Scouting Strengths
              </div>
              <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-300">
                {player.strengths.map((s) => (
                  <li key={s}>• {s}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                <AlertTriangle className="w-4 h-4" />
                Watch-Outs & Risks
              </div>
              <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-300">
                {player.weaknesses.map((w) => (
                  <li key={w}>• {w}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="text-[11px] text-slate-500 dark:text-slate-500 pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span>
              {player.previousFranchises.length > 0
                ? `Past IPL Franchises: ${player.previousFranchises.join(', ')}`
                : 'New IPL Auction Entrant'}
            </span>
            <span>Specialties: {player.specialtyTags.join(' · ')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
