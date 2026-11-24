import React, { useEffect, useState } from 'react';
import { Lock, Upload, Plus, Download, CheckCircle2, AlertCircle } from 'lucide-react';
import { AuctionCategory, Player, PrimaryRole } from '../engine/types';

interface AdminStudioViewProps {
  players: Player[];
  adminToken: string | null;
  onAdminToken: (token: string | null) => void;
  onPlayersUpdated: (players: Player[]) => void;
}

export const AdminStudioView: React.FC<AdminStudioViewProps> = ({
  players,
  adminToken,
  onAdminToken,
  onPlayersUpdated,
}) => {
  const [statusLoading, setStatusLoading] = useState(true);
  const [isClaimed, setIsClaimed] = useState(true);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // Add player state
  const [name, setName] = useState('');
  const [country, setCountry] = useState('India');
  const [role, setRole] = useState<PrimaryRole>('Batter');
  const [category, setCategory] = useState<AuctionCategory>('Emerging Stars');
  const [basePriceCr, setBasePriceCr] = useState('0.5');
  const [overall, setOverall] = useState('80');
  const [runs, setRuns] = useState('450');
  const [wickets, setWickets] = useState('0');
  const [dataSource, setDataSource] = useState('Admin Scouting Entry');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // Bulk import text
  const [bulkText, setBulkText] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/admin/status', {
      headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
    })
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        setIsClaimed(Boolean(data.isClaimed));
        if (!data.authenticated && adminToken) {
          onAdminToken(null);
        }
      })
      .catch(() => {})
      .finally(() => active && setStatusLoading(false));
    return () => {
      active = false;
    };
  }, [adminToken, onAdminToken]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const endpoint = isClaimed ? '/api/admin/login' : '/api/admin/claim';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Authentication failed.');
      } else {
        onAdminToken(data.token);
        setIsClaimed(true);
        setPassword('');
      }
    } catch {
      setAuthError('Could not connect to server.');
    }
  };

  const handleAddPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/players', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          player: {
            name,
            country,
            countryCode: country.toLowerCase() === 'india' ? 'IN' : 'AU',
            isOverseas: country.toLowerCase() !== 'india',
            primaryRole: role,
            category,
            basePriceCr: Number(basePriceCr) || 0.5,
            stats: {
              matches: 20,
              runs: Number(runs) || 0,
              wickets: Number(wickets) || 0,
              battingAvg: 28,
              strikeRate: 138,
              economy: Number(wickets) > 0 ? 8.2 : 0,
            },
            ratings: {
              overall: Number(overall) || 78,
              batting: role === 'Fast Bowler' || role === 'Spinner' ? 30 : Number(overall) || 78,
              bowling: role === 'Fast Bowler' || role === 'Spinner' ? Number(overall) || 78 : 25,
              estimatedValueCr: Math.max(0.5, (Number(overall) - 65) * 0.45),
            },
            dataSource,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'err', msg: data.error || 'Could not save player.' });
      } else {
        onPlayersUpdated(data.players);
        setName('');
        setFeedback({ type: 'ok', msg: `Saved ${data.player.name} to the live player database.` });
      }
    } catch {
      setFeedback({ type: 'err', msg: 'Network error saving player.' });
    }
  };

  const parseCsvToPlayers = (csv: string) => {
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cols = line.split(',').map((c) => c.trim());
      const obj: Record<string, string | number> = {};
      headers.forEach((h, i) => {
        const val = cols[i] ?? '';
        obj[h] = val !== '' && !Number.isNaN(Number(val)) ? Number(val) : val;
      });
      return obj;
    });
  };

  const handleBulkImport = async () => {
    if (!adminToken || !bulkText.trim()) return;
    setFeedback(null);
    let parsed: unknown[] = [];
    try {
      if (bulkText.trim().startsWith('[') || bulkText.trim().startsWith('{')) {
        const json = JSON.parse(bulkText);
        parsed = Array.isArray(json) ? json : [json];
      } else {
        parsed = parseCsvToPlayers(bulkText);
      }
    } catch {
      setFeedback({ type: 'err', msg: 'Invalid JSON or CSV format.' });
      return;
    }

    try {
      const res = await fetch('/api/admin/players/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ players: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'err', msg: data.error || 'Import failed.' });
      } else {
        onPlayersUpdated(data.players);
        setBulkText('');
        setFeedback({
          type: 'ok',
          msg: `Imported ${data.imported} new player(s). Skipped ${data.skippedDuplicates} duplicate(s).`,
        });
      }
    } catch {
      setFeedback({ type: 'err', msg: 'Server error during bulk import.' });
    }
  };

  const downloadCsvTemplate = () => {
    const csv =
      'name,country,primaryRole,category,basePriceCr,overall,runs,wickets,strikeRate,economy,dataSource\n' +
      'Sample Indian Finisher,India,Batter,Emerging Stars,0.5,79,410,0,152.5,0,Custom CSV Import\n' +
      'Sample Overseas Pacer,Australia,Fast Bowler,Fast Bowlers,1.5,84,45,32,95.0,8.15,Custom CSV Import\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ipl-auction-arena-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (statusLoading) {
    return <div className="py-12 text-sm text-slate-400">Checking admin authorization...</div>;
  }

  if (!adminToken) {
    return (
      <div className="max-w-md mx-auto py-12">
        <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-6 space-y-4">
          <div className="flex items-center gap-2.5 text-amber-500">
            <Lock className="w-5 h-5" />
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              {isClaimed ? 'Admin Studio Sign In' : 'First-Run Admin Setup'}
            </h1>
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">
            {isClaimed
              ? 'Enter your configured admin password to manage the player pool, CSV/JSON imports, and data sources.'
              : 'No admin passcode is configured yet. Choose a strong password (8+ characters) to claim Admin Studio access on this server.'}
          </p>

          <form onSubmit={handleAuth} className="space-y-3">
            <input
              type="password"
              required
              minLength={isClaimed ? 1 : 8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isClaimed ? 'Admin password' : 'Create strong admin password (8+ chars)'}
              className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white"
            />
            {authError && <div className="text-xs text-rose-400">{authError}</div>}
            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition"
            >
              {isClaimed ? 'Unlock Admin Studio' : 'Claim & Lock Admin Password'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-16 max-w-5xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white">
            Admin Data Studio
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            {players.length} total players loaded · CSV/JSON bulk import with automatic duplicate detection.
          </p>
        </div>
        <button
          onClick={() => onAdminToken(null)}
          className="px-3.5 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200"
        >
          Lock Studio
        </button>
      </div>

      {feedback && (
        <div
          className={`rounded-xl px-4 py-3 text-xs flex items-center gap-2 border ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
          }`}
        >
          {feedback.type === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span>{feedback.msg}</span>
        </div>
      )}

      {/* Add Single Player */}
      <form
        onSubmit={handleAddPlayer}
        className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4"
      >
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Plus className="w-4 h-4 text-amber-500" />
          Add or Update Player Record
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input
            required
            placeholder="Full Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          />
          <input
            required
            placeholder="Country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as PrimaryRole)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          >
            <option value="Batter">Batter</option>
            <option value="Wicketkeeper">Wicketkeeper</option>
            <option value="All-rounder">All-rounder</option>
            <option value="Fast Bowler">Fast Bowler</option>
            <option value="Spinner">Spinner</option>
          </select>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as AuctionCategory)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          >
            <option value="Marquee">Marquee</option>
            <option value="Batters">Batters</option>
            <option value="All-Rounders">All-Rounders</option>
            <option value="Wicketkeepers">Wicketkeepers</option>
            <option value="Fast Bowlers">Fast Bowlers</option>
            <option value="Spinners">Spinners</option>
            <option value="Emerging Stars">Emerging Stars</option>
          </select>
          <input
            type="number"
            step="0.1"
            placeholder="Base Price (Cr)"
            value={basePriceCr}
            onChange={(e) => setBasePriceCr(e.target.value)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-900 dark:text-white"
          />
          <input
            type="number"
            placeholder="Game OVR (40-99)"
            value={overall}
            onChange={(e) => setOverall(e.target.value)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-900 dark:text-white"
          />
          <input
            type="number"
            placeholder="Career Runs"
            value={runs}
            onChange={(e) => setRuns(e.target.value)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-900 dark:text-white"
          />
          <input
            type="number"
            placeholder="Career Wickets"
            value={wickets}
            onChange={(e) => setWickets(e.target.value)}
            className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono-num text-slate-900 dark:text-white"
          />
        </div>
        <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
          <input
            placeholder="Data Source Attribution"
            value={dataSource}
            onChange={(e) => setDataSource(e.target.value)}
            className="w-full sm:w-80 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-900 dark:text-white"
          />
          <button
            type="submit"
            className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition whitespace-nowrap"
          >
            Save Player Record
          </button>
        </div>
      </form>

      {/* Bulk CSV / JSON Importer */}
      <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Upload className="w-4 h-4 text-sky-400" />
            Bulk CSV / JSON Import
          </h2>
          <button
            onClick={downloadCsvTemplate}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-500 hover:text-amber-400"
          >
            <Download className="w-3.5 h-3.5" />
            Download CSV Template
          </button>
        </div>

        <textarea
          rows={5}
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          placeholder='Paste JSON array or CSV rows (headers: name,country,primaryRole,category,basePriceCr,overall,runs,wickets,dataSource)...'
          className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-3 text-xs font-mono text-slate-900 dark:text-white"
        />

        <div className="flex justify-end">
          <button
            onClick={handleBulkImport}
            disabled={!bulkText.trim()}
            className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition"
          >
            Validate & Import Players
          </button>
        </div>
      </div>
    </div>
  );
};
