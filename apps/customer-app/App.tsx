import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  type ApiClient,
  type OrderDetail,
  type OrderSummary,
  type PublicCatalogue,
  type PublicMerchant,
  type PublicProduct,
  catalogueProducts,
  createHttpApiClient,
} from './src/api';
import {
  type BasketLine,
  type CustomerModel,
  type CustomerState,
  type Tab,
  createCustomerModel,
  isTab,
} from './src/customerFlow';
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
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {renderScreen(model, state, banner)}
      </View>
      {isTab(state.screen) ? (
        <TabBar active={state.screen} onSelect={(t) => model.goToTab(t)} />
      ) : null}
    </SafeAreaView>
  );
}

function TabBar({ active, onSelect }: { active: Tab; onSelect: (t: Tab) => void }): JSX.Element {
  const items: { tab: Tab; icon: string; label: string }[] = [
    { tab: 'home', icon: '🏠', label: 'Home' },
    { tab: 'stores', icon: '🏪', label: 'Stores' },
    { tab: 'search', icon: '🔍', label: 'Search' },
    { tab: 'orders', icon: '🧾', label: 'Orders' },
    { tab: 'account', icon: '👤', label: 'Account' },
  ];
  return (
    <View
      style={{
        flexDirection: 'row',
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface,
        paddingTop: 8,
        paddingBottom: 10,
      }}
    >
      {items.map((it) => {
        const on = it.tab === active;
        return (
          <Pressable
            key={it.tab}
            accessibilityRole="button"
            accessibilityLabel={it.label}
            onPress={() => onSelect(it.tab)}
            style={{ flex: 1, alignItems: 'center' }}
          >
            <Text style={{ fontSize: 20, opacity: on ? 1 : 0.45 }}>{it.icon}</Text>
            <Text
              style={{
                fontSize: 11,
                marginTop: 2,
                fontWeight: on ? '800' : '600',
                color: on ? colors.primary : colors.muted,
              }}
            >
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
    case 'home':
      return <HomeScreen model={model} merchants={state.merchants} banner={banner} />;
    case 'stores':
      return <StoresScreen model={model} merchants={state.merchants} />;
    case 'search':
      return <SearchScreen model={model} merchants={state.merchants} />;
    case 'orders':
      return <OrdersScreen model={model} state={state} banner={banner} />;
    case 'account':
      return <AccountScreen model={model} state={state} />;
    case 'merchant':
      return (
        <MenuScreen
          model={model}
          catalogue={state.catalogue}
          basket={state.basket}
          banner={banner}
        />
      );
    case 'checkout':
      return <CheckoutScreen model={model} state={state} banner={banner} />;
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

/** A tappable search box that just navigates to the Search tab. */
function SearchPrompt({ onPress }: { onPress: () => void }): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surfaceAlt,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 13,
        marginHorizontal: 18,
        marginVertical: 8,
      }}
    >
      <Text style={{ fontSize: 16, marginRight: 8, color: colors.muted }}>🔍</Text>
      <Text style={{ fontSize: 15, color: colors.muted }}>Search restaurants and dishes</Text>
    </Pressable>
  );
}

function CategoryBar({
  merchants,
  active,
  onSelect,
}: {
  merchants: PublicMerchant[];
  active: string;
  onSelect: (c: string) => void;
}): JSX.Element {
  const cats = ['all', ...Array.from(new Set(merchants.map((m) => m.categoryType)))];
  return (
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
          active={active === c}
          onPress={() => onSelect(c)}
        />
      ))}
    </ScrollView>
  );
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
  const [cat, setCat] = useState('all');
  const shown = merchants.filter((m) => cat === 'all' || m.categoryType === cat);

  return (
    <View style={{ flex: 1 }}>
      <LocationBar place={merchants[0]?.townName ?? 'Migori'} />
      <SearchPrompt onPress={() => model.goToTab('search')} />
      <CategoryBar merchants={merchants} active={cat} onSelect={setCat} />
      {banner}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: 18 }}>
          <SectionTitle>Restaurants near you</SectionTitle>
        </View>
        {shown.map((m) => (
          <RestaurantCard
            key={m.ulid}
            merchant={m}
            onPress={() => void model.openMerchant(m.ulid)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ---- stores tab (compact list of every merchant) ---------------------------------------------

function StoresScreen({
  model,
  merchants,
}: {
  model: CustomerModel;
  merchants: PublicMerchant[];
}): JSX.Element {
  const [cat, setCat] = useState('all');
  const shown = merchants.filter((m) => cat === 'all' || m.categoryType === cat);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
        <Title>Stores</Title>
      </View>
      <CategoryBar merchants={merchants} active={cat} onSelect={setCat} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
      >
        {shown.map((m) => (
          <MerchantRow key={m.ulid} merchant={m} onPress={() => void model.openMerchant(m.ulid)} />
        ))}
      </ScrollView>
    </View>
  );
}

function MerchantRow({
  merchant,
  onPress,
}: {
  merchant: PublicMerchant;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          backgroundColor: thumbColor(merchant.name),
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 14,
        }}
      >
        <Text style={{ fontSize: 26 }}>{categoryIcon(merchant.categoryType)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>{merchant.name}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
          {titleCase(merchant.categoryType)} · {merchant.prepMinutes}–{merchant.prepMinutes + 10}{' '}
          min
        </Text>
      </View>
      <Tag label={merchant.isOpen ? 'Open' : 'Closed'} tone={merchant.isOpen ? 'ok' : 'off'} />
    </Pressable>
  );
}

// ---- search tab --------------------------------------------------------------------------------

function SearchScreen({
  model,
  merchants,
}: {
  model: CustomerModel;
  merchants: PublicMerchant[];
}): JSX.Element {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? merchants.filter((m) => m.name.toLowerCase().includes(q)) : merchants;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
        <Title>Search</Title>
      </View>
      <SearchBar value={query} onChangeText={setQuery} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
      >
        {shown.length === 0 ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 10 }}>
            <Muted>No results for “{query}”.</Muted>
          </View>
        ) : (
          shown.map((m) => (
            <MerchantRow
              key={m.ulid}
              merchant={m}
              onPress={() => void model.openMerchant(m.ulid)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

// ---- orders tab --------------------------------------------------------------------------------

function OrdersScreen({
  model,
  state,
  banner,
}: {
  model: CustomerModel;
  state: CustomerState;
  banner: JSX.Element | null;
}): JSX.Element {
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 18,
          paddingTop: 12,
        }}
      >
        <Title>Your orders</Title>
        <SecondaryButton title="Refresh" onPress={() => void model.loadOrders()} />
      </View>
      {banner}
      {state.error ? (
        <View style={{ paddingHorizontal: 18 }}>
          <Alert message={state.error} />
        </View>
      ) : null}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 20, paddingTop: 6 }}
        showsVerticalScrollIndicator={false}
      >
        {state.orders.length === 0 ? (
          <View style={{ paddingHorizontal: 18 }}>
            <Card>
              <Text style={{ fontSize: 32, textAlign: 'center' }}>🧾</Text>
              <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 6 }}>
                No orders yet. Your orders will show up here.
              </Text>
            </Card>
          </View>
        ) : (
          state.orders.map((o) => (
            <OrderRow key={o.ulid} order={o} onPress={() => void model.trackOrder(o.ulid)} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function OrderRow({ order, onPress }: { order: OrderSummary; onPress: () => void }): JSX.Element {
  const paid = order.paymentStatus === 'paid';
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
          {order.orderNumber}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
          {order.currency} {(order.totalCents / 100).toFixed(0)} ·{' '}
          {new Date(order.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <Tag label={prettyStatus(order.status)} tone={paid ? 'ok' : 'neutral'} />
      <Text style={{ fontSize: 20, color: colors.muted, marginLeft: 8 }}>›</Text>
    </Pressable>
  );
}

// ---- account tab -------------------------------------------------------------------------------

function AccountScreen({
  model,
  state,
}: {
  model: CustomerModel;
  state: CustomerState;
}): JSX.Element {
  return (
    <ScrollView contentContainerStyle={{ padding: 18 }}>
      <Title>Account</Title>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              backgroundColor: colors.surfaceAlt,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 14,
            }}
          >
            <Text style={{ fontSize: 26 }}>👤</Text>
          </View>
          <View>
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
              Signed in as
            </Text>
            <Text style={{ color: colors.muted, marginTop: 2 }}>{state.phone}</Text>
          </View>
        </View>
      </Card>
      <SecondaryButton title="Sign out" onPress={() => model.signOut()} />
      <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 16, fontSize: 12 }}>
        Boj Food · demo build
      </Text>
    </ScrollView>
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

// ---- merchant menu ---------------------------------------------------------------------------

function money(cents: number, currency = 'KES'): string {
  return `${currency} ${(cents / 100).toFixed(0)}`;
}

function MenuScreen({
  model,
  catalogue,
  basket,
  banner,
}: {
  model: CustomerModel;
  catalogue: PublicCatalogue | null;
  basket: BasketLine[];
  banner: JSX.Element | null;
}): JSX.Element {
  if (!catalogue) {
    return <View style={{ padding: 18 }}>{banner}</View>;
  }
  const m = catalogue.merchant;
  const products = catalogueProducts(catalogue);
  const count = basket.reduce((n, b) => n + b.qty, 0);
  const total = basket.reduce((s, b) => s + b.priceCents * b.qty, 0);

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
          <MenuRow key={p.ulid} product={p} onAdd={() => void model.addToBasket(p)} />
        ))}
      </ScrollView>

      {count > 0 ? (
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
          <Pressable style={basketBarStyle} onPress={() => void model.openCheckout()}>
            <Text style={{ color: colors.onPrimary, fontWeight: '800', fontSize: 15 }}>
              Go to checkout · {count} item{count > 1 ? 's' : ''}
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

// ---- checkout --------------------------------------------------------------------------------

function CheckoutScreen({
  model,
  state,
  banner,
}: {
  model: CustomerModel;
  state: CustomerState;
  banner: JSX.Element | null;
}): JSX.Element {
  const q = state.quote;
  return (
    <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 28 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <Pressable
          accessibilityLabel="Back"
          onPress={() => model.backToMenu()}
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
        <Text style={{ fontSize: 22, fontWeight: '900', color: colors.text }}>Checkout</Text>
      </View>

      {state.error ? <Alert message={state.error} /> : null}

      <SectionTitle>Your order</SectionTitle>
      <Card>
        {state.basket.map((line) => (
          <View
            key={line.productUlid}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }}>
              {line.qty} × {line.name}
            </Text>
            <Text style={{ color: colors.text, fontWeight: '700' }}>
              {money(line.priceCents * line.qty, line.currency)}
            </Text>
          </View>
        ))}
      </Card>

      <SectionTitle>Delivery to</SectionTitle>
      <Card>
        <Text style={{ color: colors.text, fontWeight: '700' }}>📍 {state.address?.line1}</Text>
      </Card>

      {q ? (
        <Card>
          <SummaryRow label="Subtotal" value={money(q.subtotalCents, q.currency)} />
          <SummaryRow label="Delivery fee" value={money(q.deliveryFeeCents, q.currency)} />
          {q.serviceFeeCents > 0 ? (
            <SummaryRow label="Service fee" value={money(q.serviceFeeCents, q.currency)} />
          ) : null}
          {q.discountCents > 0 ? (
            <SummaryRow label="Discount" value={`- ${money(q.discountCents, q.currency)}`} />
          ) : null}
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 17, fontWeight: '900', color: colors.text }}>Total</Text>
            <Text style={{ fontSize: 17, fontWeight: '900', color: colors.text }}>
              {money(q.totalCents, q.currency)}
            </Text>
          </View>
        </Card>
      ) : null}

      {banner}

      <PrimaryButton
        title={q ? `Pay ${money(q.totalCents, q.currency)} with M-Pesa` : 'Pay with M-Pesa'}
        onPress={() => void model.placeOrder()}
      />
      <Muted>You&apos;ll get an M-Pesa prompt on {state.phone} to confirm.</Muted>
    </ScrollView>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: colors.muted, fontWeight: '600' }}>{label}</Text>
      <Text style={{ color: colors.text, fontWeight: '700' }}>{value}</Text>
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
  const pending = status === 'payment_pending' || status === 'draft';
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
            {cancelled
              ? '❌'
              : pending
                ? '💳'
                : delivered
                  ? '🎉'
                  : (STEPS[Math.max(currentIndex, 0)]?.icon ?? '⏳')}
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
            {pending ? 'Awaiting payment' : prettyStatus(status || 'Pending')}
          </Text>
          <Text
            style={{ color: colors.muted, textAlign: 'center', marginTop: 4, fontWeight: '600' }}
          >
            {cancelled
              ? 'This order was cancelled.'
              : pending
                ? `Approve the M-Pesa prompt on your phone to confirm.`
                : delivered
                  ? 'Enjoy your meal! 🍽️'
                  : 'Estimated arrival in ~20 min'}
          </Text>
        </Card>
      ) : null}

      {!cancelled && !pending && order ? (
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
