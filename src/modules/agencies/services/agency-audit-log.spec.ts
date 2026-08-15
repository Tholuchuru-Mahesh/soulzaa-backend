import { NotFoundException } from '@nestjs/common';
import { AgencyAuditLogService } from './agency-audit-log.service';

/**
 * The audit trail is evidence, so the two properties that matter are that an
 * agency can only read its own, and that nothing here can change a row.
 */
describe('AgencyAuditLogService', () => {
  const AGENCY = 'agency-1';
  const LOG = 'log-1';

  function build() {
    const prisma: any = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const profiles = { resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()) };
    return { service: new AgencyAuditLogService(prisma, profiles as never), prisma, profiles };
  }

  it('exposes no way to modify or delete an entry', () => {
    const { service } = build();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service));

    // The spec requires audit rows to be permanently traceable. A create,
    // update or delete on this service would be a way around that.
    expect(methods.filter((m) => /create|update|delete|remove/i.test(m))).toEqual([]);
  });

  it('pins the list to the calling agency as the actor', async () => {
    const { service, prisma } = build();

    await service.list(AGENCY);

    expect(prisma.auditLog.count.mock.calls[0][0].where).toMatchObject({ actorId: AGENCY });
    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toMatchObject({ actorId: AGENCY });
  });

  it('keeps the actor filter alongside a module and search filter', async () => {
    const { service, prisma } = build();

    await service.list(AGENCY, { module: 'coin_seller_inventory', search: 'credit' });

    const where = prisma.auditLog.findMany.mock.calls[0][0].where;
    // A filter must narrow the agency's own rows, never widen past them.
    expect(where.actorId).toBe(AGENCY);
    expect(where.resource).toBe('coin_seller_inventory');
    expect(where.action).toEqual({ contains: 'credit', mode: 'insensitive' });
  });

  it('caps the page size', async () => {
    const { service } = build();

    const res = await service.list(AGENCY, { limit: 10000 });

    expect(res.limit).toBe(100);
  });

  it('refuses an entry belonging to another agency', async () => {
    const { service, prisma } = build();
    prisma.auditLog.findFirst.mockResolvedValue(null);

    await expect(service.get(AGENCY, LOG)).rejects.toBeInstanceOf(NotFoundException);
    // The ownership check is part of the query, not applied after the read.
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: { id: LOG, actorId: AGENCY },
    });
  });

  it('returns the forensic columns only on the detail read', async () => {
    const { service, prisma } = build();
    const row = {
      id: LOG,
      action: 'COIN_SELLER_INVENTORY_PURCHASED',
      resource: 'coin_seller_inventory',
      resourceId: 'order-1',
      targetUserId: null,
      status: 'SUCCESS',
      createdAt: new Date('2026-08-15T10:00:00Z'),
      ipAddress: '203.0.113.9',
      userAgent: 'Dart/3.10',
      browser: 'Chrome',
      os: 'Android',
      region: 'IN-KA',
      details: { coins: '110000' },
    };
    prisma.auditLog.findFirst.mockResolvedValue(row);

    const detail = await service.get(AGENCY, LOG);
    prisma.auditLog.findMany.mockResolvedValue([row]);
    prisma.auditLog.count.mockResolvedValue(1);
    const listed = await service.list(AGENCY);

    expect(detail).toMatchObject({
      ipAddress: '203.0.113.9',
      browser: 'Chrome',
      os: 'Android',
      details: { coins: '110000' },
    });
    // The list is a summary — IP and device belong to the detail view only.
    expect(listed.items[0]).not.toHaveProperty('ipAddress');
    expect(listed.items[0]).toMatchObject({ action: row.action, reference: 'order-1' });
  });

  it('leaves an unresolvable target user unnamed rather than guessing', async () => {
    const { service, prisma } = build();
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: LOG,
        action: 'COINS_SENT',
        resource: 'coin_seller_inventory',
        resourceId: null,
        targetUserId: 'ghost-1',
        status: 'SUCCESS',
        createdAt: new Date(),
      },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await service.list(AGENCY);

    expect(res.items[0].targetUserId).toBe('ghost-1');
    expect(res.items[0].targetUserName).toBeNull();
  });
});
