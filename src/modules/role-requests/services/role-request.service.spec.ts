import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RoleRequestStage, RoleRequestStatus, RoleRequestType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import { ENTRY_STAGE, nextStage } from '../constants/role-request.constants';
import { RoleRequestRoutingService } from './role-request-routing.service';
import { RoleRequestService } from './role-request.service';

describe('role request pipeline shape', () => {
  it('climbs OFFICIAL → MANAGER → ADMIN and stops', () => {
    expect(nextStage(RoleRequestStage.OFFICIAL)).toBe(RoleRequestStage.MANAGER);
    expect(nextStage(RoleRequestStage.MANAGER)).toBe(RoleRequestStage.ADMIN);
    expect(nextStage(RoleRequestStage.ADMIN)).toBeNull();
  });

  it('enters Business Development at MANAGER, skipping the regional Official', () => {
    // A platform-wide role has no regional supervisor to review it.
    expect(ENTRY_STAGE[RoleRequestType.BUSINESS_DEVELOPMENT]).toBe(RoleRequestStage.MANAGER);
    expect(ENTRY_STAGE[RoleRequestType.AGENCY]).toBe(RoleRequestStage.OFFICIAL);
  });
});

describe('RoleRequestService', () => {
  let service: RoleRequestService;

  const KARNATAKA = { regionId: 'r-blr', stateId: 's-ka', countryId: 'c-in' };

  const tx = {
    roleRequestCounter: { upsert: jest.fn() },
    roleRequest: { create: jest.fn(), update: jest.fn() },
    roleRequestAction: { create: jest.fn(), findFirst: jest.fn() },
  };

  const prisma = {
    roleRequest: { findUnique: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    role: { findFirst: jest.fn() },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const routing = {
    resolveGeography: jest.fn(),
    canActAtStage: jest.fn(),
    queueFilter: jest.fn(),
  };
  const roleService = { assignRoleToUser: jest.fn() };

  const openRequest = (over: Record<string, unknown> = {}) => ({
    id: 'req-1',
    reference: 'RR-2026-000001',
    type: RoleRequestType.AGENCY,
    subjectUserId: 'subject-1',
    status: RoleRequestStatus.SUBMITTED,
    currentStage: RoleRequestStage.OFFICIAL,
    currentStageEnteredAt: new Date('2026-07-01T00:00:00Z'),
    submittedAt: new Date('2026-07-01T00:00:00Z'),
    ...KARNATAKA,
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    routing.resolveGeography.mockResolvedValue(KARNATAKA);
    routing.canActAtStage.mockResolvedValue(true);
    tx.roleRequestAction.findFirst.mockResolvedValue({ sequence: 1 });
    tx.roleRequest.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...openRequest(), ...data }),
    );
    service = new RoleRequestService(
      prisma as unknown as PrismaService,
      routing as unknown as RoleRequestRoutingService,
      roleService as unknown as RoleService,
    );
  });

  describe('submit', () => {
    it('stamps a per-year reference and records the SUBMIT action', async () => {
      tx.roleRequestCounter.upsert.mockResolvedValue({ lastSequence: 154 });
      tx.roleRequest.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'req-1', ...data }),
      );

      const result = await service.submit(
        { type: RoleRequestType.AGENCY, subjectUserId: 'subject-1' },
        'initiator-1',
      );

      expect((result as { reference: string }).reference).toMatch(/^RR-\d{4}-000154$/);
      expect(tx.roleRequestAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sequence: 1 }) }),
      );
    });

    it('files the request against the subject’s normalised geography', async () => {
      tx.roleRequestCounter.upsert.mockResolvedValue({ lastSequence: 1 });
      tx.roleRequest.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'req-1', ...data }),
      );

      await service.submit(
        { type: RoleRequestType.AGENCY, subjectUserId: 'subject-1' },
        'initiator-1',
      );

      const data = tx.roleRequest.create.mock.calls[0][0].data;
      expect(data).toMatchObject(KARNATAKA);
    });

    it('surfaces the unique-index violation as a conflict', async () => {
      tx.roleRequestCounter.upsert.mockResolvedValue({ lastSequence: 2 });
      tx.roleRequest.create.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.submit({ type: RoleRequestType.AGENCY, subjectUserId: 'subject-1' }, 'initiator-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('stage actions', () => {
    it('advances OFFICIAL to MANAGER without granting anything', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(openRequest());

      await service.advance({ requestId: 'req-1', actorId: 'official-1' });

      expect(tx.roleRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ currentStage: RoleRequestStage.MANAGER }),
        }),
      );
      expect(roleService.assignRoleToUser).not.toHaveBeenCalled();
    });

    it('advancing at the final stage approves and grants the role', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(
        openRequest({ currentStage: RoleRequestStage.ADMIN }),
      );
      prisma.role.findFirst.mockResolvedValue({ id: 'role-agency', name: 'AGENCY' });

      await service.advance({ requestId: 'req-1', actorId: 'admin-1' });

      expect(roleService.assignRoleToUser).toHaveBeenCalledWith(
        { userId: 'subject-1', roleId: 'role-agency' },
        'admin-1',
      );
    });

    it('refuses an actor who does not own the stage or territory', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(openRequest());
      routing.canActAtStage.mockResolvedValue(false);

      await expect(
        service.advance({ requestId: 'req-1', actorId: 'official-elsewhere' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses to action an already-decided request', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(
        openRequest({ status: RoleRequestStatus.APPROVED, currentStage: null }),
      );

      await expect(service.advance({ requestId: 'req-1', actorId: 'admin-1' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('send-back keeps the stage so the same reviewer resumes', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(openRequest());

      await service.sendBack({ requestId: 'req-1', actorId: 'official-1', notes: 'need ID' });

      const data = tx.roleRequest.update.mock.calls[0][0].data;
      expect(data).toEqual({ status: RoleRequestStatus.NEEDS_INFO });
      expect(data.currentStage).toBeUndefined();
    });

    it('refuses to approve when the granted role is not seeded', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(openRequest());
      prisma.role.findFirst.mockResolvedValue(null);

      await expect(service.approve({ requestId: 'req-1', actorId: 'admin-1' })).rejects.toThrow(
        BadRequestException,
      );
      expect(roleService.assignRoleToUser).not.toHaveBeenCalled();
    });

    it('appends each action with the next sequence number', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(openRequest());
      tx.roleRequestAction.findFirst.mockResolvedValue({ sequence: 4 });

      await service.sendBack({ requestId: 'req-1', actorId: 'official-1' });

      expect(tx.roleRequestAction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sequence: 5 }) }),
      );
    });
  });

  describe('withdraw', () => {
    it('lets the subject withdraw their own request', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(openRequest());

      await service.withdraw('req-1', 'subject-1');

      expect(tx.roleRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: RoleRequestStatus.WITHDRAWN }),
        }),
      );
    });

    it('stops anyone else withdrawing it', async () => {
      prisma.roleRequest.findUnique.mockResolvedValue(openRequest());

      await expect(service.withdraw('req-1', 'someone-else')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('queue', () => {
    it('combines the territory filter with open statuses using AND', async () => {
      routing.queueFilter.mockResolvedValue({ OR: [{ regionId: 'r-blr' }] });
      prisma.roleRequest.count.mockResolvedValue(0);
      prisma.roleRequest.findMany.mockResolvedValue([]);

      await service.queue('official-1');

      // Spreading would let the status OR replace the territory OR.
      const where = prisma.roleRequest.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual({ OR: [{ regionId: 'r-blr' }] });
      expect(where.AND[1].status.in).toContain(RoleRequestStatus.SUBMITTED);
    });
  });
});
