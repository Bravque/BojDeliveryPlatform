import { describe, expect, it } from 'vitest';
import { MockSmsProvider } from './mock';

describe('MockSmsProvider', () => {
  it('records sent messages and returns the latest per recipient', async () => {
    const sms = new MockSmsProvider();
    await sms.send({ to: '+254712345678', body: 'code 1' });
    await sms.send({ to: '+254712345678', body: 'code 2' });
    await sms.send({ to: '+254700000000', body: 'other' });

    expect(sms.sent).toHaveLength(3);
    expect(sms.lastTo('+254712345678')?.body).toBe('code 2');
    expect(sms.lastTo('+254700000000')?.body).toBe('other');
    expect(sms.lastTo('+254799999999')).toBeUndefined();
  });
});
