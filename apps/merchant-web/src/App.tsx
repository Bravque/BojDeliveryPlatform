import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, MerchantOrderDetail, MerchantOrders } from './api';
import type { ConnectMerchantSocket, SocketHandle } from './socket';
import { clearToken, loadToken, saveToken } from './session';
import { OrderDrawer, OrdersBoard, type OrderAction } from './orders';
import { MenuView } from './menu';
import { Brand, Button, EmptyState, Field, Spinner, Toast } from './ui';

export interface AppProps {
  api: ApiClient;
  connectSocket: ConnectMerchantSocket;
}

type View = 'orders' | 'menu' | 'store' | 'earnings';

const NAV: { key: View; label: string; icon: string }[] = [
  { key: 'orders', label: 'Orders', icon: '🧾' },
  { key: 'menu', label: 'Menu', icon: '🍽️' },
  { key: 'store', label: 'Store', icon: '🏪' },
  { key: 'earnings', label: 'Earnings', icon: '💰' },
];

/**
 * Merchant dashboard. The socket only nudges — every realtime event triggers a REST re-fetch, so the
 * board is always canonical. The access token is persisted to localStorage so a reload keeps the
 * session (restored by re-fetching orders; a 401 clears it). Menu/Store/Earnings are placeholders
 * until their increments land.
 */
export function App({ api, connectSocket }: AppProps): JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<MerchantOrders | null>(null);
  const [view, setView] = useState<View>('orders');
  const [booting, setBooting] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MerchantOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [realtime, setRealtime] = useState(false);

  const socketRef = useRef<SocketHandle | null>(null);
  const selectedRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(
    async (tok: string) => {
      setData(await api.listMerchantOrders(tok));
    },
    [api],
  );

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const openOrder = useCallback(
    async (ulid: string, tok: string) => {
      selectedRef.current = ulid;
      setSelected(ulid);
      setDetailLoading(true);
      try {
        setDetail(await api.getMerchantOrder(tok, ulid));
      } finally {
        setDetailLoading(false);
      }
    },
    [api],
  );

  // Restore a persisted session on load: a stored token that still lists orders means we're in.
  useEffect(() => {
    const stored = loadToken();
    if (!stored) {
      setBooting(false);
      return;
    }
    (async () => {
      try {
        setData(await api.listMerchantOrders(stored));
        setToken(stored);
      } catch {
        clearToken();
      } finally {
        setBooting(false);
      }
    })();
  }, [api]);

  // Subscribe to the merchant room once logged in; every nudge re-fetches the board (+ open order).
  // Keyed on the merchant ulid (not the whole order list) so a routine re-fetch doesn't reconnect.
  const merchantUlid = data?.merchant.ulid ?? null;
  useEffect(() => {
    if (!token || !merchantUlid || socketRef.current) {
      return;
    }
    socketRef.current = connectSocket(token, merchantUlid, () => {
      flashToast('New order activity');
      void refresh(token);
      if (selectedRef.current) {
        void openOrder(selectedRef.current, token);
      }
    });
    setRealtime(true);
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
      setRealtime(false);
    };
  }, [token, merchantUlid, connectSocket, refresh, flashToast, openOrder]);

  async function onLogin(email: string, password: string): Promise<void> {
    setLoginError(null);
    try {
      const { access } = await api.login(email, password);
      await refresh(access);
      saveToken(access);
      setToken(access);
    } catch {
      setLoginError('Login failed. Check your email and password.');
    }
  }

  function onLogout(): void {
    socketRef.current?.close();
    socketRef.current = null;
    clearToken();
    setToken(null);
    setData(null);
    closeDrawer();
    setView('orders');
  }

  function closeDrawer(): void {
    selectedRef.current = null;
    setSelected(null);
    setDetail(null);
  }

  async function runAction(action: OrderAction, reason?: string): Promise<void> {
    if (!token || !selected) {
      return;
    }
    setBusy(true);
    try {
      if (action === 'accept') await api.acceptOrder(token, selected);
      else if (action === 'preparing') await api.startPreparing(token, selected);
      else if (action === 'ready') await api.markReady(token, selected);
      else await api.rejectOrder(token, selected, reason ?? '');
      await refresh(token);
      await openOrder(selected, token);
    } finally {
      setBusy(false);
    }
  }

  if (booting) {
    return <Spinner />;
  }

  if (!token || !data) {
    return <LoginForm onLogin={onLogin} error={loginError} />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <nav className="nav" aria-label="Sections">
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`nav__item${view === n.key ? ' nav__item--active' : ''}`}
              aria-current={view === n.key ? 'page' : undefined}
              onClick={() => setView(n.key)}
            >
              <span className="nav__icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1 className="topbar__title">{data.merchant.name}</h1>
          <div className="topbar__spacer" />
          <span className={`dot${realtime ? ' dot--on' : ' dot--off'}`}>Realtime</span>
          <Button variant="ghost" small onClick={onLogout}>
            Log out
          </Button>
        </header>

        <main className="content">
          {view === 'orders' && (
            <OrdersBoard orders={data.orders} onOpen={(ulid) => void openOrder(ulid, token)} />
          )}
          {view === 'menu' && <MenuView api={api} token={token} />}
          {(view === 'store' || view === 'earnings') && <Placeholder view={view} />}
        </main>
      </div>

      {selected && (
        <OrderDrawer
          detail={detail}
          loading={detailLoading}
          busy={busy}
          onClose={closeDrawer}
          onAction={(action, reason) => void runAction(action, reason)}
        />
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}

function Placeholder({ view }: { view: View }): JSX.Element {
  const copy: Record<string, string> = {
    store: 'Store settings are coming soon — open/close your store and set prep time.',
    earnings: 'Earnings & settlements are coming soon.',
  };
  return (
    <div className="card">
      <EmptyState>{copy[view]}</EmptyState>
    </div>
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
    <div className="login">
      <form
        className="login__card"
        onSubmit={(e) => {
          e.preventDefault();
          onLogin(email, password);
        }}
      >
        <Brand />
        <h1 className="login__title">Merchant sign in</h1>
        <p className="login__sub">Manage your orders and menu.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Field label="Email" type="email" value={email} onChange={setEmail} autoFocus />
        <Field label="Password" type="password" value={password} onChange={setPassword} />
        <Button variant="primary" block type="submit">
          Sign in
        </Button>
      </form>
    </div>
  );
}
