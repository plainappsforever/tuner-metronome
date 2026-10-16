import Constants from 'expo-constants';
import { useSQLiteContext } from '@/db/provider';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/db/settings';
import { useTheme } from '@/hooks/use-theme';
import { scheduleLocalNotification } from '@/lib/notifications';
import { applyThemePreference } from '@/lib/theme-preference';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const theme = useTheme();
  const [themePreference, setThemeState] = useState<ThemePreference>('system');
  const [notificationStatus, setNotificationStatus] = useState<string | null>(null);

  useEffect(() => {
    getThemePreference(db).then(setThemeState);
  }, [db]);

  async function chooseTheme(value: ThemePreference) {
    setThemeState(value);
    applyThemePreference(value);
    await setThemePreference(db, value);
  }

  async function sendTestNotification() {
    const result = await scheduleLocalNotification('Reminder', 'This is your example notification.', 5);
    setNotificationStatus(
      result === 'scheduled'
        ? 'Notification scheduled for 5 seconds from now.'
        : 'Notifications are turned off for this app. You can allow them in system Settings.'
    );
  }

  return (
    <ScrollView
      testID="settings-screen"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <ThemedText type="smallBold">Appearance</ThemedText>
      <View style={[styles.segmented, { backgroundColor: theme.backgroundElement }]}>
        {THEME_OPTIONS.map((option) => {
          const selected = option.value === themePreference;
          return (
            <Pressable
              key={option.value}
              testID={`theme-${option.value}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => chooseTheme(option.value)}
              style={[styles.segment, selected && { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText type={selected ? 'smallBold' : 'small'}>{option.label}</ThemedText>
            </Pressable>
          );
        })}
      </View>

      <ThemedText type="smallBold" style={styles.section}>
        Notifications
      </ThemedText>
      <Button testID="schedule-notification" label="Send example notification" onPress={sendTestNotification} />
      {notificationStatus ? (
        <ThemedText testID="notification-status" themeColor="textSecondary">
          {notificationStatus}
        </ThemedText>
      ) : null}

      <ThemedText type="small" themeColor="textSecondary" style={styles.section}>
        Version {Constants.expoConfig?.version} ({String(Constants.expoConfig?.extra?.appVariant)})
      </ThemedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  section: {
    marginTop: Spacing.four,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: Spacing.one,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
