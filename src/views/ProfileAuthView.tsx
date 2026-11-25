import React, { useState } from 'react';
import { User, LogOut, ShieldCheck, Cloud, Sparkles } from 'lucide-react';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from '../data/franchises';
import { FranchiseId, UserProfile } from '../engine/types';
import { FranchiseBadge } from '../components/FranchiseBadge';

interface ProfileAuthViewProps {
  profile: UserProfile;
  cloudSyncLoading?: boolean;
  onGoogleSignIn: () => Promise<void>;
  onUpdateProfile: (patch: Partial<UserProfile>) => void;
  onAuthSuccess: (profile: UserProfile, token: string, sessionId?: string, expiresAt?: string) => void;
  onSignOut: () => Promise<void> | void;
}

export const ProfileAuthView: React.FC<ProfileAuthViewProps> = ({
  profile,
  cloudSyncLoading = false,
  onGoogleSignIn,
  onUpdateProfile,
  onAuthSuccess,
  onSignOut,
}) => {
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState(profile.username);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const handleGoogleClick = async () => {
    setError(null);
    setGoogleBusy(true);
    try {
      await onGoogleSignIn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google Sign-In failed.';
      if (!msg.toLowerCase().includes('popup-closed')) {
        setError('Could not complete Google Sign-In. Please try again or continue as Guest.');
      }
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body =
        authMode === 'register'
          ? { email, username, password, favoriteFranchise: profile.favoriteFranchise }
          : { email, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'fetch',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Authentication failed.');
      } else {
        onAuthSuccess(
          { ...data.profile, authProvider: 'local' },
          data.token,
          data.sessionId,
          data.expiresAt
        );
        setPassword('');
      }
    } catch {
      setError('Server unreachable. You can sign in with Google or play seamlessly in Guest Mode.');
    } finally {
      setSubmitting(false);
    }
  };

  const isGoogleUser = !profile.isGuest && profile.authProvider === 'google';

  return (
    <div className="space-y-8 pb-16 max-w-4xl">
      <div>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white">
          Owner Profile & Cloud Account
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Sign in with Google to save every IPL auction, Playing XI, and championship win across devices — or jump straight in as Guest.
        </p>
      </div>

      {/* Career Stats Card */}
      <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-6 space-y-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {profile.photoURL ? (
              <img
                src={profile.photoURL}
                alt={profile.username}
                referrerPolicy="no-referrer"
                className="w-14 h-14 rounded-2xl object-cover border-2 border-amber-500/70 shadow-md"
              />
            ) : (
              <FranchiseBadge franchiseId={profile.favoriteFranchise} size="lg" />
            )}
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                {isGoogleUser ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                    <Cloud className="w-3.5 h-3.5" />
                    Google Cloud Synced · {profile.email}
                  </span>
                ) : profile.isGuest ? (
                  <span>Guest Owner Profile (Saved locally on this device)</span>
                ) : (
                  <span>Verified Email Account · {profile.email}</span>
                )}
              </div>
              <div className="font-display text-2xl font-bold text-slate-900 dark:text-white mt-0.5">
                {profile.username}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Favorite Franchise: {FRANCHISE_MAP[profile.favoriteFranchise].name}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {profile.isGuest ? (
              <button
                type="button"
                onClick={handleGoogleClick}
                disabled={googleBusy || cloudSyncLoading}
                className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-50 transition shadow-sm"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.79-.07-1.54-.19-2.27h-11.3v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
                  />
                  <path
                    fill="#34A853"
                    d="M12.255 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96h-3.98v3.09C3.515 21.3 7.565 24 12.255 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.525 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62h-3.98a11.86 11.86 0 000 10.76l3.98-3.09z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12.255 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C18.205 1.19 15.495 0 12.255 0c-4.69 0-8.74 2.7-10.71 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
                  />
                </svg>
                {googleBusy ? 'Connecting Google...' : 'Sign in with Google'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void onSignOut()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            )}
          </div>
        </div>

        {/* Career Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Auctions Played', value: profile.stats.auctionsPlayed },
            { label: 'Championships Won', value: profile.stats.auctionsWon },
            { label: 'Best Win Index', value: `${profile.stats.bestRating}%` },
            { label: 'Average Win Index', value: `${profile.stats.avgRating}%` },
            { label: 'Tournaments Won', value: profile.stats.tournamentsWon },
          ].map((m) => (
            <div
              key={m.label}
              className="rounded-xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 p-3.5"
            >
              <div className="text-[11px] text-slate-500">{m.label}</div>
              <div className="font-mono-num text-xl font-bold text-amber-500 mt-0.5 tabular-nums">
                {m.value}
              </div>
            </div>
          ))}
        </div>

        {/* Display Name & Favorite Franchise Editor */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-200 dark:border-slate-800">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500">Owner Display Name</label>
            <input
              type="text"
              value={profile.username}
              onChange={(e) => onUpdateProfile({ username: e.target.value.slice(0, 32) })}
              className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500">Favorite Franchise</label>
            <select
              value={profile.favoriteFranchise}
              onChange={(e) =>
                onUpdateProfile({ favoriteFranchise: e.target.value as FranchiseId })
              }
              className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
            >
              {ALL_FRANCHISE_IDS.map((fid) => (
                <option key={fid} value={fid}>
                  {FRANCHISE_MAP[fid].name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Google Cloud Sync Highlight + Optional Email Account */}
      {profile.isGuest && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-gradient-to-br from-amber-500/10 via-white to-sky-500/10 dark:from-amber-500/10 dark:via-[#0F172A] dark:to-sky-500/10 border border-amber-500/30 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                <Sparkles className="w-3.5 h-3.5" />
                Recommended · Instant Cloud History
              </div>
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                Sync Your Auction History with Google
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400 max-w-xl">
                Keep your completed IPL 2027 auctions, Playing XI lineups, and career win record automatically backed up in Firebase Firestore.
              </p>
            </div>
            <button
              type="button"
              onClick={handleGoogleClick}
              disabled={googleBusy}
              className="px-5 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs whitespace-nowrap shrink-0 transition shadow-md"
            >
              {googleBusy ? 'Signing in...' : 'Continue with Google'}
            </button>
          </div>

          <div className="rounded-2xl bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <User className="w-5 h-5 text-amber-500" />
                Alternative Email Account
              </h2>
              <div className="flex gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-900">
                <button
                  type="button"
                  onClick={() => setAuthMode('register')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold ${
                    authMode === 'register'
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-500'
                  }`}
                >
                  Create Account
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode('login')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold ${
                    authMode === 'login'
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-500'
                  }`}
                >
                  Sign In
                </button>
              </div>
            </div>

            <div className="text-xs text-slate-500 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
              Passwords are salted and scrypt-hashed on the server; session tokens stay safely in memory.
            </div>

            <form onSubmit={handleAuthSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              {authMode === 'register' && (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-500">Username</label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                  />
                </div>
              )}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="owner@franchise.com"
                  className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500">Password (8+ chars)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div className="sm:col-span-3 flex items-center justify-between gap-3 pt-1">
                {error ? <span className="text-xs text-rose-500 dark:text-rose-400">{error}</span> : <span />}
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs transition"
                >
                  {submitting
                    ? 'Please wait...'
                    : authMode === 'register'
                    ? 'Create Owner Account'
                    : 'Sign In'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
