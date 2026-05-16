import '../global.css';
import 'react-native-gesture-handler';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { NavHistoryProvider } from '@/hooks/useNavHistory';

function AuthGate() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const inTabs = segments[0] === '(tabs)';
    const inAuth = segments[0] === '(auth)';
    if (!user && inTabs) router.replace('/(auth)/login');
    else if (user && inAuth) router.replace('/(tabs)/library');
  }, [user, loading, segments]);

  return null;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <NavHistoryProvider>
          <AuthGate />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="auth/callback" />
            <Stack.Screen name="opening/[id]" />
            <Stack.Screen name="practice/[id]" />
          </Stack>
        </NavHistoryProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
