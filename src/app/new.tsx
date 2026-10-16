import { useRouter } from 'expo-router';
import { useSQLiteContext } from '@/db/provider';
import { useState } from 'react';
import { ScrollView, StyleSheet, TextInput } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { addItem } from '@/db/items';
import { useTheme } from '@/hooks/use-theme';
import { NOTE_MAX, TITLE_MAX, validateItem } from '@/lib/validation';

export default function NewItemScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const result = validateItem({ title, note });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    try {
      await addItem(db, result.value);
      router.back();
    } catch {
      setError('Could not save. Please try again.');
      setSaving(false);
    }
  }

  const inputStyle = [styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }];

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled">
      <ThemedText type="smallBold">Title</ThemedText>
      <TextInput
        testID="title-input"
        style={inputStyle}
        value={title}
        onChangeText={setTitle}
        placeholder="What do you want to remember?"
        placeholderTextColor={theme.textSecondary}
        maxLength={TITLE_MAX}
        returnKeyType="next"
      />

      <ThemedText type="smallBold">Note</ThemedText>
      <TextInput
        testID="note-input"
        style={[inputStyle, styles.multiline]}
        value={note}
        onChangeText={setNote}
        placeholder="Optional details"
        placeholderTextColor={theme.textSecondary}
        maxLength={NOTE_MAX}
        multiline
      />

      {error ? (
        <ThemedText testID="form-error" themeColor="danger">
          {error}
        </ThemedText>
      ) : null}

      <Button testID="save-item" label={saving ? 'Saving…' : 'Save'} onPress={save} disabled={saving} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  input: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
  },
  multiline: {
    minHeight: 120,
    paddingTop: Spacing.three,
    textAlignVertical: 'top',
  },
});
