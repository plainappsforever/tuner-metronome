import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';

// P0 placeholder (repurposed template home screen, D22). The tuner UI is built in P7 on the P2 engine.
export default function TunerScreen() {
  const t = useT();
  const theme = useTheme();
  return (
    <View testID="tuner-screen" style={[styles.screen, { backgroundColor: theme.background }]}>
      <ThemedText type="subtitle">{t('tab.tuner')}</ThemedText>
      <ThemedText themeColor="textSecondary" testID="tuner-status">
        {t('tuner.status.idle')}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, padding: Spacing.three },
});
