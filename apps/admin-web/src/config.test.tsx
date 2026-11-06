import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfigView } from './config';
import { fakeApi } from './testApi';
import type { AdminZone, FeeRule, Promotion } from './api';

function makeApi() {
  let zones: AdminZone[] = [];
  const fees: Record<string, FeeRule[]> = {};
  let promos: Promotion[] = [];

  const api = fakeApi({
    listZones: vi.fn(() => Promise.resolve(zones)),
    createZone: vi.fn((_t, input) => {
      const z: AdminZone = {
        ulid: 'Z1',
        name: input.name,
        centerLat: input.centerLat,
        centerLng: input.centerLng,
        radiusM: input.radiusM,
        isActive: input.isActive ?? true,
        townUlid: 'T1',
        townName: input.townName,
      };
      zones = [z, ...zones];
      fees[z.ulid] = [];
      return Promise.resolve(z);
    }),
    listFeeRules: vi.fn((_t, zoneUlid) => Promise.resolve(fees[zoneUlid] ?? [])),
    createFeeRule: vi.fn((_t, zoneUlid, input) => {
      const r: FeeRule = {
        ulid: 'F1',
        baseFeeCents: input.baseFeeCents,
        perKmCents: input.perKmCents,
        minFeeCents: input.minFeeCents,
        maxFeeCents: input.maxFeeCents ?? null,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        effectiveTo: null,
      };
      fees[zoneUlid] = [r, ...(fees[zoneUlid] ?? [])];
      return Promise.resolve(r);
    }),
    listPromotions: vi.fn(() => Promise.resolve(promos)),
    createPromotion: vi.fn((_t, input) => {
      const p: Promotion = {
        ulid: 'P1',
        code: input.code,
        type: input.type,
        valueBps: input.valueBps ?? null,
        valueCents: input.valueCents ?? null,
        maxDiscountCents: input.maxDiscountCents ?? null,
        minSubtotalCents: input.minSubtotalCents ?? 0,
        perUserLimit: 1,
        totalLimit: null,
        totalRedeemed: 0,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        isActive: true,
      };
      promos = [p, ...promos];
      return Promise.resolve(p);
    }),
  });
  return { api };
}

describe('ConfigView', () => {
  it('creates a zone, then adds a fee rule to it', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<ConfigView api={api} token="tok" />);

    expect(await screen.findByText('No zones yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New zone' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Migori CBD' } });
    fireEvent.change(screen.getByLabelText('Centre latitude'), { target: { value: '-1.0634' } });
    fireEvent.change(screen.getByLabelText('Centre longitude'), { target: { value: '34.4731' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const zoneRow = await screen.findByTestId('zone-Z1');
    expect(within(zoneRow).getByText('Migori CBD')).toBeInTheDocument();
    expect(api.createZone).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ name: 'Migori CBD', townName: 'Migori', radiusM: 3000 }),
    );

    // Select the zone → its fee-rules panel opens; add a rule.
    await user.click(zoneRow);
    expect(await screen.findByText('Fee rules · Migori CBD')).toBeInTheDocument();
    expect(screen.getByText('No fee rules for this zone.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New fee rule' }));
    fireEvent.change(screen.getByLabelText('Base fee (cents)'), { target: { value: '15000' } });
    fireEvent.change(screen.getByLabelText('Min fee (cents)'), { target: { value: '10000' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('fee-F1')).toHaveTextContent('KES 150.00');
    expect(api.createFeeRule).toHaveBeenCalledWith(
      'tok',
      'Z1',
      expect.objectContaining({ baseFeeCents: 15000, minFeeCents: 10000 }),
    );
  });

  it('creates a promotion from the Promotions tab', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<ConfigView api={api} token="tok" />);
    await screen.findByText('No zones yet.');

    await user.click(screen.getByRole('button', { name: 'Promotions' }));
    expect(await screen.findByText('No promotions yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New promotion' }));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'LAUNCH10' } });
    fireEvent.change(screen.getByLabelText('Value (bps, 1000 = 10%)'), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Ends at'), { target: { value: '2026-11-30' } });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByTestId('promo-P1')).toHaveTextContent('LAUNCH10');
    expect(api.createPromotion).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ code: 'LAUNCH10', type: 'percentage', valueBps: 1000 }),
    );
  });
});
