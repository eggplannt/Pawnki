import { useAuth } from '@/hooks/useAuth';
import { useColorTheme } from '@/hooks/useColorTheme';
import { PawnkiLogo } from '@/components/Logo';
import { useState } from 'react';
import googleIconUrl from '@/assets/google-icon.svg';

const FEATURES = [
  { icon: '♟', text: 'Import or build opening trees from PGN' },
  { icon: '⚔', text: 'Drill style practice and learning' },
  { icon: '✦', text: 'Anki-style daily review sessions' },
];

export default function Login() {
  const { signInWithGoogle } = useAuth();
  const { theme, toggleTheme } = useColorTheme();
  const [loading, setLoading] = useState(false);

  function handleLogin() {
    setLoading(true);
    signInWithGoogle(); // full page redirect — never returns
  }

  return (
    <div className="h-full flex flex-col bg-bg-base relative overflow-hidden">
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="absolute top-5 right-5 text-content-muted hover:text-content-primary transition-colors text-lg z-10"
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>

      {/* Decorative background glow */}
      <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] rounded-full bg-accent/5 blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-gold/5 blur-3xl pointer-events-none" />

      <div className="flex-1 flex flex-col md:flex-row items-center justify-center gap-12 md:gap-20 p-8 relative z-1">
        {/* Left — branding */}
        <div className="max-w-md text-center md:text-left">
          <div className="flex justify-center md:justify-start mb-6">
            <PawnkiLogo size="xl" align="end" />
          </div>
          <p className="text-content-secondary text-lg md:text-xl leading-8 mb-10">
            Build your opening repertoire.{' '}
            <span className="text-accent">Train with spaced repetition.</span>{' '}
            Never forget a line again.
          </p>

          <div className="hidden md:flex flex-col gap-4">
            {FEATURES.map(({ icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent shrink-0">
                  {icon}
                </span>
                <span className="text-content-secondary">{text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right — sign in card */}
        <div className="w-full max-w-sm">
          <div className="bg-bg-surface border border-border rounded-2xl p-8 shadow-lg shadow-black/20">
            {/* Decorative top stripe */}
            <div className="flex gap-1 mb-6">
              <div className="h-1 flex-1 rounded-full bg-accent" />
              <div className="h-1 flex-1 rounded-full bg-gold" />
              <div className="h-1 flex-1 rounded-full bg-accent-dim" />
            </div>

            <h2 className="text-content-primary text-2xl font-semibold mb-2">Welcome back</h2>
            <p className="text-content-secondary text-sm mb-8 leading-6">
              Sign in to access your repertoire.
            </p>

            <button
              onClick={handleLogin}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-bg-elevated border border-border rounded-xl px-5 h-12 text-content-primary font-medium text-base hover:border-accent/40 transition-all disabled:opacity-60"
            >
              {loading ? (
                <span className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <img src={googleIconUrl} width={18} height={18} alt="" />
                  Continue with Google
                </>
              )}
            </button>

            <p className="text-content-muted text-xs text-center mt-6 leading-5">
              By signing in you agree to our{' '}
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-content-secondary transition-colors">
                Privacy Policy
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
