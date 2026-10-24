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
import { type ApiClient, catalogueProducts, createHttpApiClient } from './src/api';
import { type CustomerModel, type CustomerState, createCustomerModel } from './src/customerFlow';
import { type ConnectOrderSocket, makeConnectOrderSocket } from './src/socket';
import { API_BASE_URL } from './src/config';

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
 * this component only renders state and binds inputs. The RN UI is intentionally minimal and is
 * typecheck-verified only (no device/emulator in CI). `api`/`connectSocket` are injectable for a
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
    <SafeAreaView>
      <StatusBar style="auto" />
      {state.busy && <ActivityIndicator accessibilityLabel="Loading" />}
      {state.error && <Text accessibilityRole="alert">{state.error}</Text>}
      {renderScreen(model, state)}
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
        <View>
          <Text>Merchants near you</Text>
          <FlatList
            data={state.merchants}
            keyExtractor={(m) => m.ulid}
            renderItem={({ item }) => (
              <View>
                <Text>{item.name}</Text>
                <Button
                  title={item.isOpen ? 'View menu' : 'Closed'}
                  disabled={!item.isOpen}
                  onPress={() => void model.openMerchant(item.ulid)}
                />
              </View>
            )}
          />
        </View>
      );
    case 'merchant': {
      const products = state.catalogue ? catalogueProducts(state.catalogue) : [];
      return (
        <View>
          <Text>{state.catalogue?.merchant.name}</Text>
          <FlatList
            data={products}
            keyExtractor={(p) => p.ulid}
            renderItem={({ item }) => (
              <Text>
                {item.name} — {(item.priceCents / 100).toFixed(2)} {item.currency}
              </Text>
            )}
          />
          <Button title="Back" onPress={() => model.backToBrowse()} />
        </View>
      );
    }
    case 'track':
      return (
        <View>
          <Text>Order {state.order?.orderNumber}</Text>
          <Text accessibilityRole="header">{state.order?.status}</Text>
          <Button title="Back" onPress={() => model.backToBrowse()} />
        </View>
      );
  }
}

function PhoneScreen({ onSubmit }: { onSubmit: (phone: string) => void }): JSX.Element {
  const [phone, setPhone] = useState('');
  return (
    <View>
      <Text>Enter your phone</Text>
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
