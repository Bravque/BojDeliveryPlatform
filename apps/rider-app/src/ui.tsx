/**
 * Small shared UI kit for the app (theme + primitives). Keeps `App.tsx` declarative and gives the
 * React Native screens a consistent, usable look (visible inputs, real buttons, cards, badges).
 * Presentation only — no business logic. (A cross-app `packages/mobile-ui` is a future refactor;
 * for now customer-app and rider-app each carry this small file.)
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export const colors = {
  bg: '#f4f6f9',
  surface: '#ffffff',
  border: '#d6dce3',
  text: '#19212e',
  muted: '#6a7686',
  primary: '#0aa56f',
  primaryText: '#ffffff',
  badgeBg: '#e7f5ee',
  badgeText: '#0a7a52',
};

export function Screen({ children }: { children: ReactNode }): JSX.Element {
  return <View style={styles.screen}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }): JSX.Element {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }): JSX.Element {
  return <Text style={styles.muted}>{children}</Text>;
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
  screen: { flex: 1, padding: 20, backgroundColor: colors.bg },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: 4 },
  muted: { fontSize: 14, color: colors.muted, marginBottom: 16 },
  field: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.muted, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginVertical: 6,
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { backgroundColor: colors.border },
  buttonText: { color: colors.primaryText, fontSize: 16, fontWeight: '700' },
  secondary: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginVertical: 6,
    backgroundColor: colors.surface,
  },
  secondaryPressed: { opacity: 0.6 },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 12,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.badgeBg,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginVertical: 6,
  },
  badgeText: { color: colors.badgeText, fontSize: 13, fontWeight: '700' },
  alert: {
    backgroundColor: '#fdecec',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  alertText: { color: '#b3261e', fontSize: 14, fontWeight: '600' },
});
