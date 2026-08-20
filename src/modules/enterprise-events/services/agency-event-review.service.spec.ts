import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgencyEventReviewService } from './agency-event-review.service';

/**
 * The admin half of the agency event lifecycle. Two invariants it defends:
 * challenges share the event_definitions table and must never appear in this
 * queue, and a decision is only ever taken on an event actually awaiting one.
 */
describe('AgencyEventReviewService', () => {
  let service: AgencyEventReviewService;

  const prisma = {
    eventDefinition: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    user: { findMany: jest.fn() },
  };
  const audit = { logAudit: jest.fn() };
  const sockets = { emitToNamespace: jest.fn(), emitToUserEverywhere: jest.fn() };

  const AGENCY = '11111111-1111-4111-8111-111111111111';

  const submitted = (status = 'PENDING_APPROVAL') => ({
    id: 'e1',
    name: 'Super Star Singing Battle',
    category: 'AGENCY_CAMPAIGN',
    status,
    agencyId: AGENCY,
    createdBy: AGENCY,
    participationRules: { pointRules: [{ id: 'p1' }] },
    rewardDefinition: { tiers: [{ id: 't1' }] },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgencyEventReviewService(prisma as never, sockets as never, audit as never);
    prisma.eventDefinition.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
  });

  describe('listForAdmin', () => {
    it('returns agency events only, never challenges', async () => {
      await service.listForAdmin();

      expect(prisma.eventDefinition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { category: 'AGENCY_CAMPAIGN' } }),
      );
    });

    it('narrows to one status when asked', async () => {
      await service.listForAdmin('PENDING_APPROVAL');

      expect(prisma.eventDefinition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { category: 'AGENCY_CAMPAIGN', status: 'PENDING_APPROVAL' },
        }),
      );
    });

    it('names the agency that submitted each event', async () => {
      prisma.eventDefinition.findMany.mockResolvedValue([submitted()]);
      prisma.user.findMany.mockResolvedValue([
        { id: AGENCY, username: 'nasinasujatha4', fullName: 'Vasu' },
      ]);

      const [row] = await service.listForAdmin();

      expect(row.agencyName).toBe('Vasu');
      expect(row.name).toBe('Super Star Singing Battle');
    });
  });

  describe('approve', () => {
    it('schedules the event so the lifecycle scheduler picks it up', async () => {
      prisma.eventDefinition.findUnique.mockResolvedValue(submitted());
      prisma.eventDefinition.update.mockResolvedValue({ ...submitted(), status: 'SCHEDULED' });

      await service.approve('e1', 'admin-1');

      expect(prisma.eventDefinition.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'e1' }, data: { status: 'SCHEDULED' } }),
      );
    });

    it.each(['DRAFT', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'REJECTED', 'COMPLETED'])(
      'refuses to approve an event in status %s',
      async (status) => {
        prisma.eventDefinition.findUnique.mockResolvedValue(submitted(status));

        await expect(service.approve('e1', 'admin-1')).rejects.toThrow(BadRequestException);
        expect(prisma.eventDefinition.update).not.toHaveBeenCalled();
      },
    );

    it('rejects an id that is not an agency event', async () => {
      prisma.eventDefinition.findUnique.mockResolvedValue({
        ...submitted(),
        category: 'AGENCY_CHALLENGE',
      });

      await expect(service.approve('e1', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('records who approved it', async () => {
      prisma.eventDefinition.findUnique.mockResolvedValue(submitted());
      prisma.eventDefinition.update.mockResolvedValue({ ...submitted(), status: 'SCHEDULED' });

      await service.approve('e1', 'admin-1');

      expect(audit.logAudit).toHaveBeenCalledWith(
        'EVENT_STATUS_CHANGED',
        'e1',
        'admin-1',
        expect.objectContaining({ status: 'SCHEDULED' }),
      );
    });

    it('still approves when the socket broadcast fails', async () => {
      prisma.eventDefinition.findUnique.mockResolvedValue(submitted());
      prisma.eventDefinition.update.mockResolvedValue({ ...submitted(), status: 'SCHEDULED' });
      sockets.emitToNamespace.mockImplementation(() => {
        throw new Error('socket down');
      });

      await expect(service.approve('e1', 'admin-1')).resolves.toMatchObject({
        status: 'SCHEDULED',
      });
    });
  });

  describe('reject', () => {
    it('marks the event rejected', async () => {
      prisma.eventDefinition.findUnique.mockResolvedValue(submitted());
      prisma.eventDefinition.update.mockResolvedValue({ ...submitted(), status: 'REJECTED' });

      await service.reject('e1', 'Banner is unreadable', 'admin-1');

      expect(prisma.eventDefinition.update.mock.calls[0][0].data.status).toBe('REJECTED');
    });

    it('stores the reason without discarding the point rules', async () => {
      prisma.eventDefinition.findUnique.mockResolvedValue(submitted());
      prisma.eventDefinition.update.mockResolvedValue({ ...submitted(), status: 'REJECTED' });

      await service.reject('e1', 'Banner is unreadable', 'admin-1');

      expect(prisma.eventDefinition.update.mock.calls[0][0].data.participationRules).toEqual({
        pointRules: [{ id: 'p1' }],
        rejectionReason: 'Banner is unreadable',
      });
    });

    it.each(['DRAFT', 'SCHEDULED', 'ACTIVE'])(
      'refuses to reject an event in status %s',
      async (status) => {
        prisma.eventDefinition.findUnique.mockResolvedValue(submitted(status));

        await expect(service.reject('e1', 'no', 'admin-1')).rejects.toThrow(BadRequestException);
        expect(prisma.eventDefinition.update).not.toHaveBeenCalled();
      },
    );
  });
});
