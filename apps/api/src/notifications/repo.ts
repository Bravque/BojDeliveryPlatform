import type { Knex } from 'knex';

/**
 * Persistence for notifications: device (push-token) registration, the recipients/devices a given
 * order's notifications target, and the dispatch record. Executor-bound like the other repos.
 */

export type DevicePlatform = 'ios' | 'android' | 'web';
export type NotificationChannel = 'push' | 'sms';
export type NotificationStatus = 'sent' | 'failed' | 'skipped';

/** A person to notify about an order + their SMS fallback number. */
export interface NotifyTarget {
  userId: number;
  phone: string | null;
}

export interface NotificationsRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  upsertDevice(userId: number, pushToken: string, platform: DevicePlatform): Promise<void>;
  devicesForUser(userId: number): Promise<string[]>;
  /** The order's customer (with phone), or null if the order is unknown. */
  customerTarget(orderUlid: string): Promise<NotifyTarget | null>;
  /** The staff (owner + staff) of the order's merchant, with phones. */
  merchantStaffTargets(orderUlid: string): Promise<NotifyTarget[]>;
  recordNotification(input: {
    userId: number;
    channel: NotificationChannel;
    kind: string;
    status: NotificationStatus;
  }): Promise<void>;
}

export function createKnexNotificationsRepo(exec: Knex): NotificationsRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await exec('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async upsertDevice(userId, pushToken, platform) {
      await exec('device')
        .insert({ user_id: userId, push_token: pushToken, platform })
        .onConflict('push_token')
        .merge({ user_id: userId, platform });
    },

    async devicesForUser(userId) {
      const rows = (await exec('device').where({ user_id: userId }).select('push_token')) as Array<{
        push_token: string;
      }>;
      return rows.map((r) => r.push_token);
    },

    async customerTarget(orderUlid) {
      const row = (await exec('order')
        .join('user', 'user.id', 'order.customer_id')
        .where('order.ulid', orderUlid)
        .first('user.id as user_id', 'user.phone_e164 as phone')) as
        { user_id: number | string; phone: string | null } | undefined;
      return row ? { userId: Number(row.user_id), phone: row.phone } : null;
    },

    async merchantStaffTargets(orderUlid) {
      const rows = (await exec('order')
        .join('merchant_user', 'merchant_user.merchant_id', 'order.merchant_id')
        .join('user', 'user.id', 'merchant_user.user_id')
        .where('order.ulid', orderUlid)
        .select('user.id as user_id', 'user.phone_e164 as phone')) as Array<{
        user_id: number | string;
        phone: string | null;
      }>;
      return rows.map((r) => ({ userId: Number(r.user_id), phone: r.phone }));
    },

    async recordNotification(input) {
      await exec('notification').insert({
        user_id: input.userId,
        channel: input.channel,
        kind: input.kind,
        status: input.status,
      });
    },
  };
}
