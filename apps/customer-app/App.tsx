import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  type ApiClient,
  type OrderDetail,
  type PublicCatalogue,
  type PublicMerchant,
  type PublicProduct,
  catalogueProducts,
  createHttpApiClient,
} from './src/api';
import { type CustomerModel, type CustomerState, createCustomerModel } from './src/customerFlow';
import { type ConnectOrderSocket, makeConnectOrderSocket } from './src/socket';
import { API_BASE_URL } from './src/config';
import {
  AddButton,
  Alert,
  Brand,
  Card,
  Chip,
  Field,
  LocationBar,
  Muted,
  PaddedScreen,
  PrimaryButton,
  Rating,
  Screen,
  SearchBar,
  SecondaryButton,
  SectionTitle,
  Tag,
  Thumb,
  Title,
  categoryIcon,
  colors,
  foodEmoji,
  pseudoRating,
  thumbColor,
} from './src/ui';

export interface AppProps {
  api?: ApiClient;
  connectSocket?: ConnectOrderSocket;
}

/** Root component Expo registers — no props, always wires the real API + socket. */
export default function App(): JSX.Element {
  return <CustomerApp />;
}

/**
 * Customer app shell (MVP critical journey): phone-OTP sign-in → browse merchants → open a
 * merchant menu → track an order live. All logic lives in `createCustomerModel` (unit-tested);
 * this component only renders state and binds inputs. `api`/`connectSocket` are injectable for a
 * future RN render test.
 */
export function CustomerApp({ api, connectSocket }: AppProps = {}): JSX.Element {
  const modelRef = useRef<CustomerModel>();
  if (!modelRef.current) {
    modelRef.current = createCustomerModel(api ?? createHttpApiClient(API_BASE_URL));
  }
  const model = modelRef.current;
  const connect = connectSocket ?? makeConnectOrderSocket(API_BASE_URL);

  const [state, setState] = useState<CustomerState>(model.getState());
  useEffect(() => model.subscribe(setState), [model]);

  // While tracking an order, join its room and re-fetch on every nudge.
  useEffect(() => {
    if (state.screen !== 'track' || !state.token || !state.order) {
      return;
    }
    const handle = connect(state.token, state.order.ulid, () => void model.refreshOrder());
    return () => handle.close();
  }, [state.screen, state.token, state.order, connect, model]);

  const banner = state.busy ? (
    <View style={{ paddingVertical: 10 }}>
      <ActivityIndicator accessibilityLabel="Loading" color={colors.primary} />
    </View>
  ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="dark" />
      <Screen>{renderScreen(model, state, banner)}</Screen>
    </SafeAreaView>
  );
}

function renderScreen(
  model: CustomerModel,
  state: CustomerState,
  banner: JSX.Element | null,
): JSX.Element {
  switch (state.screen) {
    case 'phone':
      return <PhoneScreen error={state.error} onSubmit={(p) => void model.requestOtp(p)} />;
    case 'otp':
      return (
        <OtpScreen
          phone={state.phone}
          error={state.error}
          onSubmit={(c) => void model.verifyOtp(c)}
        />
      );
    case 'browse':
      return <HomeScreen model={model} merchants={state.merchants} banner={banner} />;
    case 'merchant':
      return <MenuScreen model={model} catalogue={state.catalogue} banner={banner} />;
    case 'track':
      return <TrackScreen model={model} order={state.order} error={state.error} />;
  }
}

// ---- auth ------------------------------------------------------------------------------------

function PhoneScreen({
  onSubmit,
  error,
}: {
  onSubmit: (phone: string) => void;
  error: string | null;
}): JSX.Element {
  const [phone, setPhone] = useState('');
  return (
    <PaddedScreen>
      <Brand />
      <Title>Good food, delivered fast</Title>
      <Muted>Sign in with your phone number to order from places near you.</Muted>
      {error ? <Alert message={error} /> : null}
      <Field
        label="Phone number"
        value={phone}
        onChangeText={setPhone}
        placeholder="+2547…"
        keyboardType="phone-pad"
      />
      <PrimaryButton title="Send code" onPress={() => onSubmit(phone.trim())} />
    </PaddedScreen>
  );
}

function OtpScreen({
  phone,
  onSubmit,
  error,
}: {
  phone: string;
  onSubmit: (code: string) => void;
  error: string | null;
}): JSX.Element {
  const [code, setCode] = useState('');
  return (
    <PaddedScreen>
      <Brand />
      <Title>Enter your code</Title>
      <Muted>We sent a 6-digit code to {phone}.</Muted>
      {error ? <Alert message={error} /> : null}
      <Field
        label="Verification code"
        value={code}
        onChangeText={setCode}
        placeholder="6-digit code"
        keyboardType="number-pad"
      />
      <PrimaryButton title="Verify" onPress={() => onSubmit(code.trim())} />
    </PaddedScreen>
  );
}

// ---- home / browse ---------------------------------------------------------------------------

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function HomeScreen({
  model,
  merchants,
  banner,
}: {
  model: CustomerModel;
  merchants: PublicMerchant[];
  banner: JSX.Element | null;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('all');

  const cats = ['all', ...Array.from(new Set(merchants.map((m) => m.categoryType)))];
  const shown = merchants.filter(
    (m) =>
      (cat === 'all' || m.categoryType === cat) &&
      m.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <View style={{ flex: 1 }}>
      <LocationBar place={merchants[0]?.townName ?? 'Migori'} />
      <SearchBar value={query} onChangeText={setQuery} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 8 }}
      >
        {cats.map((c) => (
          <Chip
            key={c}
            icon={c === 'all' ? '🧭' : categoryIcon(c)}
            label={c === 'all' ? 'All' : titleCase(c)}
            active={cat === c}
            onPress={() => setCat(c)}
          />
        ))}
      </ScrollView>
      {banner}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 28 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: 18 }}>
          <SectionTitle>Restaurants near you</SectionTitle>
        </View>
        {shown.length === 0 ? (
          <View style={{ paddingHorizontal: 18 }}>
            <Muted>No places match your search yet.</Muted>
          </View>
        ) : (
          shown.map((m) => (
            <RestaurantCard
              key={m.ulid}
              merchant={m}
              onPress={() => void model.openMerchant(m.ulid)}
            />
          ))
        )}
        <TrackEntry onTrack={(ulid) => void model.trackOrder(ulid)} />
      </ScrollView>
    </View>
  );
}

function RestaurantCard({
  merchant,
  onPress,
}: {
  merchant: PublicMerchant;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable onPress={onPress} style={{ marginHorizontal: 18 }}>
      <Card>
        <View
          style={{
            height: 120,
            borderRadius: 14,
            backgroundColor: thumbColor(merchant.name),
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 12,
          }}
        >
          <Text style={{ fontSize: 52 }}>{categoryIcon(merchant.categoryType)}</Text>
          <View style={{ position: 'absolute', top: 10, right: 10 }}>
            <Tag
              label={merchant.isOpen ? 'Open' : 'Closed'}
              tone={merchant.isOpen ? 'ok' : 'off'}
            />
          </View>
          <View style={{ position: 'absolute', bottom: 10, left: 10 }}>
            <Tag label={`${merchant.prepMinutes}–${merchant.prepMinutes + 10} min`} />
          </View>
        </View>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text, flex: 1 }}>
            {merchant.name}
          </Text>
          <Rating value={pseudoRating(merchant.name)} />
        </View>
        <Text style={{ color: colors.muted, marginTop: 4, fontSize: 14, fontWeight: '600' }}>
          {titleCase(merchant.categoryType)} · Delivery from KES 150
        </Text>
      </Card>
    </Pressable>
  );
}

function TrackEntry({ onTrack }: { onTrack: (ulid: string) => void }): JSX.Element {
  const [ulid, setUlid] = useState('');
  return (
    <View style={{ marginHorizontal: 18, marginTop: 6 }}>
      <Card>
        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 2 }}>
          Have an order? 📦
        </Text>
        <Text style={{ color: colors.muted, marginBottom: 10, fontSize: 14 }}>
          Paste your order code to follow it live.
        </Text>
        <Field label="Order ULID" value={ulid} onChangeText={setUlid} placeholder="01M5…" />
        <PrimaryButton title="Track my order" onPress={() => onTrack(ulid.trim())} />
      </Card>
    </View>
  );
}

// ---- merchant menu ---------------------------------------------------------------------------

function money(cents: number, currency = 'KES'): string {
  return `${currency} ${(cents / 100).toFixed(0)}`;
}

function MenuScreen({
  model,
  catalogue,
  banner,
}: {
  model: CustomerModel;
  catalogue: PublicCatalogue | null;
  banner: JSX.Element | null;
}): JSX.Element {
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);

  if (!catalogue) {
    return <View style={{ padding: 18 }}>{banner}</View>;
  }
  const m = catalogue.merchant;
  const products = catalogueProducts(catalogue);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 110 }}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{
            height: 160,
            backgroundColor: thumbColor(m.name),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 68 }}>{categoryIcon(m.categoryType)}</Text>
          <Pressable
            accessibilityLabel="Back"
            onPress={() => model.backToBrowse()}
            style={{
              position: 'absolute',
              top: 14,
              left: 14,
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: '#ffffff',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>‹</Text>
          </Pressable>
        </View>

        <View style={{ padding: 18 }}>
          <Text style={{ fontSize: 24, fontWeight: '900', color: colors.text }}>{m.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
            <Rating value={pseudoRating(m.name)} />
            <Text style={{ color: colors.muted, fontWeight: '600', marginHorizontal: 8 }}>
              · {m.prepMinutes}–{m.prepMinutes + 10} min · {titleCase(m.categoryType)}
            </Text>
            <Tag label={m.isOpen ? 'Open' : 'Closed'} tone={m.isOpen ? 'ok' : 'off'} />
          </View>
        </View>

        {banner}
        <View style={{ paddingHorizontal: 18 }}>
          <SectionTitle>Menu</SectionTitle>
        </View>
        {products.map((p) => (
          <MenuRow
            key={p.ulid}
            product={p}
            onAdd={() => {
              setCount((c) => c + 1);
              setTotal((t) => t + p.priceCents);
            }}
          />
        ))}
      </ScrollView>

      {count > 0 ? (
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
          <Pressable style={basketBarStyle}>
            <Text style={{ color: colors.onPrimary, fontWeight: '800', fontSize: 15 }}>
              View basket · {count} item{count > 1 ? 's' : ''}
            </Text>
            <Text style={{ color: colors.onPrimary, fontWeight: '900', fontSize: 15 }}>
              {money(total)}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const basketBarStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'space-between' as const,
  backgroundColor: colors.primary,
  borderRadius: 999,
  paddingVertical: 17,
  paddingHorizontal: 22,
  shadowColor: colors.primary,
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.4,
  shadowRadius: 16,
};

function MenuRow({ product, onAdd }: { product: PublicProduct; onAdd: () => void }): JSX.Element {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Thumb emoji={foodEmoji(product.name)} seed={product.name} size={56} />
      <View style={{ flex: 1, marginLeft: 14, marginRight: 10 }}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>{product.name}</Text>
        {product.description ? (
          <Text numberOfLines={2} style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
            {product.description}
          </Text>
        ) : null}
        <Text style={{ color: colors.text, fontWeight: '800', marginTop: 6 }}>
          {money(product.priceCents, product.currency)}
        </Text>
      </View>
      <AddButton onPress={onAdd} />
    </View>
  );
}

// ---- order tracking --------------------------------------------------------------------------

const STEPS: { key: string; label: string; icon: string }[] = [
  { key: 'placed', label: 'Order placed', icon: '🧾' },
  { key: 'merchant_accepted', label: 'Accepted by restaurant', icon: '✅' },
  { key: 'preparing', label: 'Preparing your food', icon: '👨‍🍳' },
  { key: 'ready_for_pickup', label: 'Ready for pickup', icon: '📦' },
  { key: 'rider_assigned', label: 'Rider assigned', icon: '🏍️' },
  { key: 'picked_up', label: 'Picked up', icon: '🛵' },
  { key: 'out_for_delivery', label: 'On the way to you', icon: '🚀' },
  { key: 'delivered', label: 'Delivered', icon: '🎉' },
];

function prettyStatus(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function TrackScreen({
  model,
  order,
  error,
}: {
  model: CustomerModel;
  order: OrderDetail | null;
  error: string | null;
}): JSX.Element {
  const status = order?.status ?? '';
  const cancelled = status === 'cancelled' || status === 'rejected';
  const currentIndex = STEPS.findIndex((s) => s.key === status);
  const delivered = status === 'delivered';

  return (
    <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 28 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
        <Pressable
          accessibilityLabel="Back"
          onPress={() => model.backToBrowse()}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 12,
          }}
        >
          <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }}>‹</Text>
        </Pressable>
        <Text style={{ fontSize: 20, fontWeight: '900', color: colors.text }}>
          {order ? `Order ${order.orderNumber}` : 'Tracking'}
        </Text>
      </View>

      {error ? <Alert message={error} /> : null}

      {order ? (
        <Card>
          <Text style={{ fontSize: 40, textAlign: 'center' }}>
            {cancelled ? '❌' : delivered ? '🎉' : (STEPS[Math.max(currentIndex, 0)]?.icon ?? '⏳')}
          </Text>
          <Text
            style={{
              fontSize: 20,
              fontWeight: '900',
              color: cancelled ? colors.danger : colors.text,
              textAlign: 'center',
              marginTop: 6,
            }}
          >
            {prettyStatus(status || 'Pending')}
          </Text>
          <Text
            style={{ color: colors.muted, textAlign: 'center', marginTop: 4, fontWeight: '600' }}
          >
            {cancelled
              ? 'This order was cancelled.'
              : delivered
                ? 'Enjoy your meal! 🍽️'
                : 'Estimated arrival in ~20 min'}
          </Text>
        </Card>
      ) : null}

      {!cancelled && order ? (
        <View style={{ marginTop: 6 }}>
          {STEPS.map((step, i) => {
            const done = currentIndex >= 0 && i <= currentIndex;
            const active = i === currentIndex;
            return (
              <View key={step.key} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={{ alignItems: 'center', width: 40 }}>
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 15,
                      backgroundColor: done ? colors.primary : colors.surfaceAlt,
                      borderWidth: active ? 3 : 0,
                      borderColor: '#c7f0dc',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 14, color: done ? colors.onPrimary : colors.muted }}>
                      {done ? '✓' : step.icon}
                    </Text>
                  </View>
                  {i < STEPS.length - 1 ? (
                    <View
                      style={{
                        width: 2,
                        height: 26,
                        backgroundColor: i < currentIndex ? colors.primary : colors.border,
                      }}
                    />
                  ) : null}
                </View>
                <Text
                  style={{
                    marginLeft: 12,
                    marginTop: 5,
                    fontSize: 15,
                    fontWeight: active ? '800' : '600',
                    color: done ? colors.text : colors.muted,
                  }}
                >
                  {step.label}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <View style={{ marginTop: 16 }}>
        <SecondaryButton title="Back to restaurants" onPress={() => model.backToBrowse()} />
      </View>
    </ScrollView>
  );
}
