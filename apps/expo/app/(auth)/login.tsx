import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuth } from '@/hooks/useAuth';
import { colorTheme } from '@/hooks/useColorTheme';

export default function LoginScreen() {
  const { signInWithGoogle } = useAuth();
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setLoading(true);
    try {
      await signInWithGoogle();
    } finally {
      setLoading(false);
    }
  }

  return (
    <View className="flex-1 items-center justify-center bg-bg-base px-8">
      <View style={{ width: '100%', maxWidth: 380 }}>
        {/* Logo */}
        <View className="flex-row items-center gap-2 mb-3">
          <MaterialCommunityIcons name="chess-pawn" size={22} color={colorTheme.accent.default} />
          <Text>
            <Text className="text-accent text-4xl font-bold">Pawn</Text>
            <Text className="text-gold text-4xl font-bold">tree</Text>
          </Text>
        </View>

        <Text className="text-content-secondary text-base leading-6 mb-4">
          Build your opening repertoire.
        </Text>
        <Text className="text-accent text-base leading-6 mb-10">
          Train with spaced repetition.
        </Text>

        {/* Feature list */}
        <View className="mb-10 gap-3">
          {([
            { icon: 'chess-pawn', text: 'Import or build opening trees from PGN' },
            { icon: 'sword-cross', text: 'Depth-first practice drills' },
            { icon: 'star-four-points-outline', text: 'Anki-style daily review sessions' },
          ] as const).map(({ icon, text }) => (
            <View key={text} className="flex-row items-center gap-3">
              <View className="w-8 h-8 rounded-lg bg-accent/10 items-center justify-center">
                <MaterialCommunityIcons name={icon} size={16} color={colorTheme.accent.default} />
              </View>
              <Text className="text-content-secondary text-sm flex-1">{text}</Text>
            </View>
          ))}
        </View>

        {/* Sign in card */}
        <View className="bg-bg-surface border border-border rounded-2xl p-6">
          {/* Decorative stripe */}
          <View className="flex-row gap-1 mb-5">
            <View className="h-1 flex-1 rounded-full bg-accent" />
            <View className="h-1 flex-1 rounded-full bg-gold" />
            <View className="h-1 flex-1 rounded-full bg-accent-dim" />
          </View>

          <Text className="text-content-primary text-xl font-semibold mb-2">Welcome</Text>
          <Text className="text-content-secondary text-sm mb-6">
            Sign in to access your repertoire.
          </Text>

          {loading ? (
            <View className="h-12 items-center justify-center">
              <ActivityIndicator color={colorTheme.accent.default} />
            </View>
          ) : (
            <Pressable
              onPress={handleLogin}
              className="flex-row items-center justify-center gap-3 bg-bg-elevated border border-border rounded-xl px-5 h-12 active:opacity-70"
            >
              <Text className="text-lg font-bold text-content-secondary">G</Text>
              <Text className="text-content-primary font-medium text-base">
                Continue with Google
              </Text>
            </Pressable>
          )}
        </View>

        <Text className="text-content-muted text-xs text-center mt-6 leading-5">
          By signing in you agree to the terms of service.{'\n'}
          Your data stays on your instance.
        </Text>
      </View>
    </View>
  );
}
