/**
 * Menu management (the merchant's own catalogue). Reads GET /merchant/catalogue (all products incl.
 * unavailable, each with its optimistic-lock `version`) and drives the create/edit/availability/
 * inventory/option endpoints. Every mutation re-fetches the catalogue so the board is canonical and
 * versions stay fresh; a stale-version edit (409 VERSION_CONFLICT) surfaces an error and reloads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ApiClient,
  type ManagedCategory,
  type ManagedProduct,
  type MerchantCatalogue,
} from './api';
import { formatKes, parseKesToCents } from './format';
import { Badge, Button, Drawer, EmptyState, Field, Modal, Spinner, Switch } from './ui';

export function MenuView({ api, token }: { api: ApiClient; token: string }): JSX.Element {
  const [catalogue, setCatalogue] = useState<MerchantCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [editingUlid, setEditingUlid] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setCatalogue(await api.getCatalogue(token));
  }, [api, token]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setError('Failed to load the menu.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  async function toggleAvailability(p: ManagedProduct): Promise<void> {
    await api.setProductAvailability(token, p.ulid, !p.isAvailable);
    await refresh();
  }

  if (loading) {
    return <Spinner />;
  }
  if (error || !catalogue) {
    return (
      <div className="card">
        <EmptyState>{error ?? "Couldn't load the menu."}</EmptyState>
      </div>
    );
  }

  const editing = catalogue.products.find((p) => p.ulid === editingUlid) ?? null;
  const categories = [...catalogue.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const byCategory = (ulid: string | null) =>
    catalogue.products.filter((p) => p.categoryUlid === ulid);

  return (
    <>
      <div className="menu-head">
        <h2 className="menu-head__title">Menu</h2>
        <div className="menu-head__actions">
          <Button variant="ghost" small onClick={() => setCreatingCategory(true)}>
            New category
          </Button>
          <Button variant="primary" small onClick={() => setCreatingProduct(true)}>
            New product
          </Button>
        </div>
      </div>

      {catalogue.products.length === 0 && (
        <div className="card">
          <EmptyState>No products yet. Add your first product to get started.</EmptyState>
        </div>
      )}

      {categories.map((cat) => (
        <CategorySection
          key={cat.ulid}
          title={cat.name}
          products={byCategory(cat.ulid)}
          onEdit={setEditingUlid}
          onToggle={toggleAvailability}
        />
      ))}
      <CategorySection
        title="Uncategorised"
        products={byCategory(null)}
        onEdit={setEditingUlid}
        onToggle={toggleAvailability}
      />

      {creatingCategory && (
        <CreateCategoryModal
          api={api}
          token={token}
          onClose={() => setCreatingCategory(false)}
          onDone={async () => {
            await refresh();
            setCreatingCategory(false);
          }}
        />
      )}
      {creatingProduct && (
        <CreateProductModal
          api={api}
          token={token}
          categories={categories}
          onClose={() => setCreatingProduct(false)}
          onDone={async () => {
            await refresh();
            setCreatingProduct(false);
          }}
        />
      )}
      {editing && (
        <ProductEditor
          api={api}
          token={token}
          product={editing}
          categories={categories}
          onClose={() => setEditingUlid(null)}
          onChanged={refresh}
        />
      )}
    </>
  );
}

function CategorySection({
  title,
  products,
  onEdit,
  onToggle,
}: {
  title: string;
  products: ManagedProduct[];
  onEdit: (ulid: string) => void;
  onToggle: (p: ManagedProduct) => void;
}): JSX.Element | null {
  if (products.length === 0) {
    return null;
  }
  return (
    <section className="menu-cat" aria-label={title}>
      <h3 className="menu-cat__title">{title}</h3>
      {products.map((p) => (
        <ProductRow key={p.ulid} product={p} onEdit={onEdit} onToggle={onToggle} />
      ))}
    </section>
  );
}

function ProductRow({
  product,
  onEdit,
  onToggle,
}: {
  product: ManagedProduct;
  onEdit: (ulid: string) => void;
  onToggle: (p: ManagedProduct) => void;
}): JSX.Element {
  const meta: string[] = [formatKes(product.priceCents)];
  if (product.inventory?.trackStock) {
    meta.push(`${product.inventory.quantity - product.inventory.reserved} in stock`);
  }
  if (product.optionGroups.length > 0) {
    meta.push(`${product.optionGroups.length} option group(s)`);
  }
  return (
    <div className={`product-row${product.isAvailable ? '' : ' product-row--off'}`}>
      <div className="product-row__main">
        <div className="product-row__name">{product.name}</div>
        <div className="product-row__meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      </div>
      <div className="product-row__side">
        <Switch
          checked={product.isAvailable}
          onChange={() => onToggle(product)}
          label={`Toggle availability of ${product.name}`}
        />
        <Button variant="ghost" small onClick={() => onEdit(product.ulid)}>
          Edit
        </Button>
      </div>
    </div>
  );
}

/** Translate a thrown error into a friendly line (409 version conflicts get a reload hint). */
function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VERSION_CONFLICT') {
      return 'This product changed elsewhere — reloaded with the latest. Re-apply your edit.';
    }
    if (err.status === 422) {
      return err.message || 'Please check the values and try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}

function CreateCategoryModal({
  api,
  token,
  onClose,
  onDone,
}: {
  api: ApiClient;
  token: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api.createCategory(token, { name: name.trim() });
      await onDone();
    } catch (e) {
      setErr(messageFor(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New category"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={busy || name.trim().length === 0}
          onClick={() => void submit()}
        >
          Create category
        </Button>
      }
    >
      {err && <p className="field-error">{err}</p>}
      <Field label="Name" value={name} onChange={setName} placeholder="e.g. Mains" autoFocus />
    </Modal>
  );
}

function CreateProductModal({
  api,
  token,
  categories,
  onClose,
  onDone,
}: {
  api: ApiClient;
  token: string;
  categories: ManagedCategory[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryUlid, setCategoryUlid] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const cents = parseKesToCents(price);
    if (cents === null) {
      setErr('Enter a valid price.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createProduct(token, {
        name: name.trim(),
        priceCents: cents,
        ...(categoryUlid ? { categoryUlid } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      await onDone();
    } catch (e) {
      setErr(messageFor(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New product"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={busy || name.trim().length === 0 || price.trim().length === 0}
          onClick={() => void submit()}
        >
          Create product
        </Button>
      }
    >
      {err && <p className="field-error">{err}</p>}
      <Field
        label="Name"
        value={name}
        onChange={setName}
        placeholder="e.g. Beef Burger"
        autoFocus
      />
      <Field label="Price (KES)" value={price} onChange={setPrice} placeholder="e.g. 550" />
      <label className="field">
        <span className="field__label">Category</span>
        <select
          className="input"
          aria-label="Category"
          value={categoryUlid}
          onChange={(e) => setCategoryUlid(e.target.value)}
        >
          <option value="">Uncategorised</option>
          {categories.map((c) => (
            <option key={c.ulid} value={c.ulid}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <Field label="Description" value={description} onChange={setDescription} />
    </Modal>
  );
}

function ProductEditor({
  api,
  token,
  product,
  categories,
  onClose,
  onChanged,
}: {
  api: ApiClient;
  token: string;
  product: ManagedProduct;
  categories: ManagedCategory[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(product.name);
  const [price, setPrice] = useState((product.priceCents / 100).toString());
  const [categoryUlid, setCategoryUlid] = useState(product.categoryUlid ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Keep the form in sync with the latest version after an external refresh.
  const lastVersion = useRef(product.version);
  useEffect(() => {
    if (product.version !== lastVersion.current) {
      lastVersion.current = product.version;
      setName(product.name);
      setPrice((product.priceCents / 100).toString());
      setCategoryUlid(product.categoryUlid ?? '');
      setDescription(product.description ?? '');
    }
  }, [product]);

  async function run(fn: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await fn();
      await onChanged();
      setOk(success);
    } catch (e) {
      setErr(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  function saveDetails(): void {
    const cents = parseKesToCents(price);
    if (cents === null) {
      setErr('Enter a valid price.');
      return;
    }
    void run(
      () =>
        api.editProduct(token, product.ulid, {
          expectedVersion: product.version,
          name: name.trim(),
          priceCents: cents,
          description: description.trim() ? description.trim() : null,
          ...(categoryUlid ? { categoryUlid } : {}),
        }),
      'Saved',
    );
  }

  return (
    <Drawer
      title={product.name}
      subtitle={
        <Badge tone={product.isAvailable ? 'ok' : 'off'}>
          {product.isAvailable ? 'Available' : 'Hidden'}
        </Badge>
      }
      onClose={onClose}
    >
      {err && <p className="field-error">{err}</p>}
      {ok && (
        <p className="field-error" style={{ color: 'var(--green-dark)' }} role="status">
          {ok}
        </p>
      )}

      <p className="section-label">Details</p>
      <Field label="Name" value={name} onChange={setName} />
      <Field label="Price (KES)" value={price} onChange={setPrice} />
      <label className="field">
        <span className="field__label">Category</span>
        <select
          className="input"
          aria-label="Category"
          value={categoryUlid}
          onChange={(e) => setCategoryUlid(e.target.value)}
        >
          <option value="">Uncategorised</option>
          {categories.map((c) => (
            <option key={c.ulid} value={c.ulid}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <Field label="Description" value={description} onChange={setDescription} />
      <Button variant="primary" disabled={busy} onClick={saveDetails}>
        Save details
      </Button>

      <div style={{ height: 24 }} />
      <InventoryEditor product={product} busy={busy} onSave={run} api={api} token={token} />

      <div style={{ height: 24 }} />
      <OptionGroups product={product} busy={busy} onRun={run} api={api} token={token} />
    </Drawer>
  );
}

function InventoryEditor({
  product,
  busy,
  onSave,
  api,
  token,
}: {
  product: ManagedProduct;
  busy: boolean;
  onSave: (fn: () => Promise<unknown>, success: string) => Promise<void>;
  api: ApiClient;
  token: string;
}): JSX.Element {
  const [trackStock, setTrackStock] = useState(product.inventory?.trackStock ?? false);
  const [quantity, setQuantity] = useState((product.inventory?.quantity ?? 0).toString());

  return (
    <>
      <p className="section-label">Inventory</p>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <span>Track stock</span>
        <Switch checked={trackStock} onChange={setTrackStock} label="Track stock" />
      </div>
      {trackStock && <Field label="Quantity" value={quantity} onChange={setQuantity} />}
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() =>
          void onSave(
            () =>
              api.setInventory(token, product.ulid, {
                trackStock,
                quantity: Math.max(0, Math.floor(Number(quantity) || 0)),
              }),
            'Inventory saved',
          )
        }
      >
        Save inventory
      </Button>
    </>
  );
}

function OptionGroups({
  product,
  busy,
  onRun,
  api,
  token,
}: {
  product: ManagedProduct;
  busy: boolean;
  onRun: (fn: () => Promise<unknown>, success: string) => Promise<void>;
  api: ApiClient;
  token: string;
}): JSX.Element {
  const [groupName, setGroupName] = useState('');

  return (
    <>
      <p className="section-label">Option groups</p>
      {product.optionGroups.map((g) => (
        <div className="og" key={g.ulid}>
          <div className="og__head">
            <span>{g.name}</span>
            <span className="order-card__age">
              choose {g.minSelect}–{g.maxSelect}
            </span>
          </div>
          {g.options.map((o) => (
            <div className="og__opt" key={o.ulid}>
              <span>
                {o.name}
                {o.priceDeltaCents > 0 ? ` · +${formatKes(o.priceDeltaCents)}` : ''}
              </span>
              <Switch
                checked={o.isAvailable}
                label={`Toggle ${o.name}`}
                onChange={(v) =>
                  void onRun(() => api.setOptionAvailability(token, o.ulid, v), 'Updated')
                }
              />
            </div>
          ))}
          <AddOption groupUlid={g.ulid} busy={busy} onRun={onRun} api={api} token={token} />
        </div>
      ))}
      <div className="inline-form">
        <input
          className="input"
          aria-label="New option group name"
          placeholder="New group (e.g. Size)"
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
        />
        <Button
          variant="ghost"
          small
          disabled={busy || groupName.trim().length === 0}
          onClick={() =>
            void onRun(
              () =>
                api.addOptionGroup(token, product.ulid, {
                  name: groupName.trim(),
                  minSelect: 0,
                  maxSelect: 1,
                }),
              'Group added',
            ).then(() => setGroupName(''))
          }
        >
          Add group
        </Button>
      </div>
    </>
  );
}

function AddOption({
  groupUlid,
  busy,
  onRun,
  api,
  token,
}: {
  groupUlid: string;
  busy: boolean;
  onRun: (fn: () => Promise<unknown>, success: string) => Promise<void>;
  api: ApiClient;
  token: string;
}): JSX.Element {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');

  return (
    <div className="inline-form" style={{ marginTop: 10, marginBottom: 0 }}>
      <input
        className="input"
        aria-label={`New option for group`}
        placeholder="Option (e.g. Large)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="input"
        aria-label="Option price delta (KES)"
        placeholder="+KES"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        style={{ maxWidth: 90 }}
      />
      <Button
        variant="ghost"
        small
        disabled={busy || name.trim().length === 0}
        onClick={() =>
          void onRun(
            () =>
              api.addOption(token, groupUlid, {
                name: name.trim(),
                priceDeltaCents: parseKesToCents(price) ?? 0,
              }),
            'Option added',
          ).then(() => {
            setName('');
            setPrice('');
          })
        }
      >
        Add
      </Button>
    </div>
  );
}
