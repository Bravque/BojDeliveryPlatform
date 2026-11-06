import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StoreView } from './store';
import type { ApiClient, PublicMerchant } from './api';

function makeApi() {
  let merchant: PublicMerchant = {
    ulid: 'M1',
    name: 'Joe Kitchen',
    categoryType: 'restaurant',
    prepMinutes: 15,
    isOpen: true,
    townName: 'Migori',
  };
  const api = {
    getPublicMerchant: vi.fn(() => Promise.resolve({ ...merchant })),
    updateProfile: vi.fn((_t: string, patch: Partial<PublicMerchant>) => {
      merchant = { ...merchant, ...patch };
      return Promise.resolve({ merchantUlid: 'M1' });
    }),
  } as unknown as ApiClient;
  return { api };
}

describe('store settings', () => {
  it('shows the current status and toggles open → closed (persists via PATCH)', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<StoreView api={api} token="tok" merchantUlid="M1" />);

    const toggle = await screen.findByRole('switch', { name: 'Toggle store open' });
    expect(toggle).toBeChecked();
    expect(screen.getByText('Open')).toBeInTheDocument();

    await user.click(toggle);
    expect(api.updateProfile).toHaveBeenCalledWith('tok', { isOpen: false });
    await waitFor(() => expect(screen.getByText('Closed')).toBeInTheDocument());
  });

  it('saves a new preparation time', async () => {
    const user = userEvent.setup();
    const { api } = makeApi();
    render(<StoreView api={api} token="tok" merchantUlid="M1" />);

    const prep = await screen.findByLabelText('Minutes');
    await user.clear(prep);
    await user.type(prep, '25');
    await user.click(screen.getByRole('button', { name: 'Save prep time' }));

    expect(api.updateProfile).toHaveBeenCalledWith('tok', { prepMinutes: 25 });
    expect(await screen.findByText('Preparation time saved')).toBeInTheDocument();
  });
});
