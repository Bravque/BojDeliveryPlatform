/**
 * Chart of accounts (doc 07 §7). Platform accounts have fixed codes and are seeded; per-owner
 * payable accounts use a parameterised code and are created on demand by the ledger service.
 */

export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense';
export type OwnerType = 'platform' | 'merchant' | 'rider';

export interface AccountDef {
  code: string;
  type: AccountType;
}

/** Fixed platform accounts (owner_type = platform). */
export const PLATFORM_ACCOUNTS: readonly AccountDef[] = [
  { code: 'mpesa_clearing', type: 'asset' }, // funds received via M-Pesa, pre-settlement
  { code: 'platform_cash', type: 'asset' },
  { code: 'commission_revenue', type: 'revenue' },
  { code: 'platform_delivery_income', type: 'revenue' }, // reclassed to rider_payable on delivery (Phase 5)
  { code: 'platform_service_income', type: 'revenue' },
  { code: 'promo_expense', type: 'expense' }, // platform-funded promotions (D4)
  { code: 'refunds_payable', type: 'liability' },
];

export function merchantPayableCode(merchantId: number): string {
  return `merchant_payable:${merchantId}`;
}

export function riderPayableCode(riderId: number): string {
  return `rider_payable:${riderId}`;
}
