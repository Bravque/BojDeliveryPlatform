import { describe, expect, it } from 'vitest';
import { SimulatedGateway } from './simulated-gateway';

const input = {
  orderNumber: 'BOJ-ABCDEF12',
  amountCents: 40_200,
  phone: '+254700000001',
  idempotencyKey: 'key-1',
};

describe('SimulatedGateway', () => {
  it('initiates with deterministic correlation ids', async () => {
    const res = await new SimulatedGateway().initiateStkPush(input);
    expect(res.checkoutRequestId).toMatch(/^SIM-/);
    expect(res.merchantRequestId).toMatch(/^SIMMR-/);
  });

  it('reports pending until an outcome is set', async () => {
    const gw = new SimulatedGateway();
    const { checkoutRequestId } = await gw.initiateStkPush(input);
    expect((await gw.queryStkStatus(checkoutRequestId)).status).toBe('pending');
  });

  it('reports a success with a receipt once set', async () => {
    const gw = new SimulatedGateway();
    const { checkoutRequestId } = await gw.initiateStkPush(input);
    gw.setOutcome(checkoutRequestId, 'success');
    const status = await gw.queryStkStatus(checkoutRequestId);
    expect(status.status).toBe('success');
    expect(status.resultCode).toBe(0);
    expect(status.mpesaReceipt).toBeTruthy();
  });

  it('reports a failure with a non-zero result code once set', async () => {
    const gw = new SimulatedGateway();
    const { checkoutRequestId } = await gw.initiateStkPush(input);
    gw.setOutcome(checkoutRequestId, 'failed');
    const status = await gw.queryStkStatus(checkoutRequestId);
    expect(status.status).toBe('failed');
    expect(status.resultCode).not.toBe(0);
    expect(status.mpesaReceipt).toBeNull();
  });
});
