import { WalletController } from './wallet.controller';

describe('WalletController VR-14 read endpoints', () => {
  const wallet = { getBalance: jest.fn(), listTransactions: jest.fn() };
  const read = { getEarnings: jest.fn(), getRewards: jest.fn(), getHistory: jest.fn() };
  const ctrl = new WalletController(wallet as never, {} as never, {} as never, read as never);

  it('GET /wallet/earnings delegates to WalletReadService.getEarnings for the current user', async () => {
    read.getEarnings.mockResolvedValue({
      totalEarned: 10,
      settlementReady: 10,
      bySource: { gifts: 10, treasure: 0, pk: 0 },
    });
    await ctrl.earnings('u1');
    expect(read.getEarnings).toHaveBeenCalledWith('u1');
  });

  it('GET /wallet/rewards passes pagination through', async () => {
    read.getRewards.mockResolvedValue({ items: [], total: 0 });
    await ctrl.rewards('u1', { page: 2, limit: 20, skip: 20 } as never);
    expect(read.getRewards).toHaveBeenCalledWith('u1', 2, 20);
  });

  it('GET /wallet/history passes filters + pagination', async () => {
    read.getHistory.mockResolvedValue({ items: [], total: 0 });
    await ctrl.history('u1', { page: 1, limit: 20, skip: 0, currency: 'GOLD' } as never);
    expect(read.getHistory).toHaveBeenCalledWith(
      'u1',
      { currency: 'GOLD', reason: undefined },
      1,
      20,
    );
  });
});
