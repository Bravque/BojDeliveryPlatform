/**
 * Shared Daraja wire-format helpers used by both the STK adapter and the B2C/reversal adapters.
 * M-Pesa amounts are whole KES shillings; our ledger is integer cents. MSISDNs are digits only.
 */

/** Convert integer cents to whole KES shillings, rejecting any non-whole-shilling amount. */
export function toShillings(amountCents: number): number {
  if (amountCents % 100 !== 0) {
    throw new Error(
      `Amount ${amountCents} cents is not a whole KES shilling; M-Pesa amounts must be whole shillings`,
    );
  }
  return amountCents / 100;
}

/** Normalise a stored phone to an M-Pesa MSISDN (digits only, e.g. 2547XXXXXXXX). */
export function toMsisdn(phone: string | null): string {
  if (!phone) {
    throw new Error('M-Pesa request requires a phone number (MSISDN)');
  }
  return phone.replace(/[^0-9]/g, '');
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Daraja timestamp format `YYYYMMDDHHmmss`. */
export function darajaTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
