import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  RotateCcw,
  Shield,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { COUNTRY_FLAGS } from '../data/players';
import {
  DEFAULT_FRANCHISE_RETENTIONS,
  getEligibleRetentionPlayers,
  getPlayerRetentionCostCr,
} from '../data/retentions';
import { formatCr, roundCr } from '../data/rulesets';
import { AuctionState, FranchiseId, Player } from '../engine/types';
import { FranchiseBadge } from '../components/FranchiseBadge';
import { PlayerAvatar } from '../components/PlayerAvatar';

interface RetentionRoomViewProps {
  state: AuctionState;
  userFranchiseId: FranchiseId;
  players: Player[];
  playerMap: Record<string, Player>;
  isHost: boolean;
  onConfirmRetentions: (selections: Partial<Record<FranchiseId, string[]>>) => void;
  onInspectPlayer: (player: Player) => void;
}

export const RetentionRoomView: React.FC<RetentionRoomViewProps> = ({
  state,
  userFranchiseId,
  players,
  playerMap,
  isHost,
  onConfirmRetentions,
  onInspectPlayer,
}) => {
  const maxRetentions = state.ruleset.maxRetentionsPerTeam ?? 6;
  const userFranchise = FRANCHISE_MAP[userFranchiseId];

  const eligibleUserPlayers = useMemo(
    () => getEligibleRetentionPlayers(userFranchiseId, players),
    [userFranchiseId, players]
  );

  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const defaults = (DEFAULT_FRANCHISE_RETENTIONS[userFranchiseId] ?? [])
      .map((r) => r.playerId)
      .filter((id) => Boolean(playerMap[id]));
    return defaults.slice(0, maxRetentions);
  });

  const [previewFranchise, setPreviewFranchise] = useState<FranchiseId | null>(null);

  const selectedPlayers = useMemo(
    () => selectedIds.map((id) => playerMap[id]).filter((p): p is Player => Boolean(p)),
    [selectedIds, playerMap]
  );

  const cappedCount = selectedPlayers.filter((p) => p.isCapped).length;
  const uncappedCount = selectedPlayers.filter((p) => !p.isCapped).length;
  const totalDeductedCr = roundCr(
    selectedPlayers.reduce((sum, p) => sum + getPlayerRetentionCostCr(p), 0)
  );
  const purseAfterCr = roundCr(state.ruleset.initialPurseCr - totalDeductedCr);
  const rtmCardsEarned = state.ruleset.allowRTM
    ? Math.max(0, maxRetentions - selectedPlayers.length)
    : 0;

  const toggleRetain = (player: Player) => {
    if (selectedIds.includes(player.id)) {
      setSelectedIds((prev) => prev.filter((id) => id !== player.id));
      return;
    }
    if (selectedIds.length >= maxRetentions) return;
    if (player.isCapped && cappedCount >= 5) return;
    if (!player.isCapped && uncappedCount >= 2) return;
    const cost = getPlayerRetentionCostCr(player);
    const minReserve = Math.max(0, state.ruleset.minSquadSize - (selectedIds.length + 1)) * 0.3;
    if (purseAfterCr - cost < minReserve) return;

    setSelectedIds((prev) => [...prev, player.id]);
  };

  const resetToOfficial2026 = () => {
    const defaults = (DEFAULT_FRANCHISE_RETENTIONS[userFranchiseId] ?? [])
      .map((r) => r.playerId)
      .filter((id) => Boolean(playerMap[id]));
    setSelectedIds(defaults.slice(0, maxRetentions));
  };

  const clearAllRetentions = () => {
    setSelectedIds([]);
  };

  const handleLockAndStart = () => {
    const selections: Partial<Record<FranchiseId, string[]>> = {
      [userFranchiseId]: selectedIds,
    };
    onConfirmRetentions(selections);
  };

  return (
    <div className="space-y-6 pb-16">
      {/* Dramatic Franchise Retention Banner */}
      <div
        className="relative overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 p-6 sm:p-8"
        style={{
          background: `linear-gradient(125deg, ${userFranchise.primaryColor}22 0%, rgba(11,17,32,0.94) 55%, rgba(15,23,42,0.98) 100%)`,
        }}
      >
        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <FranchiseBadge franchiseId={userFranchiseId} size="lg" />
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-amber-400">
                IPL 2027 Pre-Auction Retention Desk · {state.teams[userFranchiseId].ownerName}
              </div>
              <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-white mt-1">
                {userFranchise.name} Retentions
              </h1>
              <p className="text-sm text-slate-300 mt-1.5 max-w-2xl">
                Retain up to {maxRetentions} core players (max 5 capped, max 2 uncapped) at their exact IPL 2027 prices. Every unused retention slot converts into a live{' '}
                <strong className="text-amber-300">Right To Match (RTM)</strong> card for released players!
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={resetToOfficial2026}
              className="px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Official 2027 List
            </button>
            <button
              type="button"
              onClick={clearAllRetentions}
              className="px-3.5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-semibold text-slate-300 transition-colors whitespace-nowrap"
            >
              Release All (6 RTMs)
            </button>
            <button
              type="button"
              disabled={!isHost}
              onClick={handleLockAndStart}
              className="px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-display text-base font-extrabold shadow-lg shadow-amber-500/25 inline-flex items-center gap-2 transition-all whitespace-nowrap"
            >
              Lock Retentions & Enter Live Auction
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live Retention KPI Strip */}
        <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-6 border-t border-white/10">
          <div className="rounded-xl bg-slate-950/60 border border-white/10 px-4 py-3">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-emerald-400" />
              Live Auction Purse
            </div>
            <div className="font-mono-num text-2xl font-extrabold text-emerald-400 mt-1">
              {formatCr(purseAfterCr)}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Deducted: {formatCr(totalDeductedCr)} of {formatCr(state.ruleset.initialPurseCr)}
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/60 border border-white/10 px-4 py-3">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-sky-400" />
              Players Retained
            </div>
            <div className="font-mono-num text-2xl font-extrabold text-white mt-1">
              {selectedPlayers.length} / {maxRetentions}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              {cappedCount} Capped (max 5) · {uncappedCount} Uncapped (max 2)
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/60 border border-amber-500/30 px-4 py-3">
            <div className="text-xs text-amber-300 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              RTM Cards Available
            </div>
            <div className="font-mono-num text-2xl font-extrabold text-amber-400 mt-1">
              {rtmCardsEarned} RTM{rtmCardsEarned === 1 ? '' : 's'}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Use on released {userFranchiseId} players in live auction
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/60 border border-white/10 px-4 py-3">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-violet-400" />
              Released to Pool
            </div>
            <div className="font-mono-num text-2xl font-extrabold text-slate-200 mt-1">
              {Math.max(0, eligibleUserPlayers.length - selectedPlayers.length)}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              RTM-eligible if another team wins them
            </div>
          </div>
        </div>
      </div>

      {/* Main Split: User Franchise Retention Grid + Rival Franchises Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Eligible Players Grid */}
        <div className="lg:col-span-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
              Select {userFranchise.shortName} Retained Core ({eligibleUserPlayers.length} Eligible)
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Click any card to Retain or Release
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {eligibleUserPlayers.map((player) => {
              const isSelected = selectedIds.includes(player.id);
              const costCr = getPlayerRetentionCostCr(player);
              const capBlocked = !isSelected && player.isCapped && cappedCount >= 5;
              const uncapBlocked = !isSelected && !player.isCapped && uncappedCount >= 2;
              const countBlocked = !isSelected && selectedIds.length >= maxRetentions;
              const purseBlocked = !isSelected && purseAfterCr - costCr < 4;
              const disabled = capBlocked || uncapBlocked || countBlocked || purseBlocked;

              return (
                <div
                  key={player.id}
                  onClick={() => !disabled && toggleRetain(player)}
                  className={`group relative rounded-2xl p-4 border transition-all ${
                    isSelected
                      ? 'bg-amber-500/10 border-amber-500 shadow-md shadow-amber-500/10 cursor-pointer'
                      : disabled
                      ? 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 opacity-55 cursor-not-allowed'
                      : 'bg-white dark:bg-[#0F172A] border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600 cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-3.5">
                    <PlayerAvatar player={player} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onInspectPlayer(player);
                          }}
                          className="font-display text-lg font-bold text-slate-900 dark:text-white hover:text-amber-500 truncate text-left"
                        >
                          {player.name}
                        </button>
                        <div
                          className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                            isSelected
                              ? 'bg-amber-500 text-slate-950'
                              : 'border border-slate-300 dark:border-slate-700 text-transparent'
                          }`}
                        >
                          <Check className="w-3.5 h-3.5 stroke-[3]" />
                        </div>
                      </div>

                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {COUNTRY_FLAGS[player.countryCode] ?? ''} {player.country} ·{' '}
                        {player.secondaryRole} · {player.isCapped ? 'Capped' : 'Uncapped'}
                      </div>

                      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                        <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                          {player.primaryRole === 'Fast Bowler' || player.primaryRole === 'Spinner'
                            ? `${player.stats.wickets} wkts · ${player.stats.economy.toFixed(2)} econ`
                            : `${player.stats.runs} runs · SR ${player.stats.strikeRate.toFixed(1)}`}
                        </div>
                        <div className="font-mono-num text-sm font-extrabold text-amber-500">
                          {formatCr(costCr)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Rival Franchises Retention Intel */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5">
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-1">
              Rival Franchises (IPL 2027 Locks)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Click any franchise to inspect their retained players, purse deduction, and RTM cards.
            </p>

            <div className="space-y-2">
              {ALL_FRANCHISE_IDS.filter((fid) => fid !== userFranchiseId).map((fid) => {
                const rets = (DEFAULT_FRANCHISE_RETENTIONS[fid] ?? []).filter((r) =>
                  Boolean(playerMap[r.playerId])
                );
                const cost = roundCr(
                  rets.reduce((s, r) => s + getPlayerRetentionCostCr(playerMap[r.playerId]), 0)
                );
                const purseLeft = roundCr(state.ruleset.initialPurseCr - cost);
                const rtmCount = Math.max(0, maxRetentions - rets.length);
                const isExpanded = previewFranchise === fid;

                return (
                  <div
                    key={fid}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setPreviewFranchise(isExpanded ? null : fid)}
                      className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-900/60 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FranchiseBadge franchiseId={fid} size="sm" />
                        <div className="text-left min-w-0">
                          <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                            {FRANCHISE_MAP[fid].name}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {rets.length} Retained · {rtmCount} RTM
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono-num text-xs font-bold text-emerald-500">
                          {formatCr(purseLeft)}
                        </div>
                        <div className="text-[10px] text-slate-500">Purse Left</div>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="px-3.5 pb-3 pt-1 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
                        {rets.map((r) => {
                          const p = playerMap[r.playerId];
                          if (!p) return null;
                          return (
                            <div
                              key={p.id}
                              className="flex items-center justify-between text-xs py-1"
                            >
                              <span className="font-medium text-slate-700 dark:text-slate-300">
                                {p.name}
                              </span>
                              <span className="font-mono-num font-bold text-amber-500">
                                {formatCr(getPlayerRetentionCostCr(p))}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
