import { View, Text, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppShell } from '@/components/AppShell';
import { useColorTheme } from '@/hooks/useColorTheme';

export default function VisionScreen() {
  const { colors: colorTheme } = useColorTheme();
  const router = useRouter();
  return (
    <AppShell>
      <ScrollView className="flex-1 bg-bg-base" contentContainerStyle={{ padding: 24 }}>
        <Pressable onPress={() => router.back()} className="flex-row items-center gap-1 mb-4 active:opacity-70">
          <MaterialCommunityIcons name="chevron-left" size={20} color={colorTheme.content.secondary} />
          <Text className="text-content-secondary text-sm">Tools</Text>
        </Pressable>

        <View className="items-center mt-8 gap-4">
          <View className="w-16 h-16 rounded-2xl bg-accent/10 items-center justify-center">
            <MaterialCommunityIcons name="eye-outline" size={32} color={colorTheme.accent.default} />
          </View>
          <Text className="text-content-primary text-xl font-semibold">Vision Trainer</Text>
          <Text className="text-content-secondary text-base leading-6 text-center" style={{ maxWidth: 320 }}>
            Blindfold piece-vision drill — read announced moves, picture them, then identify which pieces see a target square. Available on the web at <Text className="text-accent">pawnki.com/tools/vision</Text>; mobile version on the way.
          </Text>
        </View>
      </ScrollView>
    </AppShell>
  );
}
