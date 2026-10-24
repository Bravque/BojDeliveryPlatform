import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  FlatList,
  SafeAreaView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { type ApiClient, createHttpApiClient } from './src/api';
import { type RiderModel, type RiderState, createRiderModel } from './src/riderFlow';
import { API_BASE_URL } from './src/config';

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
 * (unit-tested); this component only renders state and binds inputs. The RN UI is typecheck-
 * verified only (no device/emulator in CI). `api` is injectable for a future RN render test.
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
    <SafeAreaView>
      <StatusBar style="auto" />
      {state.busy && <ActivityIndicator accessibilityLabel="Loading" />}
      {state.error && <Text accessibilityRole="alert">{state.error}</Text>}
      {renderScreen(model, state)}
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
        <View>
          <Text accessibilityRole="header">{state.online ? 'Online' : 'Offline'}</Text>
          {state.online ? (
            <Button title="Go offline" onPress={() => void model.goOffline()} />
          ) : (
            <Button title="Go online" onPress={() => void model.goOnline()} />
          )}
          <Button title="Refresh offers" onPress={() => void model.refreshOffers()} />
          {state.offers.length === 0 ? (
            <Text>No live offers.</Text>
          ) : (
            <FlatList
              data={state.offers}
              keyExtractor={(o) => String(o.offerId)}
              renderItem={({ item }) => (
                <View>
                  <Text>Order {item.orderUlid}</Text>
                  <Button title="Accept" onPress={() => void model.acceptOffer(item.offerId)} />
                </View>
              )}
            />
          )}
        </View>
      );
    case 'delivery': {
      const status = state.delivery?.deliveryStatus;
      return (
        <View>
          <Text>Order {state.delivery?.orderUlid}</Text>
          <Text accessibilityRole="header">{status}</Text>
          {status === 'assigned' && (
            <Button title="Confirm pickup" onPress={() => void model.pickup()} />
          )}
          {status === 'picked_up' && (
            <Button title="Start delivery" onPress={() => void model.startDelivery()} />
          )}
          {status === 'out_for_delivery' && (
            <CompleteScreen onSubmit={(pin) => void model.complete(pin)} />
          )}
          <Button title="Back to offers" onPress={() => model.backToOffers()} />
        </View>
      );
    }
  }
}

function PhoneScreen({ onSubmit }: { onSubmit: (phone: string) => void }): JSX.Element {
  const [phone, setPhone] = useState('');
  return (
    <View>
      <Text>Rider sign in</Text>
      <TextInput
        accessibilityLabel="Phone"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
      />
      <Button title="Send code" onPress={() => onSubmit(phone)} />
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
      <Text>Code sent to {phone}</Text>
      <TextInput
        accessibilityLabel="Code"
        keyboardType="number-pad"
        value={code}
        onChangeText={setCode}
      />
      <Button title="Verify" onPress={() => onSubmit(code)} />
    </View>
  );
}

function CompleteScreen({ onSubmit }: { onSubmit: (pin: string) => void }): JSX.Element {
  const [pin, setPin] = useState('');
  return (
    <View>
      <Text>Enter the customer&apos;s delivery PIN</Text>
      <TextInput
        accessibilityLabel="PIN"
        keyboardType="number-pad"
        value={pin}
        onChangeText={setPin}
      />
      <Button title="Complete delivery" onPress={() => onSubmit(pin)} />
    </View>
  );
}
