import { IEventBus } from 'src/common/events';
import { GIFT_EVENTS, GiftSentPayload } from 'src/modules/gifts/events/gift.events';
import { FamiliesService } from '../services/families.service';
import { FamilyStatisticsService } from '../services/family-statistics.service';
import { FamilyProgressionListener } from './family-progression.listener';

describe('FamilyProgressionListener', () => {
  let bus: Record<string, jest.Mock>;
  let familiesService: Record<string, jest.Mock>;
  let statisticsService: Record<string, jest.Mock>;
  let listener: FamilyProgressionListener;

  beforeEach(() => {
    bus = {
      subscribe: jest.fn(),
      publish: jest.fn(),
    };
    familiesService = {
      getMemberFamilyId: jest.fn().mockResolvedValue('family-1'),
      addFamilyExp: jest.fn().mockResolvedValue(undefined),
      incrementMemberContribution: jest.fn().mockResolvedValue(undefined),
    };
    statisticsService = {
      updateStatistics: jest.fn().mockResolvedValue(undefined),
    };

    listener = new FamilyProgressionListener(
      bus as unknown as IEventBus,
      familiesService as unknown as FamiliesService,
      statisticsService as unknown as FamilyStatisticsService,
    );
  });

  it('subscribes to GIFT_EVENTS.SENT on initialization', () => {
    listener.onModuleInit();
    expect(bus.subscribe).toHaveBeenCalledWith(GIFT_EVENTS.SENT, expect.any(Function));
  });

  it('adds family EXP and member contribution when gift is sent by a family member', async () => {
    let handler: (event: any) => Promise<void> = () => Promise.resolve();
    bus.subscribe.mockImplementation((name, fn) => {
      if (name === GIFT_EVENTS.SENT) {
        handler = fn;
      }
    });

    listener.onModuleInit();

    const payload: Partial<GiftSentPayload> = {
      transactionId: 'txn-1',
      senderId: 'user-1',
      receiverId: 'user-2',
      totalCoinValue: 500,
    };

    await handler({ payload });

    expect(familiesService.getMemberFamilyId).toHaveBeenCalledWith('user-1');
    expect(familiesService.addFamilyExp).toHaveBeenCalledWith('family-1', 500);
    expect(familiesService.incrementMemberContribution).toHaveBeenCalledWith('user-1', 500);
    expect(statisticsService.updateStatistics).toHaveBeenCalledWith('family-1', 500n, 500n);
  });

  it('does nothing if sender does not belong to any family', async () => {
    familiesService.getMemberFamilyId.mockResolvedValue(null);

    let handler: (event: any) => Promise<void> = () => Promise.resolve();
    bus.subscribe.mockImplementation((name, fn) => {
      if (name === GIFT_EVENTS.SENT) {
        handler = fn;
      }
    });

    listener.onModuleInit();

    await handler({
      payload: {
        transactionId: 'txn-2',
        senderId: 'user-loner',
        receiverId: 'user-2',
        totalCoinValue: 250,
      },
    });

    expect(familiesService.getMemberFamilyId).toHaveBeenCalledWith('user-loner');
    expect(familiesService.addFamilyExp).not.toHaveBeenCalled();
    expect(familiesService.incrementMemberContribution).not.toHaveBeenCalled();
  });
});
