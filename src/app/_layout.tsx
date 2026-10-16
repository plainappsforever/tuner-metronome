import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useColorScheme } from 'react-native';

import { useT } from '@/hooks/use-t';

import { DatabaseProvider } from '@/db/provider';
import { migrate } from '@/db/migrations';
import { getThemePreference } from '@/db/settings';
import { configureNotifications } from '@/lib/notifications';
import { applyThemePreference } from '@/lib/theme-preference';

configureNotifications();

async function initDatabase(db: SQLiteDatabase) {
  await migrate(db);
  applyThemePreference(await getThemePreference(db));
}

export default function RootLayout() {
  return (
    <DatabaseProvider onInit={initDatabase}>
      <Navigator />
    </DatabaseProvider>
  );
}

function Navigator() {
  const scheme = useColorScheme();
  const t = useT();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="new" options={{ title: t('newItem.title') }} />
        <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
      </Stack>
    </ThemeProvider>
  );
}
