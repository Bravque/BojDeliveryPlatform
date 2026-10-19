import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from './state-machine';

describe('order state machine', () => {
  it('allows the Phase 3 transitions', () => {
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('draft', 'payment_pending')).toBe(true);
  });

  it('rejects unlisted transitions', () => {
    expect(canTransition('draft', 'delivered')).toBe(false);
    expect(canTransition('delivered', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'draft')).toBe(false);
  });

  it('assertTransition throws a 409 ILLEGAL_TRANSITION for an unlisted move', () => {
    expect(() => assertTransition('draft', 'cancelled')).not.toThrow();
    try {
      assertTransition('delivered', 'cancelled');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { status?: number }).status).toBe(409);
      expect((e as { code?: string }).code).toBe('ILLEGAL_TRANSITION');
    }
  });
});
