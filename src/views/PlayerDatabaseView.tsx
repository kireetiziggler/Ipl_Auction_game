import React, { useMemo, useState } from 'react';
import { Search, SlidersHorizontal, ArrowUpDown } from 'lucide-react';
import { COUNTRY_FLAGS } from '../data/players';
import { getPlayerRetentionCostCr } from '../data/retentions';
import { FULL_IPL_SET_ORDER, formatCr } from '../data/rulesets';
import { AuctionCategory, Player, PrimaryRole } from '../engine/types';
import { PlayerAvatar } from '../components/PlayerAvatar';

interface PlayerDatabaseViewProps {
  players: Player[];
  onInspectPlayer: (player: Player) => void;
}

type SortKey = 'basePriceCr' | 'ipl2026Price' | 'matches' | 'runs' | 'strikeRate' | 'wickets' | 'economy' | 'age';

export const PlayerDatabaseView: React.FC<PlayerDatabaseViewProps> = ({
  players,
  onInspectPlayer,
}) => {
  const [query, setQuery] = useState('');
  const [nationality, setNationality] = useState<'ALL' | 'INDIAN' | 'OVERSEAS'>('ALL');
  const [capFilter, setCapFilter] = useState<'ALL' | 'CAPPED' | 'UNCAPPED'>('ALL');
  const [role, setRole] = useState<'ALL' | PrimaryRole>('ALL');
  const [category, setCategory] = useState<'ALL' | AuctionCategory>('ALL');
  const [sortBy, setSortBy] = useState<SortKey>('ipl2026Price');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return players
      .filter((p) => {
        if (nationality === 'INDIAN' && p.isOverseas) return false;
        if (nationality === 'OVERSEAS' && !p.isOverseas) return false;
        if (capFilter === 'CAPPED' && !p.isCapped) return false;
        if (capFilter === 'UNCAPPED' && p.isCapped) return false;
        if (role !== 'ALL' && p.primaryRole !== role) return false;
        if (category !== 'ALL' && p.category !== category) return false;
        if (q) {
          const hay = `${p.name} ${p.country} ${p.secondaryRole} ${p.category} ${p.previousFranchises.join(' ')} ${p.ipl2025Franchise ?? ''} ${p.specialtyTags.join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const getVal = (p: Player): number => {
          switch (sortBy) {
            case 'ipl2026Price': return getPlayerRetentionCostCr(p);
            case 'basePriceCr': return p.basePriceCr;
            case 'matches': return p.stats.matches;
            case 'runs': return p.stats.runs;
            case 'strikeRate': return p.stats.strikeRate;
            case 'wickets': return p.stats.wickets;
            case 'economy': return p.stats.economy > 0 ? p.stats.economy : 99;
            case 'age': return p.age;
          }
        };
        const diff = getVal(a) - getVal(b);
        return sortDir === 'desc' ? -diff : diff;
      });
  }, [players, query, nationality, capFilter, role, category, sortBy, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir(key === 'economy' || key === 'age' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="space-y-6 pb-16">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white">
            IPL 2027 Complete Auction Pool
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            {filtered.length} of {players.length} players organized across 12 authentic IPL auction sets (sold, unsold & uncapped domestic stars).
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="rounded-xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-3 relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search player, country, franchise..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
          />
        </div>

        <div className="md:col-span-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as 'ALL' | AuctionCategory)}
            className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-900 dark:text-white"
          >
            <option value="ALL">All 12 IPL Sets</option>
            {FULL_IPL_SET_ORDER.map((setLabel) => (
              <option key={setLabel} value={setLabel}>
                {setLabel}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'ALL' | PrimaryRole)}
            className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-900 dark:text-white"
          >
            <option value="ALL">All Roles</option>
            <option value="Batter">Batter</option>
            <option value="Wicketkeeper">Wicketkeeper</option>
            <option value="All-rounder">All-rounder</option>
            <option value="Fast Bowler">Fast Bowler</option>
            <option value="Spinner">Spinner</option>
          </select>
        </div>

        <div className="md:col-span-3 grid grid-cols-2 gap-2">
          <select
            value={nationality}
            onChange={(e) => setNationality(e.target.value as 'ALL' | 'INDIAN' | 'OVERSEAS')}
            className="w-full px-2.5 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-900 dark:text-white"
          >
            <option value="ALL">All Nations</option>
            <option value="INDIAN">Indian</option>
            <option value="OVERSEAS">Overseas</option>
          </select>

          <select
            value={capFilter}
            onChange={(e) => setCapFilter(e.target.value as 'ALL' | 'CAPPED' | 'UNCAPPED')}
            className="w-full px-2.5 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-900 dark:text-white"
          >
            <option value="ALL">Capped & Uncapped</option>
            <option value="CAPPED">Capped Only</option>
            <option value="UNCAPPED">Uncapped Only</option>
          </select>
        </div>

        <div className="md:col-span-2 flex items-center gap-1.5">
          <SlidersHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
          <select
            value={sortBy}
            onChange={(e) => toggleSort(e.target.value as SortKey)}
            className="w-full px-2.5 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-900 dark:text-white"
          >
            <option value="ipl2026Price">Sort: IPL 2027 Price</option>
            <option value="basePriceCr">Sort: Base Price</option>
            <option value="matches">Sort: Matches</option>
            <option value="runs">Sort: Career Runs</option>
            <option value="strikeRate">Sort: Strike Rate</option>
            <option value="wickets">Sort: Wickets</option>
            <option value="economy">Sort: Economy</option>
            <option value="age">Sort: Age</option>
          </select>
        </div>
      </div>

      {/* High-Density Scouting Table (Zero hidden OVR spoilers) */}
      <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-900/80 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-3 px-4 font-semibold">Player</th>
                <th className="py-3 px-3 font-semibold">IPL Auction Set</th>
                <th className="py-3 px-3 font-semibold">2027 Team</th>
                <th className="py-3 px-3 font-semibold text-right cursor-pointer" onClick={() => toggleSort('matches')}>
                  Mat
                </th>
                <th className="py-3 px-3 font-semibold text-right cursor-pointer" onClick={() => toggleSort('runs')}>
                  Runs
                </th>
                <th className="py-3 px-3 font-semibold text-right cursor-pointer" onClick={() => toggleSort('strikeRate')}>
                  SR
                </th>
                <th className="py-3 px-3 font-semibold text-right cursor-pointer" onClick={() => toggleSort('wickets')}>
                  Wkts
                </th>
                <th className="py-3 px-3 font-semibold text-right cursor-pointer" onClick={() => toggleSort('economy')}>
                  Econ
                </th>
                <th className="py-3 px-3 font-semibold text-right cursor-pointer" onClick={() => toggleSort('basePriceCr')}>
                  Base
                </th>
                <th className="py-3 px-4 font-semibold text-right cursor-pointer" onClick={() => toggleSort('ipl2026Price')}>
                  <span className="inline-flex items-center gap-1">2027 Price <ArrowUpDown className="w-3 h-3" /></span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => onInspectPlayer(p)}
                  className="hover:bg-slate-50 dark:hover:bg-slate-900/60 cursor-pointer transition-colors"
                >
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <PlayerAvatar player={p} size="sm" />
                      <div>
                        <div className="font-semibold text-sm text-slate-900 dark:text-white">
                          {p.name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {COUNTRY_FLAGS[p.countryCode] ?? ''} {p.country} · {p.isCapped ? 'Capped' : 'Uncapped'} · Age {p.age}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    <div className="font-medium text-slate-800 dark:text-slate-200">
                      {p.category}
                    </div>
                    <div className="text-[11px] text-slate-500">{p.secondaryRole}</div>
                  </td>
                  <td className="py-3 px-3 font-semibold text-slate-700 dark:text-slate-300">
                    {p.ipl2025Franchise ?? 'Pool'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono-num text-slate-700 dark:text-slate-300">
                    {p.stats.matches}
                  </td>
                  <td className="py-3 px-3 text-right font-mono-num text-slate-700 dark:text-slate-300">
                    {p.stats.runs}
                  </td>
                  <td className="py-3 px-3 text-right font-mono-num text-slate-700 dark:text-slate-300">
                    {p.stats.strikeRate > 0 ? p.stats.strikeRate.toFixed(1) : '-'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono-num text-slate-700 dark:text-slate-300">
                    {p.stats.wickets}
                  </td>
                  <td className="py-3 px-3 text-right font-mono-num text-slate-700 dark:text-slate-300">
                    {p.stats.economy > 0 ? p.stats.economy.toFixed(2) : '-'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono-num text-slate-600 dark:text-slate-400">
                    {formatCr(p.basePriceCr)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-num font-bold text-amber-500">
                    {formatCr(getPlayerRetentionCostCr(p))}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-500">
                    No players match your current filters. Clear search to view all {players.length} players.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
