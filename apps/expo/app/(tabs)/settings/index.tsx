import { View, Text, Pressable, ScrollView } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/hooks/useAuth';
import { useColorTheme, type ThemePref, type BoardPaletteKey } from '@/hooks/useColorTheme';
import { useReviewOrder, type ReviewOrder } from '@/hooks/useReviewOrder';
import { boardPalettes, BOARD_PALETTE_KEYS } from '@pawnki/shared';

const THEME_OPTIONS: { value: ThemePref; label: string; icon: 'white-balance-sunny' | 'weather-night' | 'theme-light-dark' }[] = [
  { value: 'system', label: 'System', icon: 'theme-light-dark' },
  { value: 'light',  label: 'Light',  icon: 'white-balance-sunny' },
  { value: 'dark',   label: 'Dark',   icon: 'weather-night' },
];

const REVIEW_ORDER_OPTIONS: { value: ReviewOrder; label: string; desc: string }[] = [
  { value: 'due-first',  label: 'Due first',  desc: 'Oldest due positions first (classic spaced-repetition).' },
  { value: 'interleave', label: 'Interleave', desc: "Round-robin across openings so you don't streak one." },
  { value: 'random',     label: 'Random',     desc: 'Fully shuffled.' },
];

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { colors: colorTheme, pref, setPref, boardPref, setBoardPref } = useColorTheme();
  const [reviewOrder, setReviewOrder] = useReviewOrder();

  return (
    <AppShell>
      <ScrollView className="flex-1 bg-bg-base" contentContainerStyle={{ padding: 32 }}>
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

        {/* Board theme */}
        <Text className="text-content-muted text-xs font-medium uppercase tracking-wider mb-2">
          Board theme
        </Text>
        <View className="flex-row gap-2 mb-8">
          {BOARD_PALETTE_KEYS.map((key) => {
            const p = boardPalettes[key];
            const selected = boardPref === key;
            return (
              <Pressable
                key={key}
                onPress={() => setBoardPref(key as BoardPaletteKey)}
                className={`flex-1 rounded-xl border p-2 ${selected ? 'border-accent bg-accent/5' : 'border-border'}`}
              >
                <BoardPreview dark={p.dark} light={p.light} />
                <Text
                  className="text-sm font-medium mt-2 text-center"
                  style={{ color: selected ? colorTheme.accent.default : colorTheme.content.primary }}
                >
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Review order */}
        <Text className="text-content-muted text-xs font-medium uppercase tracking-wider mb-2">
          Review order
        </Text>
        <View className="flex-col gap-2 mb-8">
          {REVIEW_ORDER_OPTIONS.map((opt) => {
            const selected = reviewOrder === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setReviewOrder(opt.value)}
                className={`rounded-xl border px-3 py-2 ${selected ? 'border-accent bg-accent/5' : 'border-border'}`}
              >
                <Text
                  className="text-sm font-medium"
                  style={{ color: selected ? colorTheme.accent.default : colorTheme.content.primary }}
                >
                  {opt.label}
                </Text>
                <Text className="text-content-muted text-xs mt-0.5">{opt.desc}</Text>
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
      </ScrollView>
    </AppShell>
  );
}

function BoardPreview({ dark, light }: { dark: string; light: string }) {
  const cells: { row: number; col: number; color: string }[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      cells.push({ row: r, col: c, color: (r + c) % 2 === 0 ? light : dark });
    }
  }
  return (
    <View className="rounded-md overflow-hidden" style={{ aspectRatio: 1 }}>
      {[0, 1, 2, 3].map((r) => (
        <View key={r} style={{ flex: 1, flexDirection: 'row' }}>
          {[0, 1, 2, 3].map((c) => (
            <View key={c} style={{ flex: 1, backgroundColor: (r + c) % 2 === 0 ? light : dark }} />
          ))}
        </View>
      ))}
    </View>
  );
}
