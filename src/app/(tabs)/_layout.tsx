import { Link, Tabs } from 'expo-router';
import { Pressable } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useT } from '@/hooks/use-t';

// Bottom tabs Tuner | Metronome (SPEC §7). Tuner opens by default; "last tab used" arrives with the UI phases (P7/P8).
export default function TabsLayout() {
  const t = useT();
  const settingsButton = () => (
    <Link href="/settings" asChild>
      <Pressable testID="open-settings" accessibilityLabel={t('settings.title')} hitSlop={8}>
        <ThemedText themeColor="tint">{t('settings.title')}</ThemedText>
      </Pressable>
    </Link>
  );
  return (
    <Tabs screenOptions={{ headerRight: settingsButton, headerRightContainerStyle: { paddingRight: 16 } }}>
      <Tabs.Screen name="index" options={{ title: t('tab.tuner'), tabBarButtonTestID: 'tab-tuner' }} />
      <Tabs.Screen name="metronome" options={{ title: t('tab.metronome'), tabBarButtonTestID: 'tab-metronome' }} />
    </Tabs>
  );
}
