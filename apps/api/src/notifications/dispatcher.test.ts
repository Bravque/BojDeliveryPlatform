import { describe, expect, it } from 'vitest';
import { MockSmsProvider } from '../auth/sms/mock';
import { createNotificationDispatcher } from './dispatcher';
import { MockPushProvider } from './mock-push';
import type { NotificationsRepo, NotifyTarget } from './repo';

interface World {
  customer: NotifyTarget | null;
  staff: NotifyTarget[];
  devices: Map<number, string[]>;
  records: Array<{ userId: number; channel: string; kind: string; status: string }>;
}

function makeDispatcher(world: Partial<World> = {}) {
  const state: World = {
    customer: world.customer ?? null,
    staff: world.staff ?? [],
    devices: world.devices ?? new Map(),
    records: [],
  };
  const repo = {
    devicesForUser: (userId: number) => Promise.resolve(state.devices.get(userId) ?? []),
    customerTarget: () => Promise.resolve(state.customer),
    merchantStaffTargets: () => Promise.resolve(state.staff),
    recordNotification: (input: {
      userId: number;
      channel: string;
      kind: string;
      status: string;
    }) => {
      state.records.push(input);
      return Promise.resolve();
    },
  } as unknown as NotificationsRepo;
  const push = new MockPushProvider();
  const sms = new MockSmsProvider();
  const dispatcher = createNotificationDispatcher({
    repo,
    push,
    sms,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  return { dispatcher, push, sms, records: state.records };
}

describe('notification dispatcher', () => {
  it('pushes a new-order alert to merchant staff who have a device', async () => {
    const d = makeDispatcher({
      staff: [{ userId: 5, phone: '+254700000001' }],
      devices: new Map([[5, ['tok-5']]]),
    });
    await d.dispatcher.handle('ORD1', 'placed');
    expect(d.push.sent).toHaveLength(1);
    expect(d.push.sent[0]).toMatchObject({ token: 'tok-5' });
    expect(d.records).toEqual([{ userId: 5, channel: 'push', kind: 'order.new', status: 'sent' }]);
  });

  it('falls back to SMS when the recipient has no device', async () => {
    const d = makeDispatcher({ staff: [{ userId: 5, phone: '+254700000001' }] });
    await d.dispatcher.handle('ORD1', 'placed');
    expect(d.push.sent).toHaveLength(0);
    expect(d.sms.sent).toHaveLength(1);
    expect(d.sms.sent[0]?.to).toBe('+254700000001');
    expect(d.records[0]).toMatchObject({ channel: 'sms', kind: 'order.new' });
  });

  it('notifies the customer on rider_assigned and delivered', async () => {
    const d = makeDispatcher({
      customer: { userId: 9, phone: '+254700000002' },
      devices: new Map([[9, ['tok-9']]]),
    });
    await d.dispatcher.handle('ORD1', 'rider_assigned');
    await d.dispatcher.handle('ORD1', 'delivered');
    expect(d.push.sent).toHaveLength(2);
    expect(d.records.map((r) => r.kind)).toEqual(['rider.assigned', 'order.delivered']);
  });

  it('does nothing for a status without a notification mapping', async () => {
    const d = makeDispatcher({ customer: { userId: 9, phone: '+254700000002' } });
    await d.dispatcher.handle('ORD1', 'preparing');
    expect(d.push.sent).toHaveLength(0);
    expect(d.sms.sent).toHaveLength(0);
    expect(d.records).toHaveLength(0);
  });

  it('records nothing when the recipient has neither a device nor a phone', async () => {
    const d = makeDispatcher({ customer: { userId: 9, phone: null } });
    await d.dispatcher.handle('ORD1', 'delivered');
    expect(d.records).toHaveLength(0);
  });
});
