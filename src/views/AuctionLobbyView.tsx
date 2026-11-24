import React, { useState } from 'react';
import {
  Copy,
  Check,
  Share2,
  ArrowRight,
  Users,
  Bot,
  Sliders,
  ArrowLeft,
  MessageCircle,
  Wifi,
  UserCheck,
} from 'lucide-react';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { formatCr, SEASON_RULESETS } from '../data/rulesets';
import {
  AIDifficulty,
  AuctionState,
  FranchiseId,
  NominationMode,
} from '../engine/types';
import { ConnectionStatus } from '../services/multiplayerClient';
import { FranchiseBadge } from '../components/FranchiseBadge';

interface AuctionLobbyViewProps {
  state: AuctionState;
  userFranchiseId: FranchiseId;
  clientId: string;
  ownerName: string;
  isMultiplayer: boolean;
  connectionStatus: ConnectionStatus;
  onUpdateOwnerName: (name: string) => void;
  onSelectFranchise: (fid: FranchiseId) => void;
  onToggleReady: () => void;
  onUpdateLobbySettings: (updates: {
    rulesetId?: string;
    aiDifficulty?: AIDifficulty;
    auctionSpeed?: 'NORMAL' | 'FAST' | 'BLITZ';
    nominationMode?: NominationMode;
    customPurseCr?: number;
    customMaxOverseas?: number;
  }) => void;
  onProceedToRetentions: () => void;
  onLeave: () => void;
}

export const AuctionLobbyView: React.FC<AuctionLobbyViewProps> = ({
  state,
  userFranchiseId,
  clientId,
  ownerName,
  isMultiplayer,
  connectionStatus,
  onUpdateOwnerName,
  onSelectFranchise,
  onToggleReady,
  onUpdateLobbySettings,
  onProceedToRetentions,
  onLeave,
}) => {
  const [copiedType, setCopiedType] = useState<'code' | 'link' | null>(null);

  const isHost = state.hostId === clientId;
  const inviteUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?join=${state.roomCode}`
      : `/?join=${state.roomCode}`;

  const humanTeams = ALL_FRANCHISE_IDS.map((id) => state.teams[id]).filter(
    (t) => t.controllerType === 'HUMAN'
  );
  const userTeam = state.teams[userFranchiseId];

  const copyText = async (text: string, type: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
      window.setTimeout(() => setCopiedType(null), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleNativeShare = async () => {
    const shareText = `Join my IPL Auction Arena room! Room Code: ${state.roomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'IPL Auction Arena Invite',
          text: shareText,
          url: inviteUrl,
        });
      } catch {
        // User canceled share
      }
    } else {
      copyText(`${shareText} — ${inviteUrl}`, 'link');
    }
  };

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(
    `Join my IPL Auction Arena live room! Code: ${state.roomCode} — ${inviteUrl}`
  )}`;

  return (
    <div className="space-y-6 pb-12">
      {/* Top Lobby Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="space-y-1">
          <button
            onClick={onLeave}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Arena Home
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white">
              {isMultiplayer ? 'Multiplayer Auction Lobby' : `IPL 2027 ${state.mode} Setup`}
            </h1>
            {isMultiplayer && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-500">
                <Wifi className="w-3.5 h-3.5" />
                {connectionStatus === 'CONNECTED' ? 'Synced Live' : connectionStatus}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Step 1 of 2: Enter Owner Name & Claim Franchise · Next: Pre-Auction Retentions & RTM Cards
          </div>
        </div>

        {/* Invite & Share Controls (Multiplayer) */}
        {isMultiplayer && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-3.5 py-2 flex items-center gap-2.5">
              <span className="text-xs text-slate-500 dark:text-slate-400">Code</span>
              <span className="font-mono-num text-base font-bold tracking-widest text-amber-500">
                {state.roomCode}
              </span>
              <button
                onClick={() => copyText(state.roomCode, 'code')}
                className="text-slate-400 hover:text-white transition-colors"
                title="Copy Room Code"
              >
                {copiedType === 'code' ? (
                  <Check className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>

            <button
              onClick={() => copyText(inviteUrl, 'link')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-900 dark:text-white transition whitespace-nowrap shrink-0"
            >
              {copiedType === 'link' ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copiedType === 'link' ? 'Link Copied' : 'Copy Invite Link'}
            </button>

            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition whitespace-nowrap shrink-0"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              WhatsApp
            </a>

            <button
              onClick={handleNativeShare}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white transition whitespace-nowrap shrink-0"
            >
              <Share2 className="w-3.5 h-3.5" />
              Share
            </button>
          </div>
        )}
      </div>

      {/* Main Grid: Franchise Selection (left 8 cols) + Owner Name & Settings (right 4 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Franchise Selector */}
        <div className="lg:col-span-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Choose Your Franchise ({humanTeams.length} Human · {10 - humanTeams.length} AI)
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Unclaimed teams are guided by strategic AI owners
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ALL_FRANCHISE_IDS.map((fid) => {
              const cfg = FRANCHISE_MAP[fid];
              const team = state.teams[fid];
              const isMine = fid === userFranchiseId;
              const isOtherHuman = team.controllerType === 'HUMAN' && !isMine;

              return (
                <button
                  key={fid}
                  disabled={isOtherHuman}
                  onClick={() => !isMine && !isOtherHuman && onSelectFranchise(fid)}
                  className={`text-left rounded-2xl p-4 border transition-all flex items-center justify-between gap-3 ${
                    isMine
                      ? 'bg-amber-500/10 border-amber-500 ring-1 ring-amber-500/40 shadow-md shadow-amber-500/10'
                      : isOtherHuman
                      ? 'bg-slate-100 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/80 opacity-75 cursor-not-allowed'
                      : 'bg-white dark:bg-[#0F172A] border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FranchiseBadge franchiseId={fid} size="md" />
                    <div className="min-w-0">
                      <div className="font-display text-lg font-bold text-slate-900 dark:text-white truncate">
                        {cfg.name}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate flex items-center gap-1.5">
                        {team.controllerType === 'HUMAN' ? (
                          <>
                            <Users className="w-3 h-3 text-sky-400 shrink-0" />
                            <span>
                              {isMine ? ownerName || team.ownerName : team.ownerName}
                              {isMine ? ' (You)' : ''}
                            </span>
                          </>
                        ) : (
                          <>
                            <Bot className="w-3 h-3 text-slate-400 shrink-0" />
                            <span>AI · {cfg.strategyLabel}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="font-mono-num text-xs font-bold text-slate-900 dark:text-slate-200">
                      {formatCr(team.purseRemainingCr)}
                    </div>
                    <div className="text-[11px] mt-0.5">
                      {isMine ? (
                        <span className="font-bold text-amber-500">Selected</span>
                      ) : isOtherHuman ? (
                        <span className={team.isReady ? 'text-emerald-500 font-semibold' : 'text-sky-400'}>
                          {team.isReady ? 'Ready' : 'Joined'}
                        </span>
                      ) : (
                        <span className="text-slate-500">Select</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Owner Name & Lobby Configuration Panel (Zero Voice Mute Controls) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-5">
            {/* Owner / Manager Name Input */}
            <div className="space-y-1.5 pb-4 border-b border-slate-200 dark:border-slate-800">
              <label
                htmlFor="lobby-owner-name"
                className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"
              >
                <UserCheck className="w-3.5 h-3.5 text-amber-500" />
                Franchise Owner Name
              </label>
              <input
                id="lobby-owner-name"
                type="text"
                maxLength={32}
                value={ownerName}
                onChange={(e) => onUpdateOwnerName(e.target.value)}
                placeholder="Enter your name..."
                className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3.5 py-2.5 text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-amber-500" />
                Auction Settings
              </h2>
              {!isHost && isMultiplayer && (
                <span className="text-xs text-slate-400">Host Controlled</span>
              )}
            </div>

            {/* Ruleset / Season */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                Season & Ruleset
              </label>
              <select
                disabled={!isHost}
                value={state.ruleset.id}
                onChange={(e) => onUpdateLobbySettings({ rulesetId: e.target.value })}
                className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-amber-500 disabled:opacity-60"
              >
                {SEASON_RULESETS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({formatCr(r.initialPurseCr)})
                  </option>
                ))}
              </select>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Squad {state.ruleset.minSquadSize}–{state.ruleset.maxSquadSize} · Up to{' '}
                {state.ruleset.maxRetentionsPerTeam} Retentions · RTM Enabled
              </div>
            </div>

            {/* Editable Custom Purse (Solo/Host) */}
            {isHost && !isMultiplayer && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                    Purse (₹ Cr)
                  </label>
                  <input
                    type="number"
                    min={50}
                    max={200}
                    step={5}
                    value={state.ruleset.initialPurseCr}
                    onChange={(e) =>
                      onUpdateLobbySettings({
                        customPurseCr: Math.max(50, Math.min(200, Number(e.target.value) || 120)),
                      })
                    }
                    className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-900 dark:text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                    Max Overseas
                  </label>
                  <input
                    type="number"
                    min={4}
                    max={10}
                    value={state.ruleset.maxOverseasSquad}
                    onChange={(e) =>
                      onUpdateLobbySettings({
                        customMaxOverseas: Math.max(4, Math.min(10, Number(e.target.value) || 8)),
                      })
                    }
                    className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-900 dark:text-white"
                  />
                </div>
              </div>
            )}

            {/* AI Difficulty */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                AI Franchise Difficulty
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {(['EASY', 'NORMAL', 'HARD', 'EXPERT'] as AIDifficulty[]).map((diff) => (
                  <button
                    key={diff}
                    disabled={!isHost}
                    onClick={() => onUpdateLobbySettings({ aiDifficulty: diff })}
                    className={`py-2 rounded-lg text-xs font-semibold transition-colors ${
                      state.aiDifficulty === diff
                        ? 'bg-amber-500 text-slate-950'
                        : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
                    }`}
                  >
                    {diff[0] + diff.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Auction Speed */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                Bidding Timer Speed
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['NORMAL', 'FAST', 'BLITZ'] as const).map((spd) => (
                  <button
                    key={spd}
                    disabled={!isHost}
                    onClick={() => onUpdateLobbySettings({ auctionSpeed: spd })}
                    className={`py-2 rounded-lg text-xs font-semibold transition-colors ${
                      state.auctionSpeed === spd
                        ? 'bg-sky-500 text-slate-950'
                        : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
                    }`}
                  >
                    {spd[0] + spd.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Nomination Order */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                Auction Set Order
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { id: 'SET_ORDER' as NominationMode, label: 'Official 12 Sets' },
                  { id: 'MANAGER_NOMINATION' as NominationMode, label: 'Host Pick' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    disabled={!isHost}
                    onClick={() => onUpdateLobbySettings({ nominationMode: opt.id })}
                    className={`py-2 px-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                      state.nominationMode === opt.id
                        ? 'bg-slate-900 dark:bg-slate-700 text-white'
                        : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-2 space-y-2.5">
              {isMultiplayer && !isHost && (
                <button
                  onClick={onToggleReady}
                  className={`w-full py-3.5 rounded-xl font-bold text-sm transition ${
                    userTeam.isReady
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-sky-500 hover:bg-sky-400 text-slate-950'
                  }`}
                >
                  {userTeam.isReady ? 'Ready — Waiting for Host' : 'Mark Ready'}
                </button>
              )}

              {isHost && (
                <button
                  onClick={onProceedToRetentions}
                  className="w-full inline-flex items-center justify-center gap-2 py-3.5 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-slate-950 font-display font-extrabold text-base shadow-lg shadow-amber-500/20 transition"
                >
                  Continue to Retentions
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
