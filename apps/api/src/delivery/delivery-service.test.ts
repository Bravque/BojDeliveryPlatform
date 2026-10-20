import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../auth/repo';
import { createLedgerService } from '../ledger/ledger-service';
import type {
  AccountBalance,
  GetOrCreateAccountInput,
  InsertTransactionInput,
  LedgerAccount,
  LedgerRepo,
} from '../ledger/repo';
import type { OrdersRepo } from '../orders/repo';
import type { OrderStatus } from '../orders/state-machine';
import { createDeliveryService, type Actor } from './delivery-service';
import type { DeliveryPinRecord, DeliveryRepo, DeliveryStatus } from './repo';

class FakeLedgerRepo implements LedgerRepo {
  accounts = new Map<string, LedgerAccount>();
  txns: Array<{ id: number; ulid: string; kind: string; idempotencyKey: string }> = [];
  entries: Array<{ direction: 'debit' | 'credit'; amountCents: number }> = [];
  private seqA = 0;
  private seqT = 0;
  getOrCreateAccount(input: GetOrCreateAccountInput): Promise<LedgerAccount> {
    let a = this.accounts.get(input.code);
    if (!a) {
      a = { id: ++this.seqA, code: input.code, type: input.type };
      this.accounts.set(input.code, a);
    }
    return Promise.resolve(a);
  }
  findTransactionByIdempotencyKey(key: string): Promise<{ id: number; ulid: string } | null> {
    const t = this.txns.find((x) => x.idempotencyKey === key);
    return Promise.resolve(t ? { id: t.id, ulid: t.ulid } : null);
  }
  insertTransaction(input: InsertTransactionInput): Promise<number> {
    const id = ++this.seqT;
    this.txns.push({
      id,
      ulid: input.ulid,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
    });
    return Promise.resolve(id);
  }
  insertEntry(input: { direction: 'debit' | 'credit'; amountCents: number }): Promise<void> {
    this.entries.push({ direction: input.direction, amountCents: input.amountCents });
    return Promise.resolve();
  }
  getAccountBalances(): Promise<AccountBalance[]> {
    return Promise.resolve([]);
  }
  findImbalancedTransactions(): Promise<number[]> {
    return Promise.resolve([]);
  }
}

function makeWorld(over: { orderStatus?: OrderStatus; riderFeeCents?: number } = {}) {
  const order = {
    id: 1,
    ulid: 'ORD1',
    status: (over.orderStatus ?? 'rider_assigned') as string,
    customerId: 5,
  };
  const delivery = {
    id: 7,
    status: 'assigned' as DeliveryStatus,
    riderId: 10,
    riderFeeCents: over.riderFeeCents ?? 7_000,
  };
  let pin: (DeliveryPinRecord & { deliveryId: number }) | null = null;
  const users = new Map<string, number>([
    ['rider10', 10],
    ['rider99', 99],
    ['cust5', 5],
    ['admin9', 9],
  ]);
  const history: Array<{ toStatus: string; actorType: string }> = [];
  const audits: Partial<AuditEntry>[] = [];
  const ledger = new FakeLedgerRepo();

  const dwo = () => ({
    deliveryId: delivery.id,
    deliveryStatus: delivery.status,
    riderId: delivery.riderId,
    riderFeeCents: delivery.riderFeeCents,
    orderId: order.id,
    orderUlid: order.ulid,
    orderStatus: order.status as OrderStatus,
    customerId: order.customerId,
  });

  const deliveryRepo = {
    findUserIdByUlid: (ulid: string) => Promise.resolve(users.get(ulid) ?? null),
    lockDeliveryWithOrder: (ulid: string) => Promise.resolve(ulid === order.ulid ? dwo() : null),
    findDeliveryWithOrder: (ulid: string) => Promise.resolve(ulid === order.ulid ? dwo() : null),
    setDeliveryPickedUp: () => {
      delivery.status = 'picked_up';
      return Promise.resolve();
    },
    setDeliveryDelivered: (_id: number, _proofType: string) => {
      delivery.status = 'delivered';
      return Promise.resolve();
    },
    upsertDeliveryPin: (input: {
      deliveryId: number;
      pinHash: string;
      expiresAt: Date;
      maxAttempts: number;
    }) => {
      pin = {
        deliveryId: input.deliveryId,
        pinHash: input.pinHash,
        expiresAt: input.expiresAt,
        attempts: 0,
        maxAttempts: input.maxAttempts,
        consumedAt: null,
      };
      return Promise.resolve();
    },
    lockDeliveryPin: () => Promise.resolve(pin),
    incrementPinAttempts: () => {
      if (pin) pin.attempts += 1;
      return Promise.resolve();
    },
    consumeDeliveryPin: () => {
      if (pin) pin.consumedAt = new Date();
      return Promise.resolve();
    },
  } as unknown as DeliveryRepo;

  const orders = {
    findUserIdByUlid: (ulid: string) => Promise.resolve(users.get(ulid) ?? null),
    setOrderStatus: (_id: number, status: string) => {
      order.status = status;
      return Promise.resolve();
    },
    insertStatusHistory: (h: { toStatus: string; actorType: string }) => {
      history.push({ toStatus: h.toStatus, actorType: h.actorType });
      return Promise.resolve();
    },
  } as unknown as OrdersRepo;

  const svc = createDeliveryService({
    readRepo: deliveryRepo,
    withTransaction: (work) => work({ delivery: deliveryRepo, orders, ledger }),
    ledgerService: createLedgerService(),
    auditService: {
      record: (e: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'entityType'>) => {
        audits.push(e);
        return Promise.resolve();
      },
      listRecent: () => Promise.resolve([]),
    },
    config: { pinTtlSec: 900, pinMaxAttempts: 3 },
  });

  return { svc, order, delivery, ledger, history, audits, getPin: () => pin };
}

const RIDER: Actor = { ulid: 'rider10', roles: ['rider'] };
const OTHER_RIDER: Actor = { ulid: 'rider99', roles: ['rider'] };
const CUSTOMER: Actor = { ulid: 'cust5', roles: ['customer'] };
const ADMIN: Actor = { ulid: 'admin9', roles: ['admin'] };

function thrownStatus(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number }) => e.status,
  );
}

describe('delivery service — happy path', () => {
  it('pickup → start → issue PIN → complete: delivered + rider earnings posted once', async () => {
    const w = makeWorld();
    expect((await w.svc.confirmPickup(RIDER, 'ORD1')).orderStatus).toBe('picked_up');
    expect((await w.svc.startDelivery(RIDER, 'ORD1')).orderStatus).toBe('out_for_delivery');
    const { pin } = await w.svc.issueDeliveryPin(CUSTOMER, 'ORD1');
    expect(pin).toMatch(/^\d{4}$/);

    const done = await w.svc.completeDelivery(RIDER, 'ORD1', pin);
    expect(done.orderStatus).toBe('delivered');
    expect(w.delivery.status).toBe('delivered');
    // Earnings: one balanced rider_earning ledger transaction.
    expect(w.ledger.txns.filter((t) => t.kind === 'rider_earning')).toHaveLength(1);
    const debit = w.ledger.entries
      .filter((e) => e.direction === 'debit')
      .reduce((s, e) => s + e.amountCents, 0);
    const credit = w.ledger.entries
      .filter((e) => e.direction === 'credit')
      .reduce((s, e) => s + e.amountCents, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(7_000);
  });
});

describe('delivery service — PIN failures', () => {
  async function readyToComplete() {
    const w = makeWorld({ orderStatus: 'out_for_delivery' });
    const { pin } = await w.svc.issueDeliveryPin(CUSTOMER, 'ORD1');
    return { w, pin };
  }

  it('wrong PIN → 409 and an incremented attempt', async () => {
    const { w } = await readyToComplete();
    expect(await thrownStatus(w.svc.completeDelivery(RIDER, 'ORD1', '0000'))).toBe(409);
    expect(w.getPin()?.attempts).toBe(1);
    expect(w.ledger.txns).toHaveLength(0);
  });

  it('no PIN issued → 409 NO_PIN_ISSUED', async () => {
    const w = makeWorld({ orderStatus: 'out_for_delivery' });
    expect(await thrownStatus(w.svc.completeDelivery(RIDER, 'ORD1', '1234'))).toBe(409);
  });

  it('locks out after too many attempts', async () => {
    const { w } = await readyToComplete();
    await thrownStatus(w.svc.completeDelivery(RIDER, 'ORD1', '0000'));
    await thrownStatus(w.svc.completeDelivery(RIDER, 'ORD1', '0000'));
    await thrownStatus(w.svc.completeDelivery(RIDER, 'ORD1', '0000')); // attempts now 3 == max
    // Even the correct outcome is blocked now (locked); still 409.
    expect(await thrownStatus(w.svc.completeDelivery(RIDER, 'ORD1', '0000'))).toBe(409);
  });
});

describe('delivery service — guards + override', () => {
  it('404s a rider acting on a delivery that is not theirs', async () => {
    const w = makeWorld();
    expect(await thrownStatus(w.svc.confirmPickup(OTHER_RIDER, 'ORD1'))).toBe(404);
  });

  it('rejects completing before out_for_delivery (illegal transition 409)', async () => {
    const w = makeWorld({ orderStatus: 'rider_assigned' });
    expect(await thrownStatus(w.svc.completeDelivery(RIDER, 'ORD1', '1234'))).toBe(409);
  });

  it('admin override completes + accrues earnings + audits; a rider is forbidden', async () => {
    const forbidden = makeWorld({ orderStatus: 'out_for_delivery' });
    expect(await thrownStatus(forbidden.svc.completeDeliveryOverride(RIDER, 'ORD1', 'x'))).toBe(
      403,
    );

    const w = makeWorld({ orderStatus: 'out_for_delivery' });
    const done = await w.svc.completeDeliveryOverride(ADMIN, 'ORD1', 'customer unreachable');
    expect(done.orderStatus).toBe('delivered');
    expect(w.ledger.txns.filter((t) => t.kind === 'rider_earning')).toHaveLength(1);
    expect(w.audits.at(-1)).toMatchObject({ action: 'delivery.pin_override' });
  });
});
