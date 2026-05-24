import { NavLink } from 'react-router-dom';
import Icon from '@mdi/react';
import { mdiChessPawn, mdiSwordCross, mdiCog, mdiWeatherSunny, mdiWeatherNight, mdiThemeLightDark, mdiLogout } from '@mdi/js';
import { useAuth } from '@/hooks/useAuth';
import { useColorTheme } from '@/hooks/useColorTheme';
import { PawnkiLogo, PawnkiIcon } from '@/components/Logo';
import { BannerAd } from '@/components/BannerAd';

const NAV_ITEMS = [
  { label: 'Library',  to: '/library',  icon: mdiChessPawn },
  { label: 'Review',   to: '/review',   icon: mdiSwordCross },
  { label: 'Settings', to: '/settings', icon: mdiCog },
];

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
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        <MobileHeader />
        <main className="flex-1 overflow-auto">{children}</main>
        <BannerAd />
        <BottomNav />
      </div>
    </div>
  );
}

const THEME_OPTIONS = [
  { value: 'system' as const, icon: mdiThemeLightDark, title: 'Match system' },
  { value: 'light'  as const, icon: mdiWeatherSunny,   title: 'Light mode' },
  { value: 'dark'   as const, icon: mdiWeatherNight,   title: 'Dark mode' },
];

function Sidebar() {
  const { user, signOut } = useAuth();
  const { pref, setPref } = useColorTheme();

  return (
    <aside className="hidden lg:flex w-56 flex-col bg-bg-surface border-r border-border py-6 shrink-0">
      <div className="px-5 mb-8">
        <PawnkiLogo size="sm" align="end" />
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
                <Icon path={icon} size={0.85} />
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
              className={`flex-1 py-1.5 flex items-center justify-center transition-colors ${
                pref === opt.value
                  ? 'text-accent bg-accent/10'
                  : 'text-content-muted hover:text-content-secondary'
              }`}
            >
              <Icon path={opt.icon} size={0.75} />
            </button>
          ))}
        </div>
        {user && (
          <>
            <button
              onClick={signOut}
              className="flex items-center gap-1.5 text-content-secondary text-sm hover:text-content-primary transition-colors py-1"
            >
              <Icon path={mdiLogout} size={0.75} />
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

  const themeIcon = pref === 'system' ? mdiThemeLightDark : pref === 'light' ? mdiWeatherSunny : mdiWeatherNight;
  const nextTitle = pref === 'system' ? 'Light mode' : pref === 'light' ? 'Dark mode' : 'Match system';

  return (
    <header className="lg:hidden h-13 bg-bg-surface border-b border-border flex items-center justify-between px-4 shrink-0">
      <div className="flex items-center gap-2">
        <PawnkiIcon size={20} />
        <span className="text-lg font-bold tracking-tight">
          <span className="text-accent">Pawn</span>
          <span className="text-gold">ki</span>
        </span>
      </div>
      <button
        onClick={cycleTheme}
        className="text-content-secondary hover:text-gold transition-colors"
        title={nextTitle}
      >
        <Icon path={themeIcon} size={0.9} />
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
          <Icon path={icon} size={1} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
