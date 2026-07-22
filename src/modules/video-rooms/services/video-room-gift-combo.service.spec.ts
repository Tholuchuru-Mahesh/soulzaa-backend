import { VIDEO_ROOM_GIFT_EVENTS } from '../events/video-room-gift.events';
import { VideoRoomGiftComboService } from './video-room-gift-combo.service';

const NOW = 1_700_000_000_000;
const GIFT = { id: 'g1', comboWindowSeconds: 10 } as never;

describe('VideoRoomGiftComboService', () => {
  let cache: Record<string, jest.Mock>;
  let bus: { publish: jest.Mock };
  let metrics: { incGiftCombo: jest.Mock };
  let service: VideoRoomGiftComboService;

  const publishedNames = () => bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);

  beforeEach(() => {
    cache = {
      increment: jest.fn().mockResolvedValue(1),
      setScore: jest.fn().mockResolvedValue(undefined),
      sortedRangeByScore: jest.fn().mockResolvedValue([]),
      sortedRemove: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      score: jest.fn().mockResolvedValue(NOW + 10_000),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    metrics = { incGiftCombo: jest.fn() };
    service = new VideoRoomGiftComboService(
      cache as never,
      bus as never,
      metrics as never,
      () => NOW,
    );
  });

  describe('tick', () => {
    it('publishes ComboStarted on the first tick', async () => {
      cache.increment.mockResolvedValue(1);
      const result = await service.tick('r1', 's1', GIFT, 100);
      expect(publishedNames()).toEqual([VIDEO_ROOM_GIFT_EVENTS.COMBO_STARTED]);
      expect(result).toEqual({ tier: 1, started: true });
    });

    it('publishes ComboUpdated on a continuing streak', async () => {
      cache.increment.mockResolvedValue(4);
      const result = await service.tick('r1', 's1', GIFT, 100);
      expect(publishedNames()).toEqual([VIDEO_ROOM_GIFT_EVENTS.COMBO_UPDATED]);
      expect(result).toEqual({ tier: 4, started: false });
    });

    it('sets the counter TTL to the gift combo window', async () => {
      await service.tick('r1', 's1', GIFT, 100);
      expect(cache.increment).toHaveBeenCalledWith('video-room:r1:gift:combo:s1:g1', {
        ttlSeconds: 10,
      });
    });

    it('registers the combo in the expiry index at now + window', async () => {
      await service.tick('r1', 's1', GIFT, 100);
      expect(cache.setScore).toHaveBeenCalledWith(
        'video-room:gift:combos',
        'r1|s1|g1',
        NOW + 10_000,
      );
    });

    it('counts the combo phase for monitoring', async () => {
      cache.increment.mockResolvedValue(1);
      await service.tick('r1', 's1', GIFT, 100);
      expect(metrics.incGiftCombo).toHaveBeenCalledWith('started');
      cache.increment.mockResolvedValue(2);
      await service.tick('r1', 's1', GIFT, 100);
      expect(metrics.incGiftCombo).toHaveBeenCalledWith('updated');
    });

    it('does NOT multiply cost — returns the tier only', async () => {
      cache.increment.mockResolvedValue(7);
      const result = await service.tick('r1', 's1', GIFT, 100);
      expect(result).toEqual({ tier: 7, started: false });
      expect(result).not.toHaveProperty('multiplier');
    });
  });

  describe('sweepExpired', () => {
    it('publishes ComboEnded once per expired combo and removes it', async () => {
      cache.sortedRangeByScore.mockResolvedValue(['r1|s1|g1']);
      cache.get.mockResolvedValue(5);

      expect(await service.sweepExpired(NOW)).toBe(1);
      expect(publishedNames()).toEqual([VIDEO_ROOM_GIFT_EVENTS.COMBO_ENDED]);
      expect(bus.publish.mock.calls[0][0].payload).toEqual({
        roomId: 'r1',
        senderId: 's1',
        giftId: 'g1',
        finalTier: 5,
      });
      expect(cache.sortedRemove).toHaveBeenCalledWith('video-room:gift:combos', 'r1|s1|g1');
    });

    it('counts each closed combo for monitoring', async () => {
      cache.sortedRangeByScore.mockResolvedValue(['r1|s1|g1']);
      await service.sweepExpired(NOW);
      expect(metrics.incGiftCombo).toHaveBeenCalledWith('ended');
    });

    it('publishes nothing and touches nothing when no combo has expired', async () => {
      cache.sortedRangeByScore.mockResolvedValue([]);
      expect(await service.sweepExpired(NOW)).toBe(0);
      expect(bus.publish).not.toHaveBeenCalled();
      expect(cache.sortedRemove).not.toHaveBeenCalled();
    });

    it('reports finalTier 0 when the counter has already expired', async () => {
      cache.sortedRangeByScore.mockResolvedValue(['r1|s1|g1']);
      cache.get.mockResolvedValue(null);
      await service.sweepExpired(NOW);
      expect(bus.publish.mock.calls[0][0].payload.finalTier).toBe(0);
    });

    it('skips a malformed index member without aborting the sweep', async () => {
      cache.sortedRangeByScore.mockResolvedValue(['garbage', 'r1|s1|g1']);
      cache.get.mockResolvedValue(3);
      expect(await service.sweepExpired(NOW)).toBe(1);
      expect(publishedNames()).toEqual([VIDEO_ROOM_GIFT_EVENTS.COMBO_ENDED]);
    });

    it('publishes before removing, so a crash replays rather than loses the event', async () => {
      cache.sortedRangeByScore.mockResolvedValue(['r1|s1|g1']);
      const order: string[] = [];
      bus.publish.mockImplementation(async () => void order.push('publish'));
      cache.sortedRemove.mockImplementation(async () => void order.push('remove'));
      await service.sweepExpired(NOW);
      expect(order).toEqual(['publish', 'remove']);
    });

    it('sweeps only up to the supplied clock', async () => {
      await service.sweepExpired(NOW);
      expect(cache.sortedRangeByScore).toHaveBeenCalledWith('video-room:gift:combos', 0, NOW);
    });
  });

  describe('listActive', () => {
    it('returns live combos for this room only', async () => {
      cache.sortedRangeByScore.mockResolvedValue(['r1|s1|g1', 'r2|s9|g9']);
      cache.get.mockResolvedValue(3);
      const combos = await service.listActive('r1', NOW);
      expect(combos).toEqual([
        { senderId: 's1', giftId: 'g1', tier: 3, expiresAt: new Date(NOW + 10_000).toISOString() },
      ]);
    });

    it('returns an empty list on cold Redis rather than erroring', async () => {
      cache.sortedRangeByScore.mockResolvedValue([]);
      await expect(service.listActive('r1', NOW)).resolves.toEqual([]);
    });

    it('drops entries whose counter has vanished', async () => {
      cache.sortedRangeByScore.mockResolvedValue(['r1|s1|g1']);
      cache.get.mockResolvedValue(null);
      await expect(service.listActive('r1', NOW)).resolves.toEqual([]);
    });
  });
});
