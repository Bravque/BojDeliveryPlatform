import type { Knex } from 'knex';
import type { OrderParticipants, RealtimeResolver } from './authorize';

/**
 * Knex-backed room-authorization lookups. Reads the participant ulids for an order (customer,
 * merchant, assigned rider) and a merchant's staff ulids — the data the RBAC check compares against
 * the connected principal.
 */
export function createKnexRealtimeResolver(db: Knex): RealtimeResolver {
  return {
    async orderParticipants(orderUlid) {
      const row = (await db('order')
        .join('user as cu', 'cu.id', 'order.customer_id')
        .join('merchant as m', 'm.id', 'order.merchant_id')
        .leftJoin('delivery as d', 'd.order_id', 'order.id')
        .leftJoin('user as ru', 'ru.id', 'd.rider_id')
        .where('order.ulid', orderUlid)
        .first('cu.ulid as customer_ulid', 'm.ulid as merchant_ulid', 'ru.ulid as rider_ulid')) as
        { customer_ulid: string; merchant_ulid: string; rider_ulid: string | null } | undefined;
      if (!row) {
        return null;
      }
      const participants: OrderParticipants = {
        customerUlid: row.customer_ulid,
        merchantUlid: row.merchant_ulid,
        riderUlid: row.rider_ulid,
      };
      return participants;
    },

    async merchantStaffUlids(merchantUlid) {
      const rows = (await db('merchant_user')
        .join('user', 'user.id', 'merchant_user.user_id')
        .join('merchant', 'merchant.id', 'merchant_user.merchant_id')
        .where('merchant.ulid', merchantUlid)
        .select('user.ulid as ulid')) as Array<{ ulid: string }>;
      return rows.map((r) => r.ulid);
    },
  };
}
