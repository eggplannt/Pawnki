import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { ThemeContext, useThemeProvider } from '@/hooks/useColorTheme';
import { NavHistoryProvider } from '@/hooks/useNavHistory';
import Login from '@/pages/Login';
import Library from '@/pages/Library';
import Review from '@/pages/Review';
import Settings from '@/pages/Settings';
import OpeningDetail from '@/pages/OpeningDetail';
import Practice from '@/pages/Practice';
import AuthCallback from '@/pages/AuthCallback';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-base">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

function GuestGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-base">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/library" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        path="/login"
        element={
          <GuestGuard>
            <Login />
          </GuestGuard>
        }
      />
      <Route
        path="/library"
        element={
          <AuthGuard>
            <Library />
          </AuthGuard>
        }
      />
      <Route
        path="/library/:id"
        element={
          <AuthGuard>
            <OpeningDetail />
          </AuthGuard>
        }
      />
      <Route
        path="/practice/:id"
        element={
          <AuthGuard>
            <Practice />
          </AuthGuard>
        }
      />
      <Route
        path="/review"
        element={
          <AuthGuard>
            <Review />
          </AuthGuard>
        }
      />
      <Route
        path="/settings"
        element={
          <AuthGuard>
            <Settings />
          </AuthGuard>
        }
      />
      <Route path="*" element={<Navigate to="/library" replace />} />
    </Routes>
  );
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeValue = useThemeProvider();
  return (
    <ThemeContext.Provider value={themeValue}>
      {children}
    </ThemeContext.Provider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <NavHistoryProvider>
          <AppRoutes />
        </NavHistoryProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
