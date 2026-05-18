import { NavLink } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useColorTheme } from '@/hooks/useColorTheme';
import { PawnTreeLogo, PawnTreeIcon } from '@/components/Logo';

const NAV_ITEMS = [
  { label: 'Library',  to: '/library',  icon: '♟' },
  { label: 'Review',   to: '/review',   icon: '⚔' },
  { label: 'Settings', to: '/settings', icon: '⚙' },
] as const;

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  // Render `children` once, in a layout that adapts via flex-direction.
  // Rendering twice (once per breakpoint) duplicates React state and DOM
  // ids — libraries that use fixed element ids (react-chessboard's
  // #chessboard-board) collide and break.
  return (
    <div className="flex flex-col lg:flex-row h-full">
      <Sidebar />
      <MobileHeader />
      <main className="flex-1 overflow-auto">{children}</main>
      <BottomNav />
    </div>
  );
}

const THEME_OPTIONS = [
  { value: 'system', icon: '⊙', title: 'Match system' },
  { value: 'light',  icon: '☀', title: 'Light mode' },
  { value: 'dark',   icon: '☾', title: 'Dark mode' },
] as const;

function Sidebar() {
  const { user, signOut } = useAuth();
  const { pref, setPref } = useColorTheme();

  return (
    <aside className="hidden lg:flex w-56 flex-col bg-bg-surface border-r border-border py-6 shrink-0">
      <div className="px-5 mb-8">
        <PawnTreeLogo size="md" />
      </div>

      <nav className="flex-1 px-3 flex flex-col gap-0.5">
        {NAV_ITEMS.map(({ label, to, icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              [
                'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent/10 text-accent'
                  : 'text-content-secondary hover:bg-bg-elevated hover:text-content-primary',
              ].join(' ')
            }
          >
            {({ isActive }) => (
              <>
                <span className="text-base leading-none">{icon}</span>
                <span className="flex-1">{label}</span>
                {isActive && (
                  <span className="w-1.5 h-5 rounded-sm bg-accent shrink-0" />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="px-5 pt-4 border-t border-border flex flex-col gap-2">
        <div className="flex rounded-lg overflow-hidden border border-border bg-bg-base">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPref(opt.value)}
              title={opt.title}
              className={`flex-1 py-1.5 text-sm transition-colors ${
                pref === opt.value
                  ? 'text-accent bg-accent/10'
                  : 'text-content-muted hover:text-content-secondary'
              }`}
            >
              {opt.icon}
            </button>
          ))}
        </div>
        {user && (
          <>
            <button
              onClick={signOut}
              className="flex items-center gap-1.5 text-content-secondary text-sm hover:text-content-primary transition-colors py-1"
            >
              <span>↩</span>
              Sign out
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function MobileHeader() {
  const { pref, setPref } = useColorTheme();

  const cycleTheme = () => {
    const order = ['system', 'light', 'dark'] as const;
    setPref(order[(order.indexOf(pref) + 1) % 3]);
  };

  const icon = pref === 'system' ? '⊙' : pref === 'light' ? '☀' : '☾';
  const nextTitle = pref === 'system' ? 'Light mode' : pref === 'light' ? 'Dark mode' : 'Match system';

  return (
    <header className="lg:hidden h-13 bg-bg-surface border-b border-border flex items-center justify-between px-4 shrink-0">
      <div className="flex items-center gap-2">
        <PawnTreeIcon size={20} />
        <span className="text-lg font-bold tracking-tight">
          <span className="text-accent">Pawn</span>
          <span className="text-gold">tree</span>
        </span>
      </div>
      <button
        onClick={cycleTheme}
        className="text-content-secondary hover:text-gold transition-colors text-lg"
        title={nextTitle}
      >
        {icon}
      </button>
    </header>
  );
}

function BottomNav() {
  return (
    <nav className="lg:hidden bg-bg-surface border-t border-border flex shrink-0">
      {NAV_ITEMS.map(({ label, to, icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            [
              'flex-1 flex flex-col items-center justify-center gap-1 py-3 text-xs font-medium transition-colors',
              isActive ? 'text-accent' : 'text-content-muted',
            ].join(' ')
          }
        >
          <span className="text-lg leading-none">{icon}</span>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
