import type { RedisService } from 'src/infra/redis/redis.service';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { GUARD_BUDGET } from '../constants/notification-guard.constants';
import { NotificationGuard } from './notification-guard.service';

describe('NotificationGuard', () => {
  let client: { set: jest.Mock; incr: jest.Mock; expire: jest.Mock };
  let guard: NotificationGuard;

  beforeEach(() => {
    client = { set: jest.fn(), incr: jest.fn(), expire: jest.fn() };
    guard = new NotificationGuard({ client } as unknown as RedisService);
  });

  describe('once', () => {
    it('runs the work and returns its value when the key is unclaimed', async () => {
      client.set.mockResolvedValue('OK');
      const work = jest.fn().mockResolvedValue('done');

      await expect(guard.once('wallet:txn-1', 3600, work)).resolves.toBe('done');

      expect(work).toHaveBeenCalledTimes(1);
      expect(client.set).toHaveBeenCalledWith('notif:guard:wallet:txn-1', '1', 'EX', 3600, 'NX');
    });

    // The whole point of the guard: a redelivered event must not produce a
    // second notification row or a second push.
    it('skips the work and returns null when the key is already claimed', async () => {
      client.set.mockResolvedValue(null);
      const work = jest.fn();

      await expect(guard.once('wallet:txn-1', 3600, work)).resolves.toBeNull();

      expect(work).not.toHaveBeenCalled();
    });

    // Failing open is deliberate. A duplicate "recharge successful" is an
    // annoyance; a silently dropped one is a support ticket about missing money.
    it('runs the work anyway when Redis errors', async () => {
      client.set.mockRejectedValue(new Error('ECONNREFUSED'));
      const work = jest.fn().mockResolvedValue('done');

      await expect(guard.once('wallet:txn-1', 3600, work)).resolves.toBe('done');

      expect(work).toHaveBeenCalledTimes(1);
    });

    it('propagates an error thrown by the work itself', async () => {
      client.set.mockResolvedValue('OK');
      const work = jest.fn().mockRejectedValue(new Error('db down'));

      await expect(guard.once('wallet:txn-1', 3600, work)).rejects.toThrow('db down');
    });
  });

  describe('withinBudget', () => {
    it('permits while under the hourly cap', async () => {
      client.incr.mockResolvedValue(1);

      await expect(guard.withinBudget('u1', PUSH_CATEGORIES.WALLET)).resolves.toBe(true);
      expect(client.expire).toHaveBeenCalledWith(
        'notif:budget:u1:WALLET',
        GUARD_BUDGET.WINDOW_SECONDS,
      );
    });

    it('refuses once the cap is exceeded', async () => {
      client.incr.mockResolvedValue(GUARD_BUDGET.PER_CATEGORY_PER_HOUR + 1);

      await expect(guard.withinBudget('u1', PUSH_CATEGORIES.WALLET)).resolves.toBe(false);
    });

    it('permits exactly at the cap', async () => {
      client.incr.mockResolvedValue(GUARD_BUDGET.PER_CATEGORY_PER_HOUR);

      await expect(guard.withinBudget('u1', PUSH_CATEGORIES.WALLET)).resolves.toBe(true);
    });

    // Re-setting the TTL on every increment would slide the window forward
    // forever, so a steady trickle of notifications would never reset the count.
    it('sets the window TTL only on the first increment', async () => {
      client.incr.mockResolvedValue(5);

      await guard.withinBudget('u1', PUSH_CATEGORIES.WALLET);

      expect(client.expire).not.toHaveBeenCalled();
    });

    it('keys the bucket per user and per category', async () => {
      client.incr.mockResolvedValue(1);

      await guard.withinBudget('u1', PUSH_CATEGORIES.GAME);

      expect(client.incr).toHaveBeenCalledWith('notif:budget:u1:GAME');
    });

    it('permits when Redis errors', async () => {
      client.incr.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(guard.withinBudget('u1', PUSH_CATEGORIES.WALLET)).resolves.toBe(true);
    });
  });
});
