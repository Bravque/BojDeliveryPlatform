import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, SafeAreaView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { type ApiClient, catalogueProducts, createHttpApiClient } from './src/api';
import { type CustomerModel, type CustomerState, createCustomerModel } from './src/customerFlow';
import { type ConnectOrderSocket, makeConnectOrderSocket } from './src/socket';
import { API_BASE_URL } from './src/config';
import {
  Alert,
  Badge,
  Card,
  Field,
  Muted,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Title,
  colors,
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

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="auto" />
      <Screen>
        {state.busy && <ActivityIndicator accessibilityLabel="Loading" color={colors.primary} />}
        {state.error && <Alert message={state.error} />}
        {renderScreen(model, state)}
      </Screen>
    </SafeAreaView>
  );
}

function renderScreen(model: CustomerModel, state: CustomerState): JSX.Element {
  switch (state.screen) {
    case 'phone':
      return <PhoneScreen onSubmit={(phone) => void model.requestOtp(phone)} />;
    case 'otp':
      return <OtpScreen phone={state.phone} onSubmit={(code) => void model.verifyOtp(code)} />;
    case 'browse':
      return (
        <View style={{ flex: 1 }}>
          <Title>Order food &amp; more</Title>
          <Muted>Merchants near you</Muted>
          <FlatList
            data={state.merchants}
            keyExtractor={(m) => m.ulid}
            renderItem={({ item }) => (
              <Card>
                <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
                  {item.name}
                </Text>
                <Text style={{ color: colors.muted, marginTop: 2, marginBottom: 8 }}>
                  {item.categoryType} · ~{item.prepMinutes} min · {item.townName}
                </Text>
                {item.isOpen ? (
                  <PrimaryButton
                    title="View menu"
                    onPress={() => void model.openMerchant(item.ulid)}
                  />
                ) : (
                  <Badge label="Closed" />
                )}
              </Card>
            )}
          />
        </View>
      );
    case 'merchant': {
      const products = state.catalogue ? catalogueProducts(state.catalogue) : [];
      return (
        <View style={{ flex: 1 }}>
          <Title>{state.catalogue?.merchant.name}</Title>
          <Muted>Menu</Muted>
          <FlatList
            data={products}
            keyExtractor={(p) => p.ulid}
            renderItem={({ item }) => (
              <Card>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text, flex: 1 }}>
                    {item.name}
                  </Text>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: colors.primary }}>
                    {item.currency} {(item.priceCents / 100).toFixed(2)}
                  </Text>
                </View>
                {item.description ? (
                  <Text style={{ color: colors.muted, marginTop: 4 }}>{item.description}</Text>
                ) : null}
              </Card>
            )}
          />
          {/* Demo entry point to the live-tracking screen (an active order would normally link here). */}
          <PrimaryButton title="Track my order" onPress={() => void model.trackOrder('demo')} />
          <SecondaryButton title="Back to merchants" onPress={() => model.backToBrowse()} />
        </View>
      );
    }
    case 'track':
      return (
        <View style={{ flex: 1 }}>
          <Title>Order {state.order?.orderNumber}</Title>
          <Muted>Live status</Muted>
          <Card>
            <Badge label={(state.order?.status ?? '').replace(/_/g, ' ')} />
            <Text style={{ color: colors.muted, marginTop: 8 }}>
              We&apos;ll update this automatically as your order progresses.
            </Text>
          </Card>
          <SecondaryButton title="Back to merchants" onPress={() => model.backToBrowse()} />
        </View>
      );
  }
}

function PhoneScreen({ onSubmit }: { onSubmit: (phone: string) => void }): JSX.Element {
  const [phone, setPhone] = useState('');
  return (
    <View>
      <Title>Welcome to Boj</Title>
      <Muted>Sign in with your phone number</Muted>
      <Field
        label="Phone number"
        value={phone}
        onChangeText={setPhone}
        placeholder="+2547…"
        keyboardType="phone-pad"
      />
      <PrimaryButton title="Send code" onPress={() => onSubmit(phone)} />
    </View>
  );
}

function OtpScreen({
  phone,
  onSubmit,
}: {
  phone: string;
  onSubmit: (code: string) => void;
}): JSX.Element {
  const [code, setCode] = useState('');
  return (
    <View>
      <Title>Enter code</Title>
      <Muted>Sent to {phone}</Muted>
      <Field
        label="Verification code"
        value={code}
        onChangeText={setCode}
        placeholder="6-digit code"
        keyboardType="number-pad"
      />
      <PrimaryButton title="Verify" onPress={() => onSubmit(code)} />
    </View>
  );
}
