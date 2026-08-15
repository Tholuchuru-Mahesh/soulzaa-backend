import { NotFoundException } from '@nestjs/common';
import { AgencyJoinRequestService } from './agency-join-request.service';

/**
 * Joining creates membership, so the rules that matter are: one agency at a
 * time, no duplicate queue entries, an agency can only decide its own queue,
 * and accepting writes the relationship and the decision together.
 */
describe('AgencyJoinRequestService', () => {
  const AGENCY = 'agency-1';
  const USER = 'user-1';
  const REQUEST = 'req-1';

  function build() {
    const tx: any = {
      agencyRelationship: { upsert: jest.fn().mockResolvedValue({}) },
      agencyJoinRequest: { update: jest.fn().mockImplementation((a: any) => a.data) },
    };
    const prisma: any = {
      roleRequest: { findFirst: jest.fn().mockResolvedValue({ id: 'rr-1' }) },
      agencyRelationship: { findFirst: jest.fn().mockResolvedValue(null) },
      agencyJoinRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((a: any) => ({ id: REQUEST, ...a.data })),
        update: jest.fn().mockImplementation((a: any) => a.data),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const profiles = { resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()) };
    const service = new AgencyJoinRequestService(prisma, notifications as never, profiles as never);
    return { service, prisma, tx, notifications };
  }

  describe('request', () => {
    it('refuses joining your own agency', async () => {
      const { service } = build();

      await expect(service.request(AGENCY, AGENCY)).rejects.toThrow(/your own agency/i);
    });

    it('refuses a target that is not an approved agency', async () => {
      const { service, prisma } = build();
      prisma.roleRequest.findFirst.mockResolvedValue(null);

      await expect(service.request(USER, 'not-an-agency')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses a user already in another agency', async () => {
      // The exit policy only releases members on the 1st–2nd of a month, so a
      // user cannot quietly move between agencies.
      const { service, prisma } = build();
      prisma.agencyRelationship.findFirst.mockResolvedValue({ agencyId: 'other-agency' });

      await expect(service.request(USER, AGENCY)).rejects.toThrow(/already in an agency/i);
    });

    it('tells a user already in this agency that they are a member', async () => {
      const { service, prisma } = build();
      prisma.agencyRelationship.findFirst.mockResolvedValue({ agencyId: AGENCY });

      await expect(service.request(USER, AGENCY)).rejects.toThrow(/already a member/i);
    });

    it('refuses a second pending request to the same agency', async () => {
      const { service, prisma } = build();
      prisma.agencyJoinRequest.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(service.request(USER, AGENCY)).rejects.toThrow(/already asked/i);
    });

    it('creates the request and notifies the agency', async () => {
      const { service, prisma, notifications } = build();

      await service.request(USER, AGENCY, ' please add me ');

      expect(prisma.agencyJoinRequest.create).toHaveBeenCalledWith({
        data: { agencyId: AGENCY, userId: USER, message: 'please add me' },
      });
      // The agency is the recipient — it is the one that has to act.
      expect(notifications.create.mock.calls[0][0]).toMatchObject({
        userId: AGENCY,
        actorId: USER,
        entityType: 'agency_join_request',
      });
    });
  });

  describe('accept', () => {
    it('writes the membership and the decision in one transaction', async () => {
      const { service, prisma, tx } = build();
      prisma.agencyJoinRequest.findFirst.mockResolvedValue({ id: REQUEST, userId: USER });

      await service.accept(AGENCY, REQUEST);

      // Marking a request accepted without a membership row would show the
      // applicant as approved while the agency gained no member.
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(tx.agencyRelationship.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agencyId_hostId: { agencyId: AGENCY, hostId: USER } },
        }),
      );
      expect(tx.agencyJoinRequest.update.mock.calls[0][0].data.status).toBe('ACCEPTED');
    });

    it('re-checks membership at decision time, not just at request time', async () => {
      // The applicant may have joined elsewhere while the request queued.
      const { service, prisma, tx } = build();
      prisma.agencyJoinRequest.findFirst.mockResolvedValue({ id: REQUEST, userId: USER });
      prisma.agencyRelationship.findFirst.mockResolvedValue({ agencyId: 'other' });

      await expect(service.accept(AGENCY, REQUEST)).rejects.toThrow(/already joined/i);
      expect(tx.agencyRelationship.upsert).not.toHaveBeenCalled();
    });

    it('refuses a request belonging to another agency', async () => {
      const { service, prisma } = build();
      prisma.agencyJoinRequest.findFirst.mockResolvedValue(null);

      await expect(service.accept(AGENCY, REQUEST)).rejects.toBeInstanceOf(NotFoundException);
      // Ownership is in the query, so another agency's row is never read.
      expect(prisma.agencyJoinRequest.findFirst).toHaveBeenCalledWith({
        where: { id: REQUEST, agencyId: AGENCY, status: 'PENDING' },
      });
    });

    it('notifies the applicant of the decision', async () => {
      const { service, prisma, notifications } = build();
      prisma.agencyJoinRequest.findFirst.mockResolvedValue({ id: REQUEST, userId: USER });

      await service.accept(AGENCY, REQUEST);

      expect(notifications.create.mock.calls[0][0]).toMatchObject({
        userId: USER,
        data: expect.objectContaining({ event: 'ACCEPTED' }),
      });
    });

    it('does not undo an accepted membership when the notification fails', async () => {
      const { service, prisma, notifications, tx } = build();
      prisma.agencyJoinRequest.findFirst.mockResolvedValue({ id: REQUEST, userId: USER });
      notifications.create.mockRejectedValue(new Error('push down'));

      await expect(service.accept(AGENCY, REQUEST)).resolves.toBeDefined();
      expect(tx.agencyRelationship.upsert).toHaveBeenCalled();
    });
  });

  describe('decline', () => {
    it('records the decision without creating a membership', async () => {
      const { service, prisma, tx } = build();
      prisma.agencyJoinRequest.findFirst.mockResolvedValue({ id: REQUEST, userId: USER });

      await service.decline(AGENCY, REQUEST);

      expect(prisma.agencyJoinRequest.update.mock.calls[0][0].data.status).toBe('DECLINED');
      expect(tx.agencyRelationship.upsert).not.toHaveBeenCalled();
    });
  });
});
