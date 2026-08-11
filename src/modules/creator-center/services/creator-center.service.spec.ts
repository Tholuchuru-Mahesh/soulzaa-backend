import { BusinessException } from 'src/common/exceptions';
import type { IAnalyticsService } from 'src/modules/analytics/interfaces/analytics.service.interface';
import type {
  IAudioRoomsService,
  LiveSessionView,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { IGiftsService } from 'src/modules/gifts/interfaces/gifts.service.interface';
import type { IPkBattleService } from 'src/modules/audio-rooms/interfaces/pk-battle.service.interface';
import type { ISocialService } from 'src/modules/social/interfaces/social.interface';
import type { IProfileService } from 'src/modules/users/interfaces/profile.interface';
import { WithdrawalApprovalService } from 'src/modules/withdrawals/services/withdrawal-approval.service';
import { WithdrawalConfigurationService } from 'src/modules/withdrawals/services/withdrawal-configuration.service';
import { WithdrawalHistoryService } from 'src/modules/withdrawals/services/withdrawal-history.service';
import { WithdrawalService } from 'src/modules/withdrawals/services/withdrawal.service';
import { CreatorCenterService } from './creator-center.service';


const OWNER_ID = 'owner-1';

function session(overrides: Partial<LiveSessionView> = {}): LiveSessionView {
  return {
    id: 'session-1',
    roomId: 'room-1',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: new Date('2026-01-01T01:00:00Z'),
    durationSeconds: 3600,
    status: 'ENDED',
    ...overrides,
  };
}

describe('CreatorCenterService', () => {
  let rooms: jest.Mocked<Pick<IAudioRoomsService, 'listMyLiveSessions' | 'getMyLiveSession' | 'getRoom'>>;
  let analytics: jest.Mocked<Pick<IAnalyticsService, 'getVisitorsInRange'>>;
  let gifts: jest.Mocked<Pick<IGiftsService, 'getContextCoinsInRange' | 'getTopFans'>>;
  let social: jest.Mocked<Pick<ISocialService, 'countNewFollowers'>>;
  let pk: jest.Mocked<IPkBattleService>;
  let profiles: jest.Mocked<Pick<IProfileService, 'getCards'>>;
  let service: CreatorCenterService;

  beforeEach(() => {
    rooms = {
      listMyLiveSessions: jest.fn(),
      getMyLiveSession: jest.fn(),
      getRoom: jest.fn().mockResolvedValue({
        id: 'room-1',
        name: 'My Room',
        imageUrl: 'https://cdn.test/cover.png',
      }),
    } as never;
    analytics = {
      getVisitorsInRange: jest.fn().mockResolvedValue([
        { userId: 'fan-1', joinedAt: new Date('2026-01-01T00:05:00Z'), leftAt: null },
        { userId: 'fan-2', joinedAt: new Date('2026-01-01T00:10:00Z'), leftAt: null },
        { userId: 'fan-1', joinedAt: new Date('2026-01-01T00:40:00Z'), leftAt: null },
      ]),
    } as never;
    gifts = {
      getContextCoinsInRange: jest.fn().mockResolvedValue(8500n),
      getTopFans: jest.fn().mockResolvedValue([]),
    } as never;
    social = { countNewFollowers: jest.fn().mockResolvedValue(12) } as never;
    pk = {
      historyForCreator: jest.fn(),
      getCreatorBattleDetail: jest.fn(),
    } as never;
    profiles = { getCards: jest.fn().mockResolvedValue([]) } as never;

    service = new CreatorCenterService(
      rooms as unknown as IAudioRoomsService,
      analytics as unknown as IAnalyticsService,
      gifts as unknown as IGiftsService,
      social as unknown as ISocialService,
      pk as unknown as IPkBattleService,
      profiles as unknown as IProfileService,
      {} as unknown as WithdrawalService,
      {} as unknown as WithdrawalHistoryService,
      {} as unknown as WithdrawalConfigurationService,
      {} as unknown as WithdrawalApprovalService,
    );

  });

  describe('getLiveHistory', () => {
    it('computes visitors/uniqueVisitors/giftCoins/newFollowers per session and paginates', async () => {
      rooms.listMyLiveSessions.mockResolvedValue({ rows: [session()], total: 1 });

      const result = await service.getLiveHistory(OWNER_ID, 1, 20, 0);

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      const entry = result.items[0];
      expect(entry.sessionId).toBe('session-1');
      expect(entry.roomName).toBe('My Room');
      expect(entry.visitors).toBe(3); // 3 join rows
      expect(entry.uniqueVisitors).toBe(2); // fan-1, fan-2
      expect(entry.giftCoins).toBe('8500');
      expect(entry.newFollowers).toBe(12);
      expect(gifts.getContextCoinsInRange).toHaveBeenCalledWith(
        'AUDIO_ROOM',
        'room-1',
        session().startedAt,
        session().endedAt,
      );
    });

    it('uses "now" as the window end for a still-LIVE session', async () => {
      const live = session({ status: 'LIVE', endedAt: null });
      rooms.listMyLiveSessions.mockResolvedValue({ rows: [live], total: 1 });

      await service.getLiveHistory(OWNER_ID, 1, 20, 0);

      const [, , end] = analytics.getVisitorsInRange.mock.calls[0];
      expect(end).toBeInstanceOf(Date);
      expect(end.getTime()).toBeGreaterThan(live.startedAt.getTime());
    });

    it('returns an empty page without calling any enrichment service', async () => {
      rooms.listMyLiveSessions.mockResolvedValue({ rows: [], total: 0 });

      const result = await service.getLiveHistory(OWNER_ID, 1, 20, 0);

      expect(result.items).toEqual([]);
      expect(analytics.getVisitorsInRange).not.toHaveBeenCalled();
    });
  });

  describe('getLiveHistoryDetail', () => {
    it('throws NOT_FOUND when the session does not exist or is not the caller\'s own', async () => {
      rooms.getMyLiveSession.mockResolvedValue(null);

      await expect(service.getLiveHistoryDetail(OWNER_ID, 'not-mine')).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('returns the enriched entry when the session belongs to the caller', async () => {
      rooms.getMyLiveSession.mockResolvedValue(session());

      const entry = await service.getLiveHistoryDetail(OWNER_ID, 'session-1');

      expect(entry.sessionId).toBe('session-1');
      expect(rooms.getMyLiveSession).toHaveBeenCalledWith(OWNER_ID, 'session-1');
    });
  });

  describe('getPkHistory', () => {
    it('delegates to the PK battle service with the caller id and filter', async () => {
      pk.historyForCreator.mockResolvedValue({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });

      await service.getPkHistory(OWNER_ID, 1, 20, 0, 'wins');

      expect(pk.historyForCreator).toHaveBeenCalledWith(OWNER_ID, {
        skip: 0,
        limit: 20,
        page: 1,
        filter: 'wins',
      });
    });
  });

  describe('getPkHistoryDetail', () => {
    it('throws NOT_FOUND when the caller did not fight in that battle', async () => {
      pk.getCreatorBattleDetail.mockResolvedValue(null);

      await expect(service.getPkHistoryDetail(OWNER_ID, 'not-mine')).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('returns the battle detail when the caller was a participant', async () => {
      pk.getCreatorBattleDetail.mockResolvedValue({ battleId: 'battle-1' });

      const detail = await service.getPkHistoryDetail(OWNER_ID, 'battle-1');

      expect(detail).toEqual({ battleId: 'battle-1' });
    });
  });

  describe('getTopFans', () => {
    it('hydrates ranked fan ids with profile cards', async () => {
      gifts.getTopFans.mockResolvedValue([
        { rank: 1, userId: 'fan-1', totalCoins: 52500, giftCount: 12, lastGiftAt: new Date('2026-01-01') },
      ]);
      profiles.getCards.mockResolvedValue([
        {
          id: 'fan-1',
          username: 'rahul',
          fullName: 'Rahul',
          avatarUrl: 'https://cdn.test/rahul.png',
          verified: false,
          level: 10,
          vipLevel: 2,
          country: null,
        },
      ]);

      const fans = await service.getTopFans(OWNER_ID, 'month', 20);

      expect(fans).toEqual([
        {
          rank: 1,
          userId: 'fan-1',
          username: 'rahul',
          fullName: 'Rahul',
          avatarUrl: 'https://cdn.test/rahul.png',
          level: 10,
          vipLevel: 2,
          totalCoins: 52500,
          giftCount: 12,
          lastGiftAt: new Date('2026-01-01'),
        },
      ]);
      expect(gifts.getTopFans).toHaveBeenCalledWith(OWNER_ID, 'month', 20);
    });

    it('returns an empty list without calling the profile service when there are no fans', async () => {
      gifts.getTopFans.mockResolvedValue([]);

      const fans = await service.getTopFans(OWNER_ID, 'all', 20);

      expect(fans).toEqual([]);
      expect(profiles.getCards).not.toHaveBeenCalled();
    });
  });
});
