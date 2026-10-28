/**
 * Shared UI kit for the customer app — a Bolt Food–inspired theme (bright green, white surfaces,
 * soft-shadowed rounded cards, pill buttons, colourful emoji thumbnails in place of photos).
 * Presentation only — no business logic. `App.tsx` composes these into screens.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export const colors = {
  bg: '#ffffff',
  surface: '#ffffff',
  surfaceAlt: '#f3f4f6', // search bar, chips, thumbnails base
  border: '#ededf0',
  text: '#13171f',
  muted: '#878d97',
  primary: '#34d186', // Bolt green
  primaryDark: '#16b26a',
  primaryText: '#083b26',
  onPrimary: '#ffffff',
  star: '#13b981',
  danger: '#e5484d',
  dark: '#171b24',
};

/** Soft card shadow (maps to box-shadow on react-native-web). */
const shadow = {
  shadowColor: '#0b1b2b',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.08,
  shadowRadius: 14,
};

// ---- deterministic, data-free visual helpers (stable per name) -------------------------------

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const THUMB_COLORS = ['#FFE3D0', '#D9F2E6', '#E2E8FF', '#FDE5EF', '#FEF3C7', '#E7F0FF', '#F0E6FF'];

export function thumbColor(seed: string): string {
  return THUMB_COLORS[hash(seed) % THUMB_COLORS.length]!;
}

export function categoryIcon(categoryType: string): string {
  const map: Record<string, string> = {
    restaurant: '🍔',
    grocery: '🛒',
    pharmacy: '💊',
    retail: '🛍️',
    other: '🍽️',
  };
  return map[categoryType] ?? '🍽️';
}

export function foodEmoji(name: string): string {
  const n = name.toLowerCase();
  const rules: [RegExp, string][] = [
    [/burger/, '🍔'],
    [/pizza/, '🍕'],
    [/chicken/, '🍗'],
    [/pilau|rice|biryani/, '🍚'],
    [/chips|fries/, '🍟'],
    [/fish/, '🐟'],
    [/beef|steak|meat/, '🥩'],
    [/drink|soda|juice|water/, '🥤'],
    [/coffee|tea/, '☕'],
    [/cake|dessert|ice/, '🍰'],
    [/salad|veg/, '🥗'],
    [/samosa|snack/, '🥟'],
  ];
  for (const [re, e] of rules) if (re.test(n)) return e;
  return '🍴';
}

/** A stable pseudo-rating (4.1–4.9) for the demo cards — presentation only. */
export function pseudoRating(seed: string): string {
  return (4.1 + (hash(seed) % 9) / 10).toFixed(1);
}

// ---- primitives -------------------------------------------------------------------------------

export function Screen({ children }: { children: ReactNode }): JSX.Element {
  return <View style={styles.screen}>{children}</View>;
}

/** Padded screen for the auth flow (centred, roomy). */
export function PaddedScreen({ children }: { children: ReactNode }): JSX.Element {
  return <View style={styles.padded}>{children}</View>;
}

export function Brand(): JSX.Element {
  return (
    <View style={styles.brandRow}>
      <View style={styles.brandMark}>
        <Text style={styles.brandMarkText}>b</Text>
      </View>
      <Text style={styles.brandName}>Boj Food</Text>
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

export function LocationBar({ place }: { place: string }): JSX.Element {
  return (
    <View style={styles.locationBar}>
      <Text style={styles.locationLabel}>Deliver to</Text>
      <Text style={styles.locationPlace}>📍 {place} ▾</Text>
    </View>
  );
}

export function SearchBar(props: {
  value: string;
  onChangeText: (t: string) => void;
}): JSX.Element {
  return (
    <View style={styles.search}>
      <Text style={styles.searchIcon}>🔍</Text>
      <TextInput
        accessibilityLabel="Search restaurants"
        style={styles.searchInput}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder="Search restaurants and dishes"
        placeholderTextColor={colors.muted}
      />
    </View>
  );
}

export function Chip(props: {
  icon: string;
  label: string;
  active?: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={[styles.chip, props.active && styles.chipActive]}
    >
      <Text style={styles.chipIcon}>{props.icon}</Text>
      <Text style={[styles.chipLabel, props.active && styles.chipLabelActive]}>{props.label}</Text>
    </Pressable>
  );
}

/** Emoji "photo" in a soft coloured tile. */
export function Thumb(props: { emoji: string; seed: string; size?: number }): JSX.Element {
  const size = props.size ?? 56;
  return (
    <View
      style={[
        styles.thumb,
        {
          width: size,
          height: size,
          borderRadius: size / 4,
          backgroundColor: thumbColor(props.seed),
        },
      ]}
    >
      <Text style={{ fontSize: size * 0.5 }}>{props.emoji}</Text>
    </View>
  );
}

export function Rating({ value }: { value: string }): JSX.Element {
  return (
    <View style={styles.ratingPill}>
      <Text style={styles.ratingStar}>★</Text>
      <Text style={styles.ratingText}>{value}</Text>
    </View>
  );
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

/** Small round green "+" used on menu rows. */
export function AddButton({ onPress }: { onPress: () => void }): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add"
      onPress={onPress}
      style={({ pressed }) => [styles.add, pressed && styles.buttonPressed]}
    >
      <Text style={styles.addText}>＋</Text>
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

  locationBar: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6 },
  locationLabel: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  locationPlace: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: 2 },

  search: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    paddingHorizontal: 14,
    marginHorizontal: 18,
    marginVertical: 8,
  },
  searchIcon: { fontSize: 16, marginRight: 8, color: colors.muted },
  searchInput: { flex: 1, paddingVertical: 13, fontSize: 15, color: colors.text },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginRight: 9,
  },
  chipActive: { backgroundColor: colors.primary },
  chipIcon: { fontSize: 15, marginRight: 6 },
  chipLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  chipLabelActive: { color: colors.onPrimary },

  thumb: { alignItems: 'center', justifyContent: 'center' },

  ratingPill: { flexDirection: 'row', alignItems: 'center' },
  ratingStar: { color: colors.star, fontSize: 14, marginRight: 3 },
  ratingText: { color: colors.text, fontSize: 14, fontWeight: '800' },

  tag: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontSize: 12, fontWeight: '800' },
  tagOk: { backgroundColor: '#e4f8ee' },
  tagOkText: { color: colors.primaryDark },
  tagOff: { backgroundColor: '#fdeceb' },
  tagOffText: { color: colors.danger },
  tagNeutral: { backgroundColor: colors.surfaceAlt },
  tagNeutralText: { color: colors.muted },

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

  add: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addText: { color: colors.onPrimary, fontSize: 20, fontWeight: '800', lineHeight: 22 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 14,
    marginBottom: 14,
    ...shadow,
  },

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
