import { View, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppShell } from '@/components/AppShell';
import { colorTheme } from '@/hooks/useColorTheme';

export default function ReviewScreen() {
  return (
    <AppShell>
      <View className="flex-1 bg-bg-base p-8">
        <View className="flex-row items-center gap-2 mb-2">
          <MaterialCommunityIcons name="sword-cross" size={22} color={colorTheme.gold.default} />
          <Text className="text-content-primary text-2xl font-semibold">Review</Text>
        </View>
        <Text className="text-content-secondary text-sm">Coming in Phase 6</Text>
      </View>
    </AppShell>
  );
}
