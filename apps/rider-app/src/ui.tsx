/**
 * Shared UI kit for the rider app — the Bolt Food–inspired theme (bright green, white surfaces,
 * soft-shadowed rounded cards, pill buttons) shared with the customer app. Presentation only — no
 * business logic. `App.tsx` composes these into screens.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export const colors = {
  bg: '#ffffff',
  surface: '#ffffff',
  surfaceAlt: '#f3f4f6',
  border: '#ededf0',
  text: '#13171f',
  muted: '#878d97',
  primary: '#34d186', // Bolt green
  primaryDark: '#16b26a',
  onPrimary: '#ffffff',
  danger: '#e5484d',
  dark: '#171b24',
};

const shadow = {
  shadowColor: '#0b1b2b',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.08,
  shadowRadius: 14,
};

export function Screen({ children }: { children: ReactNode }): JSX.Element {
  return <View style={styles.screen}>{children}</View>;
}

export function PaddedScreen({ children }: { children: ReactNode }): JSX.Element {
  return <View style={styles.padded}>{children}</View>;
}

export function Brand({ label = 'Boj Courier' }: { label?: string }): JSX.Element {
  return (
    <View style={styles.brandRow}>
      <View style={styles.brandMark}>
        <Text style={styles.brandMarkText}>b</Text>
      </View>
      <Text style={styles.brandName}>{label}</Text>
    </View>
  );
}

export function Title({ children }: { children: ReactNode }): JSX.Element {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }): JSX.Element {
  return <Text style={styles.muted}>{children}</Text>;
}

export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Field(props: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad' | 'phone-pad';
}): JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        style={styles.input}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={props.keyboardType ?? 'default'}
      />
    </View>
  );
}

export function PrimaryButton(props: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.disabled && styles.buttonDisabled,
        pressed && !props.disabled && styles.buttonPressed,
      ]}
    >
      <Text style={styles.buttonText}>{props.title}</Text>
    </Pressable>
  );
}

export function SecondaryButton(props: { title: string; onPress: () => void }): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.secondary, pressed && styles.secondaryPressed]}
    >
      <Text style={styles.secondaryText}>{props.title}</Text>
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }): JSX.Element {
  return <View style={styles.card}>{children}</View>;
}

export function Tag({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'ok' | 'off' | 'neutral';
}): JSX.Element {
  const toneStyle =
    tone === 'ok' ? styles.tagOk : tone === 'off' ? styles.tagOff : styles.tagNeutral;
  const textStyle =
    tone === 'ok' ? styles.tagOkText : tone === 'off' ? styles.tagOffText : styles.tagNeutralText;
  return (
    <View style={[styles.tag, toneStyle]}>
      <Text style={[styles.tagText, textStyle]}>{label}</Text>
    </View>
  );
}

export function Badge({ label }: { label: string }): JSX.Element {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

export function Alert({ message }: { message: string }): JSX.Element {
  return (
    <View style={styles.alert} accessibilityRole="alert">
      <Text style={styles.alertText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  padded: { flex: 1, padding: 24, backgroundColor: colors.bg, justifyContent: 'center' },

  brandRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  brandMark: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  brandMarkText: { color: colors.onPrimary, fontSize: 22, fontWeight: '900' },
  brandName: { fontSize: 20, fontWeight: '800', color: colors.text },

  title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
  muted: { fontSize: 15, color: colors.muted, marginBottom: 18, lineHeight: 21 },
  sectionTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: colors.text,
    marginTop: 6,
    marginBottom: 10,
  },

  field: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.muted, marginBottom: 7 },
  input: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 15,
    fontSize: 17,
    color: colors.text,
    backgroundColor: colors.surface,
  },

  button: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
    marginVertical: 7,
    ...shadow,
    shadowColor: colors.primary,
    shadowOpacity: 0.35,
  },
  buttonPressed: { opacity: 0.88 },
  buttonDisabled: { backgroundColor: colors.border, shadowOpacity: 0 },
  buttonText: { color: colors.onPrimary, fontSize: 16, fontWeight: '800' },

  secondary: {
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    marginVertical: 6,
    backgroundColor: colors.surfaceAlt,
  },
  secondaryPressed: { opacity: 0.7 },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '700' },

  card: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    ...shadow,
  },

  tag: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontSize: 12, fontWeight: '800' },
  tagOk: { backgroundColor: '#e4f8ee' },
  tagOkText: { color: colors.primaryDark },
  tagOff: { backgroundColor: '#fdeceb' },
  tagOffText: { color: colors.danger },
  tagNeutral: { backgroundColor: colors.surfaceAlt },
  tagNeutralText: { color: colors.muted },

  badge: {
    alignSelf: 'flex-start',
    backgroundColor: '#e4f8ee',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgeText: { color: colors.primaryDark, fontSize: 13, fontWeight: '800' },

  alert: { backgroundColor: '#fdeceb', borderRadius: 14, padding: 13, marginBottom: 12 },
  alertText: { color: colors.danger, fontSize: 14, fontWeight: '700' },
});
