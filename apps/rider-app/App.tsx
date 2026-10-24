import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, SafeAreaView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { type ApiClient, createHttpApiClient } from './src/api';
import { type RiderModel, type RiderState, createRiderModel } from './src/riderFlow';
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
}

/** Root component Expo registers — no props, always wires the real API. */
export default function App(): JSX.Element {
  return <RiderApp />;
}

/**
 * Rider app shell (MVP critical journey): phone-OTP sign-in → go online → accept a live offer →
 * pickup → start → complete with the customer's PIN. All logic lives in `createRiderModel`
 * (unit-tested); this component only renders state and binds inputs. `api` is injectable for a
 * future RN render test.
 */
export function RiderApp({ api }: AppProps = {}): JSX.Element {
  const modelRef = useRef<RiderModel>();
  if (!modelRef.current) {
    modelRef.current = createRiderModel(api ?? createHttpApiClient(API_BASE_URL));
  }
  const model = modelRef.current;

  const [state, setState] = useState<RiderState>(model.getState());
  useEffect(() => model.subscribe(setState), [model]);

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

function renderScreen(model: RiderModel, state: RiderState): JSX.Element {
  switch (state.screen) {
    case 'phone':
      return <PhoneScreen onSubmit={(phone) => void model.requestOtp(phone)} />;
    case 'otp':
      return <OtpScreen phone={state.phone} onSubmit={(code) => void model.verifyOtp(code)} />;
    case 'offers':
      return (
        <View style={{ flex: 1 }}>
          <Title>Rider</Title>
          <Badge label={state.online ? 'Online' : 'Offline'} />
          {state.online ? (
            <SecondaryButton title="Go offline" onPress={() => void model.goOffline()} />
          ) : (
            <PrimaryButton title="Go online" onPress={() => void model.goOnline()} />
          )}
          <View style={{ height: 8 }} />
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Muted>Live offers</Muted>
            <SecondaryButton title="Refresh" onPress={() => void model.refreshOffers()} />
          </View>
          {state.offers.length === 0 ? (
            <Card>
              <Text style={{ color: colors.muted }}>No live offers right now.</Text>
            </Card>
          ) : (
            <FlatList
              data={state.offers}
              keyExtractor={(o) => String(o.offerId)}
              renderItem={({ item }) => (
                <Card>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                    Order {item.orderUlid}
                  </Text>
                  <Text style={{ color: colors.muted, marginTop: 2, marginBottom: 8 }}>
                    Offer #{item.offerId}
                  </Text>
                  <PrimaryButton
                    title="Accept"
                    onPress={() => void model.acceptOffer(item.offerId)}
                  />
                </Card>
              )}
            />
          )}
        </View>
      );
    case 'delivery': {
      const status = state.delivery?.deliveryStatus;
      return (
        <View style={{ flex: 1 }}>
          <Title>Delivery</Title>
          <Muted>Order {state.delivery?.orderUlid}</Muted>
          <Card>
            <Badge label={(status ?? '').replace(/_/g, ' ')} />
            <Text style={{ color: colors.muted, marginTop: 8 }}>
              Fee: KES {((state.delivery?.riderFeeCents ?? 0) / 100).toFixed(2)}
            </Text>
          </Card>
          {status === 'assigned' && (
            <PrimaryButton title="Confirm pickup" onPress={() => void model.pickup()} />
          )}
          {status === 'picked_up' && (
            <PrimaryButton title="Start delivery" onPress={() => void model.startDelivery()} />
          )}
          {status === 'out_for_delivery' && (
            <CompleteScreen onSubmit={(pin) => void model.complete(pin)} />
          )}
          {status === 'delivered' && <Badge label="Delivered ✓" />}
          <SecondaryButton title="Back to offers" onPress={() => model.backToOffers()} />
        </View>
      );
    }
  }
}

function PhoneScreen({ onSubmit }: { onSubmit: (phone: string) => void }): JSX.Element {
  const [phone, setPhone] = useState('');
  return (
    <View>
      <Title>Rider sign in</Title>
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

function CompleteScreen({ onSubmit }: { onSubmit: (pin: string) => void }): JSX.Element {
  const [pin, setPin] = useState('');
  return (
    <View>
      <Field
        label="Customer's delivery PIN"
        value={pin}
        onChangeText={setPin}
        placeholder="4-digit PIN"
        keyboardType="number-pad"
      />
      <PrimaryButton title="Complete delivery" onPress={() => onSubmit(pin)} />
    </View>
  );
}
