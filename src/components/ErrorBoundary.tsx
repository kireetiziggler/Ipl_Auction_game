import React from 'react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || 'Unexpected error occurred.' };
  }

  componentDidCatch(error: Error) {
    console.error('Application ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#060A13] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl bg-[#0F172A] border border-slate-800 p-6 space-y-4 text-center">
            <h1 className="font-display text-3xl font-extrabold text-amber-400">
              Arena Recovery
            </h1>
            <p className="text-sm text-slate-300">
              Something interrupted the arena session. Click below to restore the stadium view.
            </p>
            <button
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition"
            >
              Restore Arena
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
