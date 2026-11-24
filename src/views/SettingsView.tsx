import React from 'react';
import { Volume2, RotateCcw, Sun, Moon, Sliders } from 'lucide-react';
import { SEASON_RULESETS } from '../data/rulesets';
import { AIDifficulty, GameSettings, NominationMode } from '../engine/types';
import { audioService } from '../services/audioService';
import { DEFAULT_SETTINGS } from '../services/storageService';
import { PWAInstallButton } from '../components/PWAInstallButton';

interface SettingsViewProps {
  settings: GameSettings;
  onUpdate: (patch: Partial<GameSettings>) => void;
  onReset: () => void;
  onOpenAdmin: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onUpdate,
  onReset,
  onOpenAdmin,
}) => {
  const totalWeight = Object.values(settings.ratingWeights).reduce((a, b) => a + b, 0);

  const testAudio = () => {
    audioService.unlock();
    audioService.configure({
      sfxEnabled: true,
      masterVolume: settings.masterVolume,
      sfxVolume: settings.sfxVolume,
    });
    audioService.playSoldGavel();
  };

  return (
    <div className="space-y-8 pb-16 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white">
            Arena Settings & Preferences
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Customize visual theme, stadium sound effects, default gameplay rules, and squad balance weights.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <PWAInstallButton variant="compact" />
          <button
            onClick={onOpenAdmin}
            className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition whitespace-nowrap"
          >
            Admin Data Studio
          </button>
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-900 dark:text-white transition whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Defaults
          </button>
        </div>
      </div>

      {/* APPEARANCE & ACCESSIBILITY */}
      <section className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
          Display & Accessibility
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white">Theme Mode</div>
              <div className="text-xs text-slate-500">Floodlit Stadium Dark or High-Contrast Light</div>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <button
                onClick={() => onUpdate({ theme: 'dark' })}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold ${
                  settings.theme === 'dark'
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Moon className="w-3.5 h-3.5" /> Dark
              </button>
              <button
                onClick={() => onUpdate({ theme: 'light' })}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold ${
                  settings.theme === 'light'
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Sun className="w-3.5 h-3.5" /> Light
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white">Reduced Motion</div>
              <div className="text-xs text-slate-500">Disable confetti & heavy transitions</div>
            </div>
            <input
              type="checkbox"
              checked={settings.reducedMotion}
              onChange={(e) => onUpdate({ reducedMotion: e.target.checked })}
              className="w-5 h-5 accent-amber-500"
            />
          </div>
        </div>
      </section>

      {/* STADIUM SOUND EFFECTS (Voice is strictly inbuilt & hidden per arena rules) */}
      <section className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-amber-500" />
            Stadium Gavel & Ambient Sound
          </h2>
          <button
            onClick={testAudio}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-900 dark:text-white hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <Volume2 className="w-3.5 h-3.5" /> Test Gavel
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-sm">
          <label className="flex items-center justify-between">
            <span className="text-slate-700 dark:text-slate-300">Bid & Gavel Sound Effects</span>
            <input
              type="checkbox"
              checked={settings.sfxEnabled}
              onChange={(e) => onUpdate({ sfxEnabled: e.target.checked })}
              className="w-5 h-5 accent-amber-500"
            />
          </label>
          <label className="flex items-center justify-between">
            <span className="text-slate-700 dark:text-slate-300">Stadium Ambient Music Pad</span>
            <input
              type="checkbox"
              checked={settings.musicEnabled}
              onChange={(e) => onUpdate({ musicEnabled: e.target.checked })}
              className="w-5 h-5 accent-amber-500"
            />
          </label>

          <div className="space-y-1 sm:col-span-2">
            <div className="flex justify-between text-xs text-slate-500">
              <span>Stadium Master Volume</span>
              <span className="font-mono-num tabular-nums">{Math.round(settings.masterVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={settings.masterVolume}
              onChange={(e) => onUpdate({ masterVolume: Number(e.target.value) })}
              className="w-full accent-amber-500"
            />
          </div>
        </div>
      </section>

      {/* GAMEPLAY DEFAULTS */}
      <section className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Sliders className="w-4 h-4 text-amber-500" />
          Default Rules & Bid Guardrails
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500">Default Season Ruleset</label>
            <select
              value={settings.defaultRulesetId}
              onChange={(e) => onUpdate({ defaultRulesetId: e.target.value })}
              className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-900 dark:text-white"
            >
              {SEASON_RULESETS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500">Default AI Difficulty</label>
            <select
              value={settings.defaultDifficulty}
              onChange={(e) => onUpdate({ defaultDifficulty: e.target.value as AIDifficulty })}
              className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-900 dark:text-white"
            >
              <option value="EASY">Easy</option>
              <option value="NORMAL">Normal</option>
              <option value="HARD">Hard</option>
              <option value="EXPERT">Expert</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500">Nomination Mode</label>
            <select
              value={settings.defaultNominationMode}
              onChange={(e) => onUpdate({ defaultNominationMode: e.target.value as NominationMode })}
              className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-900 dark:text-white"
            >
              <option value="SET_ORDER">Set Order</option>
              <option value="MANAGER_NOMINATION">Manager Nomination</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500">
              High-Bid Confirm Guard (₹ Cr)
            </label>
            <input
              type="number"
              min={5}
              max={50}
              value={settings.confirmBeforeHighBidCr}
              onChange={(e) =>
                onUpdate({ confirmBeforeHighBidCr: Math.max(5, Number(e.target.value) || 15) })
              }
              className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-mono-num text-slate-900 dark:text-white"
            />
          </div>
        </div>
      </section>

      {/* CONFIGURABLE 100-POINT RATING WEIGHTS */}
      <section className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
              Configurable Championship Evaluation Weights
            </h2>
            <p className="text-xs text-slate-500">
              Weights normalize automatically to 100 points (current raw sum: {totalWeight}).
            </p>
          </div>
          <button
            onClick={() => onUpdate({ ratingWeights: DEFAULT_SETTINGS.ratingWeights })}
            className="text-xs font-semibold text-amber-500 hover:text-amber-400"
          >
            Restore 20/20/15/15/10/10/10
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {(
            [
              ['batting', 'Batting Quality'],
              ['bowling', 'Bowling Quality'],
              ['allRounders', 'All-Rounders'],
              ['balance', 'Team Balance'],
              ['overseasBalance', 'Overseas Balance'],
              ['squadDepth', 'Squad Depth'],
              ['budgetEfficiency', 'Budget Efficiency'],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-slate-700 dark:text-slate-300 font-medium">{label}</span>
                <span className="font-mono-num font-bold text-amber-500 tabular-nums">
                  {settings.ratingWeights[key]} pts
                </span>
              </div>
              <input
                type="range"
                min={5}
                max={35}
                value={settings.ratingWeights[key]}
                onChange={(e) =>
                  onUpdate({
                    ratingWeights: {
                      ...settings.ratingWeights,
                      [key]: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-amber-500"
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
