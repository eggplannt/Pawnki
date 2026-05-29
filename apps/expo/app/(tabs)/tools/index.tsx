import { View, Text, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppShell } from '@/components/AppShell';
import { useColorTheme } from '@/hooks/useColorTheme';

type ToolEntry = {
  path: string;
  title: string;
  blurb: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
};

const TOOLS: ToolEntry[] = [
  {
    path: '/(tabs)/tools/vision',
    title: 'Vision Trainer',
    blurb: 'Blindfold piece vision. A move is announced in notation — picture it mentally, then identify which pieces see a target square in the position you imagined. The board stays frozen until you\'ve held several moves in your head.',
    icon: 'eye-outline',
  },
];

export default function ToolsScreen() {
  const { colors: colorTheme } = useColorTheme();
  const router = useRouter();
  return (
    <AppShell>
      <ScrollView className="flex-1 bg-bg-base" contentContainerStyle={{ padding: 24 }}>
        <View className="flex-row items-center gap-2 mb-2">
          <MaterialCommunityIcons name="toolbox-outline" size={22} color={colorTheme.content.muted} />
          <Text className="text-content-primary text-2xl font-semibold">Tools</Text>
        </View>
        <Text className="text-content-secondary text-sm mb-6">
          Drills and utilities for the rest of your chess training.
        </Text>

        <View className="gap-3">
          {TOOLS.map((t) => (
            <Pressable
              key={t.path}
              onPress={() => router.push(t.path as never)}
              className="bg-bg-surface border border-border rounded-2xl p-4 flex-row items-start gap-3 active:opacity-70"
            >
              <View className="w-10 h-10 rounded-xl bg-accent/10 items-center justify-center">
                <MaterialCommunityIcons name={t.icon} size={20} color={colorTheme.accent.default} />
              </View>
              <View className="flex-1">
                <Text className="text-content-primary font-semibold">{t.title}</Text>
                <Text className="text-content-secondary text-sm mt-1 leading-5">{t.blurb}</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={20} color={colorTheme.content.muted} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </AppShell>
  );
}
