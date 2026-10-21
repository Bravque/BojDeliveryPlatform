import type { SmsProvider } from '../auth/sms/provider';
import type { DomainEventPublisher } from '../platform/events/publisher';
import type { Logger } from '../platform/logger';
import type { PushProvider } from './provider';
import type { NotificationsRepo, NotifyTarget } from './repo';

/**
 * Notification dispatcher (doc 02 §3). A `DomainEventPublisher` that, alongside realtime, fans an
 * order status change out as push/SMS to the right party: a new `placed` order alerts the merchant;
 * `rider_assigned` / `delivered` tell the customer. Prefers push (registered devices); falls back to
 * one SMS when the user has no device. Every send is recorded. Best-effort — invoked after commit.
 */
interface NotifySpec {
  audience: 'customer' | 'merchant';
  kind: string;
  title: string;
  body: string;
}

const STATUS_NOTIFICATIONS: Record<string, NotifySpec> = {
  placed: {
    audience: 'merchant',
    kind: 'order.new',
    title: 'New order',
    body: 'You have a new order to accept.',
  },
  rider_assigned: {
    audience: 'customer',
    kind: 'rider.assigned',
    title: 'Rider assigned',
    body: 'A rider is on the way to the merchant.',
  },
  delivered: {
    audience: 'customer',
    kind: 'order.delivered',
    title: 'Delivered',
    body: 'Your order has been delivered. Enjoy!',
  },
};

export interface NotificationDispatcherDeps {
  repo: NotificationsRepo;
  push: PushProvider;
  sms: SmsProvider;
  logger: Logger;
}

export interface NotificationDispatcher extends DomainEventPublisher {
  /** The awaitable dispatch (what `orderStatusChanged` fires-and-forgets). */
  handle(orderUlid: string, toStatus: string): Promise<void>;
}

export function createNotificationDispatcher(
  deps: NotificationDispatcherDeps,
): NotificationDispatcher {
  const { repo, push, sms, logger } = deps;

  async function notifyUser(target: NotifyTarget, spec: NotifySpec): Promise<void> {
    const tokens = await repo.devicesForUser(target.userId);
    if (tokens.length > 0) {
      for (const token of tokens) {
        await push.send({ token, title: spec.title, body: spec.body });
      }
      await repo.recordNotification({
        userId: target.userId,
        channel: 'push',
        kind: spec.kind,
        status: 'sent',
      });
      return;
    }
    if (target.phone) {
      await sms.send({ to: target.phone, body: `${spec.title}: ${spec.body}` });
      await repo.recordNotification({
        userId: target.userId,
        channel: 'sms',
        kind: spec.kind,
        status: 'sent',
      });
    }
    // No device and no phone → nothing to do.
  }

  async function handle(orderUlid: string, toStatus: string): Promise<void> {
    const spec = STATUS_NOTIFICATIONS[toStatus];
    if (!spec) {
      return;
    }
    let targets: NotifyTarget[];
    if (spec.audience === 'customer') {
      const customer = await repo.customerTarget(orderUlid);
      targets = customer ? [customer] : [];
    } else {
      targets = await repo.merchantStaffTargets(orderUlid);
    }
    for (const target of targets) {
      await notifyUser(target, spec);
    }
  }

  return {
    orderStatusChanged(orderUlid, toStatus) {
      handle(orderUlid, toStatus).catch((err: unknown) =>
        logger.warn({ err, orderUlid, toStatus }, 'notification dispatch failed'),
      );
    },
    handle,
  };
}
