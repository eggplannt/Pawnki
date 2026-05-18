import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/hooks/useAuth';
import { useColorTheme, type ThemePref } from '@/hooks/useColorTheme';

const THEME_OPTIONS: { value: ThemePref; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '⊙' },
  { value: 'light',  label: 'Light',  icon: '☀' },
  { value: 'dark',   label: 'Dark',   icon: '☾' },
];

export default function Settings() {
  const { user, signOut } = useAuth();
  const { pref, setPref } = useColorTheme();

  return (
    <AppShell>
      <div className="p-8 max-w-lg">
        <h1 className="text-content-primary text-2xl font-semibold mb-2">Settings</h1>
        {user && (
          <p className="text-content-secondary text-sm mb-8">{user.email}</p>
        )}

        <section className="mb-8">
          <h2 className="text-content-muted text-xs font-medium uppercase tracking-wider mb-3">Appearance</h2>
          <div className="flex rounded-xl overflow-hidden border border-border bg-bg-surface p-1 gap-1">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPref(opt.value)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  pref === opt.value
                    ? 'bg-accent/15 text-accent'
                    : 'text-content-muted hover:text-content-secondary'
                }`}
              >
                <span>{opt.icon}</span>
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        <button
          onClick={signOut}
          className="text-sm text-content-secondary hover:text-content-primary border border-border rounded-lg px-4 py-2 transition-colors"
        >
          Sign out
        </button>
      </div>
    </AppShell>
  );
}
