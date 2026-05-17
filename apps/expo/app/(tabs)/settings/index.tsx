import { View, Text, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/hooks/useAuth';
import { useColorTheme, type ThemePref } from '@/hooks/useColorTheme';

const THEME_OPTIONS: { value: ThemePref; label: string; icon: 'white-balance-sunny' | 'weather-night' | 'theme-light-dark' }[] = [
  { value: 'system', label: 'System', icon: 'theme-light-dark' },
  { value: 'light',  label: 'Light',  icon: 'white-balance-sunny' },
  { value: 'dark',   label: 'Dark',   icon: 'weather-night' },
];

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { colors: colorTheme, pref, setPref } = useColorTheme();

  return (
    <AppShell>
      <View className="flex-1 bg-bg-base p-8">
        <View className="flex-row items-center gap-2 mb-2">
          <MaterialCommunityIcons name="cog-outline" size={22} color={colorTheme.content.muted} />
          <Text className="text-content-primary text-2xl font-semibold">Settings</Text>
        </View>
        {user && <Text className="text-content-secondary text-sm mb-8">{user.email}</Text>}

        {/* Appearance */}
        <Text className="text-content-muted text-xs font-medium uppercase tracking-wider mb-2">
          Appearance
        </Text>
        <View className="flex-row gap-1 bg-bg-surface rounded-xl p-1 mb-8 border border-border-subtle">
          {THEME_OPTIONS.map((opt) => {
            const active = pref === opt.value;
            const tint = active ? colorTheme.accent.default : colorTheme.content.muted;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setPref(opt.value)}
                className={[
                  'flex-1 flex-row items-center justify-center gap-1.5 py-2.5 rounded-lg',
                  active ? 'bg-accent/15' : '',
                ].join(' ')}
              >
                <MaterialCommunityIcons name={opt.icon} size={16} color={tint} />
                <Text className="text-sm font-medium" style={{ color: tint }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          onPress={signOut}
          className="items-center justify-center bg-bg-elevated border border-border rounded-xl h-12 active:opacity-70"
        >
          <Text className="text-danger font-medium text-base">Sign Out</Text>
        </Pressable>
      </View>
    </AppShell>
  );
}
