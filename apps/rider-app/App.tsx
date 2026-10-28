import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  type ApiClient,
  type DeliveryView,
  type RiderOfferView,
  createHttpApiClient,
} from './src/api';
import {
  type RiderModel,
  type RiderState,
  type Tab,
  createRiderModel,
  isTab,
} from './src/riderFlow';
import { type ConnectRiderSocket, makeConnectRiderSocket } from './src/socket';
import { API_BASE_URL } from './src/config';
import {
  Alert,
  Brand,
  Card,
  Field,
  Muted,
  PaddedScreen,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  Tag,
  Title,
  colors,
} from './src/ui';

export interface AppProps {
  api?: ApiClient;
  connectSocket?: ConnectRiderSocket;
}

/** Root component Expo registers — no props, always wires the real API + socket. */
export default function App(): JSX.Element {
  return <RiderApp />;
}

/**
 * Rider app shell (MVP critical journey): phone-OTP sign-in → go online → accept a live offer →
 * pickup → start → complete with the customer's PIN. All logic lives in `createRiderModel`
 * (unit-tested); this component only renders state and binds inputs. `api`/`connectSocket` are
 * injectable for a future RN render test.
 */
export function RiderApp({ api, connectSocket }: AppProps = {}): JSX.Element {
  const modelRef = useRef<RiderModel>();
  if (!modelRef.current) {
    modelRef.current = createRiderModel(api ?? createHttpApiClient(API_BASE_URL));
  }
  const model = modelRef.current;
  const connect = connectSocket ?? makeConnectRiderSocket(API_BASE_URL);

  const [state, setState] = useState<RiderState>(model.getState());
  useEffect(() => model.subscribe(setState), [model]);

  // While online, listen for offer pushes and silently re-fetch live offers on each nudge.
  useEffect(() => {
    if (!state.online || !state.token) {
      return;
    }
    const handle = connect(state.token, () => void model.onOfferPush());
    return () => handle.close();
  }, [state.online, state.token, connect, model]);

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
    { tab: 'offers', icon: '🛵', label: 'Shift' },
    { tab: 'delivery', icon: '📦', label: 'Delivery' },
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
  model: RiderModel,
  state: RiderState,
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
    case 'offers':
      return <OffersScreen model={model} state={state} banner={banner} />;
    case 'delivery':
      return <DeliveryScreen model={model} delivery={state.delivery} banner={banner} />;
    case 'account':
      return <AccountScreen model={model} state={state} />;
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
      <Title>Deliver and earn</Title>
      <Muted>Sign in with your phone number to start your shift.</Muted>
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

// ---- offers ----------------------------------------------------------------------------------

function OffersScreen({
  model,
  state,
  banner,
}: {
  model: RiderModel;
  state: RiderState;
  banner: JSX.Element | null;
}): JSX.Element {
  return (
    <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 28 }}>
      <Brand />
      <Title>Your shift</Title>
      {state.error ? <Alert message={state.error} /> : null}

      <Card>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>
            {state.online ? '🟢 You’re online' : '⚪ You’re offline'}
          </Text>
          <Tag label={state.online ? 'Online' : 'Offline'} tone={state.online ? 'ok' : 'off'} />
        </View>
        <Text style={{ color: colors.muted, marginTop: 6, marginBottom: 10 }}>
          {state.online
            ? 'Stay online — new offers arrive here instantly.'
            : 'Go online to start receiving delivery offers.'}
        </Text>
        {state.online ? (
          <SecondaryButton title="Go offline" onPress={() => void model.goOffline()} />
        ) : (
          <PrimaryButton title="Go online" onPress={() => void model.goOnline()} />
        )}
      </Card>

      {banner}

      {state.online ? (
        <>
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <SectionTitle>Live offers</SectionTitle>
            <SecondaryButton title="Refresh" onPress={() => void model.refreshOffers()} />
          </View>
          {state.offers.length === 0 ? (
            <Card>
              <Text style={{ fontSize: 32, textAlign: 'center' }}>📭</Text>
              <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 6 }}>
                No offers right now. We’ll ping you the moment one lands.
              </Text>
            </Card>
          ) : (
            state.offers.map((o) => (
              <OfferCard
                key={o.offerId}
                offer={o}
                onAccept={() => void model.acceptOffer(o.offerId)}
              />
            ))
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

function OfferCard({
  offer,
  onAccept,
}: {
  offer: RiderOfferView;
  onAccept: () => void;
}): JSX.Element {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            backgroundColor: '#e4f8ee',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 12,
          }}
        >
          <Text style={{ fontSize: 24 }}>📦</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
              Order {offer.orderUlid.slice(-6)}
            </Text>
            <View style={{ marginLeft: 8 }}>
              <Tag label="New" tone="ok" />
            </View>
          </View>
          <Text style={{ color: colors.muted, marginTop: 2, fontSize: 13 }}>
            Offer #{offer.offerId} · tap to accept before it expires
          </Text>
        </View>
      </View>
      <PrimaryButton title="Accept delivery" onPress={onAccept} />
    </Card>
  );
}

// ---- delivery --------------------------------------------------------------------------------

const STEPS: { key: string; label: string; icon: string }[] = [
  { key: 'assigned', label: 'Head to the restaurant', icon: '🏍️' },
  { key: 'picked_up', label: 'Picked up the order', icon: '📦' },
  { key: 'out_for_delivery', label: 'On the way to customer', icon: '🚀' },
  { key: 'delivered', label: 'Delivered', icon: '🎉' },
];

function money(cents: number): string {
  return `KES ${(cents / 100).toFixed(0)}`;
}

function DeliveryScreen({
  model,
  delivery,
  banner,
}: {
  model: RiderModel;
  delivery: DeliveryView | null;
  banner: JSX.Element | null;
}): JSX.Element {
  const [pin, setPin] = useState('');

  if (!delivery) {
    return (
      <ScrollView contentContainerStyle={{ padding: 18 }}>
        <Title>Delivery</Title>
        <Card>
          <Text style={{ fontSize: 34, textAlign: 'center' }}>📦</Text>
          <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 6 }}>
            No active delivery. Accept an offer on the Shift tab to get going.
          </Text>
        </Card>
        <PrimaryButton title="Go to Shift" onPress={() => model.goToTab('offers')} />
      </ScrollView>
    );
  }

  const status = delivery.deliveryStatus;
  const currentIndex = STEPS.findIndex((s) => s.key === status);

  return (
    <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 28 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
        <Title>Active delivery</Title>
      </View>

      <Card>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
            Order {delivery?.orderUlid.slice(-6) ?? ''}
          </Text>
          <Tag label={status.replace(/_/g, ' ') || 'assigned'} tone="ok" />
        </View>
        <Text style={{ color: colors.primaryDark, fontWeight: '800', marginTop: 8, fontSize: 18 }}>
          Earns {money(delivery?.riderFeeCents ?? 0)}
        </Text>
      </Card>

      <View style={{ marginTop: 2, marginBottom: 8 }}>
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
                      height: 24,
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

      {banner}

      {status === 'assigned' ? (
        <PrimaryButton title="Confirm pickup" onPress={() => void model.pickup()} />
      ) : null}
      {status === 'picked_up' ? (
        <PrimaryButton title="Start delivery" onPress={() => void model.startDelivery()} />
      ) : null}
      {status === 'out_for_delivery' ? (
        <View>
          <Field
            label="Customer's delivery PIN"
            value={pin}
            onChangeText={setPin}
            placeholder="4-digit PIN"
            keyboardType="number-pad"
          />
          <PrimaryButton
            title="Complete delivery"
            onPress={() => void model.complete(pin.trim())}
          />
        </View>
      ) : null}
      {status === 'delivered' ? (
        <View style={{ alignItems: 'center', marginVertical: 10 }}>
          <Text style={{ fontSize: 40 }}>🎉</Text>
          <Text
            style={{ fontSize: 18, fontWeight: '800', color: colors.primaryDark, marginTop: 6 }}
          >
            Delivered! Nice work.
          </Text>
        </View>
      ) : null}

      <View style={{ marginTop: 10 }}>
        <SecondaryButton title="Back to offers" onPress={() => model.backToOffers()} />
      </View>
    </ScrollView>
  );
}

// ---- account tab -------------------------------------------------------------------------------

function AccountScreen({ model, state }: { model: RiderModel; state: RiderState }): JSX.Element {
  const me = state.me;
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
            <Text style={{ fontSize: 26 }}>🛵</Text>
          </View>
          <View>
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
              Signed in as
            </Text>
            <Text style={{ color: colors.muted, marginTop: 2 }}>{state.phone}</Text>
          </View>
        </View>
      </Card>
      {me ? (
        <Card>
          <AccountRow label="Status" value={me.status} />
          <AccountRow label="Vehicle" value={me.vehicleType} />
          <AccountRow label="Online" value={state.online ? 'Yes' : 'No'} />
        </Card>
      ) : null}
      {state.error ? <Alert message={state.error} /> : null}
      <SecondaryButton title="Sign out" onPress={() => model.signOut()} />
      <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 16, fontSize: 12 }}>
        Boj Courier · demo build
      </Text>
    </ScrollView>
  );
}

function AccountRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text style={{ color: colors.muted, fontWeight: '600' }}>{label}</Text>
      <Text style={{ color: colors.text, fontWeight: '700', textTransform: 'capitalize' }}>
        {value}
      </Text>
    </View>
  );
}
