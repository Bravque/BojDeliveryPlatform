import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, MerchantOrders } from './api';
import type { ConnectMerchantSocket, SocketHandle } from './socket';

export interface AppProps {
  api: ApiClient;
  connectSocket: ConnectMerchantSocket;
}

/**
 * Merchant dashboard (MVP critical journey): log in, see live orders, accept → mark ready. The
 * socket only nudges — every realtime event triggers a REST re-fetch, so the list is always
 * canonical.
 */
export function App({ api, connectSocket }: AppProps): JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<MerchantOrders | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<SocketHandle | null>(null);

  const refresh = useCallback(
    async (tok: string) => {
      setData(await api.listMerchantOrders(tok));
    },
    [api],
  );

  async function onLogin(email: string, password: string): Promise<void> {
    setError(null);
    try {
      const { access } = await api.login(email, password);
      setToken(access);
      await refresh(access);
    } catch {
      setError('Login failed');
    }
  }

  // Once logged in and the merchant is known, subscribe to its room; re-fetch on every nudge.
  useEffect(() => {
    if (!token || !data) {
      return;
    }
    if (socketRef.current) {
      return; // already connected
    }
    socketRef.current = connectSocket(token, data.merchant.ulid, () => {
      setAlert('New order activity');
      void refresh(token);
    });
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [token, data, connectSocket, refresh]);

  async function act(action: 'accept' | 'preparing' | 'ready', orderUlid: string): Promise<void> {
    if (!token) {
      return;
    }
    if (action === 'accept') {
      await api.acceptOrder(token, orderUlid);
    } else if (action === 'preparing') {
      await api.startPreparing(token, orderUlid);
    } else {
      await api.markReady(token, orderUlid);
    }
    await refresh(token);
  }

  if (!token || !data) {
    return <LoginForm onLogin={onLogin} error={error} />;
  }

  return (
    <main>
      <h1>{data.merchant.name}</h1>
      {alert && <p role="status">{alert}</p>}
      <ul>
        {data.orders.map((o) => (
          <li key={o.ulid} data-testid={`order-${o.ulid}`}>
            <span>
              {o.orderNumber} — {o.status}
            </span>
            {o.status === 'placed' && (
              <button type="button" onClick={() => void act('accept', o.ulid)}>
                Accept
              </button>
            )}
            {o.status === 'merchant_accepted' && (
              <button type="button" onClick={() => void act('preparing', o.ulid)}>
                Start preparing
              </button>
            )}
            {o.status === 'preparing' && (
              <button type="button" onClick={() => void act('ready', o.ulid)}>
                Mark ready
              </button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

function LoginForm({
  onLogin,
  error,
}: {
  onLogin: (email: string, password: string) => void;
  error: string | null;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onLogin(email, password);
      }}
    >
      <h1>Merchant sign in</h1>
      {error && <p role="alert">{error}</p>}
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email"
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
        />
      </label>
      <button type="submit">Sign in</button>
    </form>
  );
}
