import { RevenueEventService } from './revenue-event.service';

/**
 * Gift double-pay fix (split by context): host revenue distribution must fire
 * ONLY for room/live/battle (host) contexts. For direct/DM/profile contexts the
 * gift handler pays the receiver directly, so revenue must NOT also fire.
 */
describe('RevenueEventService.handleGiftSent — context gating', () => {
  let processGiftRevenue: jest.Mock;
  let service: RevenueEventService;

  beforeEach(() => {
    processGiftRevenue = jest.fn().mockResolvedValue({
      processed: true,
      duplicate: false,
      distributionId: 'd1',
      hostEarningsCoins: '50',
      walletTxnId: 'w1',
    });
    const bus = { subscribe: jest.fn(), publish: jest.fn() };
    service = new RevenueEventService(bus as any, { processGiftRevenue } as any);
  });

  const base = {
    transactionId: 't1',
    receiverId: 'host1',
    contextId: 'r1',
    totalCoinValue: '100',
  };

  it('distributes host revenue for a VIDEO_ROOM gift', async () => {
    await service.handleGiftSent({ ...base, contextType: 'VIDEO_ROOM' });
    expect(processGiftRevenue).toHaveBeenCalledTimes(1);
  });

  it('distributes host revenue for an AUDIO_ROOM gift', async () => {
    await service.handleGiftSent({ ...base, contextType: 'AUDIO_ROOM' });
    expect(processGiftRevenue).toHaveBeenCalledTimes(1);
  });

  it('does NOT distribute for a PRIVATE_CHAT (direct) gift', async () => {
    await service.handleGiftSent({ ...base, contextType: 'PRIVATE_CHAT' });
    expect(processGiftRevenue).not.toHaveBeenCalled();
  });

  it('does NOT default a missing contextType to a host context', async () => {
    await service.handleGiftSent({ ...base });
    expect(processGiftRevenue).not.toHaveBeenCalled();
  });
});
