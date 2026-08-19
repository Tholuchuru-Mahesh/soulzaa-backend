import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventValidationService } from './event-validation.service';
import { DraftWriteInput, EventDraftService } from './event-draft.service';

/**
 * The invariant every test here defends: an agency-reachable route can only
 * ever produce DRAFT or PENDING_APPROVAL. EventService.createEvent hardcodes
 * SCHEDULED, which is why this service does its own persistence.
 */
describe('EventDraftService', () => {
  let service: EventDraftService;

  const prisma = {
    eventDefinition: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
  };
  const audit = { logAudit: jest.fn() };
  const validation = { validateCategory: jest.fn(), validateTimeWindows: jest.fn() };

  const ACTOR = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  /** A submittable event, so completeness never masks a status assertion. */
  const owned = (status: string) => ({
    id: 'e1',
    createdBy: ACTOR,
    agencyId: ACTOR,
    status,
    name: 'Super Star Singing Battle',
    description: 'Compete with other creators.',
    banner: 'event-banners/u1/b.jpg',
    regStartTime: new Date('2026-08-20T10:00:00Z'),
    regEndTime: new Date('2026-08-24T18:00:00Z'),
    startTime: new Date('2026-08-25T10:00:00Z'),
    endTime: new Date('2026-08-31T18:00:00Z'),
    participationRules: { pointRules: [{ id: 'p1' }] },
    rewardDefinition: { tiers: [{ id: 't1' }] },
  });

  const input = (): DraftWriteInput => ({
    name: 'Super Star Singing Battle',
    description: 'Show your talent and compete with other creators.',
    startTime: new Date('2026-08-25T10:00:00Z'),
    endTime: new Date('2026-08-31T18:00:00Z'),
    regStartTime: new Date('2026-08-20T10:00:00Z'),
    regEndTime: new Date('2026-08-24T18:00:00Z'),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EventDraftService(
      prisma as unknown as PrismaService,
      validation as unknown as EventValidationService,
      audit as unknown as EventAuditService,
    );
  });

  it('creates with status DRAFT, never SCHEDULED', async () => {
    prisma.eventDefinition.create.mockResolvedValue({ id: 'e1', code: 'x', status: 'DRAFT' });

    await service.createDraft(input(), ACTOR);

    const data = prisma.eventDefinition.create.mock.calls[0][0].data;
    expect(data.status).toBe('DRAFT');
    expect(data.createdBy).toBe(ACTOR);
    expect(data.agencyId).toBe(ACTOR);
  });

  it('stamps AGENCY_CAMPAIGN as the engine category', async () => {
    prisma.eventDefinition.create.mockResolvedValue({ id: 'e1', code: 'x', status: 'DRAFT' });

    await service.createDraft(input(), ACTOR);

    expect(prisma.eventDefinition.create.mock.calls[0][0].data.category).toBe('AGENCY_CAMPAIGN');
  });

  it('generates a unique slug code from the name', async () => {
    prisma.eventDefinition.create.mockResolvedValue({ id: 'e1', code: 'x', status: 'DRAFT' });

    await service.createDraft(input(), ACTOR);

    const code: string = prisma.eventDefinition.create.mock.calls[0][0].data.code;
    expect(code).toMatch(/^super-star-singing-battle-[a-z0-9]{6}$/);
  });

  it('submits a DRAFT to PENDING_APPROVAL', async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue(owned('DRAFT'));
    prisma.eventDefinition.update.mockResolvedValue({ id: 'e1', status: 'PENDING_APPROVAL' });

    const result = await service.submitForApproval('e1', ACTOR);

    expect(prisma.eventDefinition.update.mock.calls[0][0].data.status).toBe('PENDING_APPROVAL');
    expect(result.status).toBe('PENDING_APPROVAL');
  });

  it('submits a REJECTED event again after edits', async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue(owned('REJECTED'));
    prisma.eventDefinition.update.mockResolvedValue({ id: 'e1', status: 'PENDING_APPROVAL' });

    await service.submitForApproval('e1', ACTOR);

    expect(prisma.eventDefinition.update.mock.calls[0][0].data.status).toBe('PENDING_APPROVAL');
  });

  it.each(['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'])(
    'refuses to submit from %s',
    async (status) => {
      prisma.eventDefinition.findUnique.mockResolvedValue(owned(status));

      await expect(service.submitForApproval('e1', ACTOR)).rejects.toThrow(BadRequestException);
      expect(prisma.eventDefinition.update).not.toHaveBeenCalled();
    },
  );

  it('refuses to submit an event still missing required parts', async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue({
      ...owned('DRAFT'),
      banner: null,
      rewardDefinition: { tiers: [] },
    });

    await expect(service.submitForApproval('e1', ACTOR)).rejects.toThrow(BadRequestException);
    expect(prisma.eventDefinition.update).not.toHaveBeenCalled();
  });

  it("refuses to submit another agency's draft", async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue({
      ...owned('DRAFT'),
      createdBy: OTHER,
      agencyId: OTHER,
    });

    await expect(service.submitForApproval('e1', ACTOR)).rejects.toThrow(ForbiddenException);
  });

  it("refuses to edit another agency's draft", async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue({
      ...owned('DRAFT'),
      createdBy: OTHER,
      agencyId: OTHER,
    });

    await expect(service.updateDraft('e1', { name: 'Hijacked' }, ACTOR)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it.each(['PENDING_APPROVAL', 'APPROVED', 'ACTIVE'])(
    'refuses to edit once the event is %s',
    async (status) => {
      prisma.eventDefinition.findUnique.mockResolvedValue(owned(status));

      await expect(service.updateDraft('e1', { name: 'Changed' }, ACTOR)).rejects.toThrow(
        BadRequestException,
      );
    },
  );

  it("scopes listMine to the caller's agency", async () => {
    prisma.eventDefinition.findMany.mockResolvedValue([]);

    await service.listMine(ACTOR);

    expect(prisma.eventDefinition.findMany.mock.calls[0][0].where).toEqual({ agencyId: ACTOR });
  });

  it('404s on an event that does not exist', async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue(null);

    await expect(service.getMine('missing', ACTOR)).rejects.toThrow(NotFoundException);
  });

  it('deletes only a DRAFT', async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue(owned('PENDING_APPROVAL'));

    await expect(service.deleteDraft('e1', ACTOR)).rejects.toThrow(BadRequestException);
    expect(prisma.eventDefinition.delete).not.toHaveBeenCalled();
  });

  it('records an audit entry on submit', async () => {
    prisma.eventDefinition.findUnique.mockResolvedValue(owned('DRAFT'));
    prisma.eventDefinition.update.mockResolvedValue({ id: 'e1', status: 'PENDING_APPROVAL' });

    await service.submitForApproval('e1', ACTOR);

    expect(audit.logAudit).toHaveBeenCalledWith(
      'EVENT_SUBMITTED_FOR_APPROVAL',
      'e1',
      ACTOR,
      expect.any(Object),
    );
  });
});
