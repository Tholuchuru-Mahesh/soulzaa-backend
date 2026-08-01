import type { IEventBus } from 'src/common/events';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VIP_EVENTS } from '../events/vip.events';
import { VipExpiryService } from './vip-expiry.service';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('VipExpiryService', () => {
  let prisma: { vipMembership: { findMany: jest.Mock; updateMany: jest.Mock } };
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let service: VipExpiryService;

  /** findMany is called twice per sweep: expired first, then expiring. */
  const withRows = (expired: unknown[], expiring: unknown[]) => {
    prisma.vipMembership.findMany.mockResolvedValueOnce(expired).mockResolvedValueOnce(expiring);
  };

  const published = (name: string) =>
    bus.publish.mock.calls.map((c) => c[0] as { name: string }).filter((e) => e.name === name);

  beforeEach(() => {
    prisma = {
      vipMembership: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };

    service = new VipExpiryService(prisma as unknown as PrismaService, bus as unknown as IEventBus);
  });

  it('publishes EXPIRED and flips the status for a lapsed membership', async () => {
    withRows([{ id: 'm1', userId: 'u1', level: 2 }], []);

    const result = await service.sweep(NOW);

    expect(result.expired).toBe(1);
    expect(prisma.vipMembership.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1'] } },
      data: { status: 'EXPIRED' },
    });
    expect(published(VIP_EVENTS.EXPIRED)).toHaveLength(1);
  });

  // Flipping the status is what makes the sweep run-once. Without it, every
  // daily run would re-announce the same expiry forever.
  it('does not touch the database when nothing has lapsed', async () => {
    withRows([], []);

    await service.sweep(NOW);

    expect(prisma.vipMembership.updateMany).not.toHaveBeenCalled();
    expect(published(VIP_EVENTS.EXPIRED)).toHaveLength(0);
  });

  it('publishes EXPIRING with the days remaining', async () => {
    withRows([], [{ userId: 'u2', level: 3, expiresAt: days(3) }]);

    const result = await service.sweep(NOW);

    expect(result.expiring).toBe(1);
    const [event] = published(VIP_EVENTS.EXPIRING) as unknown as {
      payload: { daysRemaining: number; userId: string };
    }[];
    expect(event.payload.userId).toBe('u2');
    expect(event.payload.daysRemaining).toBe(3);
  });

  // Rounding up matters: "expires in 0 days" is a bug, and something expiring
  // in 25 hours is two calendar days away from the user's point of view.
  it('rounds a part-day up rather than down to zero', async () => {
    withRows([], [{ userId: 'u3', level: 1, expiresAt: new Date(NOW.getTime() + 3_600_000) }]);

    await service.sweep(NOW);

    const [event] = published(VIP_EVENTS.EXPIRING) as unknown as {
      payload: { daysRemaining: number };
    }[];
    expect(event.payload.daysRemaining).toBe(1);
  });

  it('queries the expiring window as strictly after now and within the horizon', async () => {
    withRows([], []);

    await service.sweep(NOW);

    const expiringQuery = prisma.vipMembership.findMany.mock.calls[1][0] as {
      where: { status: string; expiresAt: { gt: Date; lte: Date } };
    };
    expect(expiringQuery.where.status).toBe('ACTIVE');
    expect(expiringQuery.where.expiresAt.gt).toEqual(NOW);
    expect(expiringQuery.where.expiresAt.lte).toEqual(days(3));
  });

  it('reports both counts together', async () => {
    withRows(
      [{ id: 'm1', userId: 'u1', level: 1 }],
      [{ userId: 'u2', level: 2, expiresAt: days(2) }],
    );

    await expect(service.sweep(NOW)).resolves.toEqual({ expiring: 1, expired: 1 });
  });
});
