import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';

// P0 placeholder. The metronome UI is built in P8 on the P1 schedule engine and the P6 native renderer.
export default function MetronomeScreen() {
  const t = useT();
  const theme = useTheme();
  return (
    <View testID="metronome-screen" style={[styles.screen, { backgroundColor: theme.background }]}>
      <ThemedText type="subtitle">{t('tab.metronome')}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, padding: Spacing.three },
});
