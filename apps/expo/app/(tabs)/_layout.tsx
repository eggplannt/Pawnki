import { Tabs } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useColorTheme } from '@/hooks/useColorTheme';

export default function TabsLayout() {
  const { colors: colorTheme } = useColorTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colorTheme.bg.surface,
          borderTopColor: colorTheme.border.default,
          height: 60,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: colorTheme.accent.default,
        tabBarInactiveTintColor: colorTheme.content.muted,
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="library/index"
        options={{
          title: 'Library',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="bookshelf" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="review/index"
        options={{
          title: 'Review',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="calendar-check-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="tools/index"
        options={{
          title: 'Tools',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="toolbox-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings/index"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="cog-outline" size={size} color={color} />
          ),
        }}
      />
      {/* Hide nested tool routes from the tab bar (they're reached by push). */}
      <Tabs.Screen name="tools/vision" options={{ href: null }} />
    </Tabs>
  );
}
