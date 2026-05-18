// Native deep link: pawnki://auth/callback?code=<pkce-code>
// openAuthSessionAsync in useAuth captures the redirect and calls
// supabase.auth.exchangeCodeForSession() before this screen renders.
// This screen only appears briefly and shows a spinner.
import { View, ActivityIndicator } from 'react-native';
import { useColorTheme } from '@/hooks/useColorTheme';

export default function AuthCallbackScreen() {
  const { colors: colorTheme } = useColorTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colorTheme.bg.base,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <ActivityIndicator color={colorTheme.accent.default} size="large" />
    </View>
  );
}
