import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { FamilyAuditService } from './family-audit.service';
import { FamilyConfigurationService } from './family-configuration.service';
import { FamilyEventService } from './family-event.service';
import { FamilyHistoryService } from './family-history.service';
import { FamilyInvitationService } from './family-invitation.service';
import { FamilyMemberService } from './family-member.service';
import { FamilyPermissionService } from './family-permission.service';
import { FamilyQueryService } from './family-query.service';
import { FamilyRequestService } from './family-request.service';
import { FamilyRoleService } from './family-role.service';
import { FamilyStatisticsService } from './family-statistics.service';
import { FamilyValidationService } from './family-validation.service';
import { FamilyService } from './family.service';

describe('Phase 11: Enterprise Family System', () => {
  let configService: FamilyConfigurationService;
  let validationService: FamilyValidationService;
  let permissionService: FamilyPermissionService;
  let roleService: FamilyRoleService;
  let memberService: FamilyMemberService;
  let invitationService: FamilyInvitationService;
  let requestService: FamilyRequestService;
  let familyService: FamilyService;
  let historyService: FamilyHistoryService;
  let auditService: FamilyAuditService;
  let statisticsService: FamilyStatisticsService;
  let queryService: FamilyQueryService;
  let eventService: FamilyEventService;

  const mockPrismaService: any = {
    family: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    familyMember: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    familyRole: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    familyInvitation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    familyJoinRequest: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    familyBan: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    familyHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    familyAudit: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    familyStatistics: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    familyConfiguration: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg(mockPrismaService);
      }
      return Promise.all(arg);
    }),
  };

  const mockPlatformConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'family.max_members') return Promise.resolve(100);
      if (key === 'family.creation_cost') return Promise.resolve(1000);
      return Promise.resolve(null);
    }),
  };

  const mockEventBus = {
    subscribe: jest.fn(),
    publish: jest.fn(),
  };

  const mockLockService = {
    withLock: jest.fn().mockImplementation((_key: string, fn: Function) => fn()),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyConfigurationService,
        FamilyValidationService,
        FamilyPermissionService,
        FamilyRoleService,
        FamilyMemberService,
        FamilyInvitationService,
        FamilyRequestService,
        FamilyService,
        FamilyHistoryService,
        FamilyAuditService,
        FamilyStatisticsService,
        FamilyQueryService,
        FamilyEventService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockPlatformConfigService },
        { provide: EVENT_BUS, useValue: mockEventBus },
        { provide: LockService, useValue: mockLockService },
      ],
    }).compile();

    configService = module.get<FamilyConfigurationService>(FamilyConfigurationService);
    validationService = module.get<FamilyValidationService>(FamilyValidationService);
    permissionService = module.get<FamilyPermissionService>(FamilyPermissionService);
    roleService = module.get<FamilyRoleService>(FamilyRoleService);
    memberService = module.get<FamilyMemberService>(FamilyMemberService);
    invitationService = module.get<FamilyInvitationService>(FamilyInvitationService);
    requestService = module.get<FamilyRequestService>(FamilyRequestService);
    familyService = module.get<FamilyService>(FamilyService);
    historyService = module.get<FamilyHistoryService>(FamilyHistoryService);
    auditService = module.get<FamilyAuditService>(FamilyAuditService);
    statisticsService = module.get<FamilyStatisticsService>(FamilyStatisticsService);
    queryService = module.get<FamilyQueryService>(FamilyQueryService);
    eventService = module.get<FamilyEventService>(FamilyEventService);

    jest.clearAllMocks();
  });

  describe('1. Family Creation & Founder Role', () => {
    it('should create family and assign founder role to founderId', async () => {
      mockPrismaService.family.findUnique.mockResolvedValue(null);
      mockPrismaService.familyMember.findUnique.mockResolvedValue(null);
      mockPrismaService.family.create.mockResolvedValue({
        id: 'family-100',
        name: 'Soulzaa Warriors',
        tag: 'WAR',
        founderId: 'user-founder',
        status: 'ACTIVE',
        exp: BigInt(0),
        coins: BigInt(0),
        score: BigInt(0),
        reputation: BigInt(0),
      });
      mockPrismaService.familyMember.create.mockResolvedValue({
        id: 'mem-founder',
        role: 'FOUNDER',
      });
      mockPrismaService.familyHistory.create.mockResolvedValue({});
      mockPrismaService.familyStatistics.upsert.mockResolvedValue({});
      mockPrismaService.familyAudit.create.mockResolvedValue({});

      const result = await familyService.createFamily({
        founderId: 'user-founder',
        name: 'Soulzaa Warriors',
        tag: 'WAR',
      });

      expect(result.id).toBe('family-100');
      expect(result.founderId).toBe('user-founder');
      expect(mockPrismaService.familyMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          familyId: 'family-100',
          userId: 'user-founder',
          role: 'FOUNDER',
        }),
      });
    });

    it('should reject family creation if user already belongs to a family', async () => {
      mockPrismaService.family.findUnique.mockResolvedValue(null);
      mockPrismaService.familyMember.findUnique.mockResolvedValue({
        id: 'mem-existing',
        familyId: 'family-other',
      });

      await expect(
        familyService.createFamily({
          founderId: 'user-existing',
          name: 'New Family',
          tag: 'NEW',
        }),
      ).rejects.toThrow('already a member of another family');
    });
  });

  describe('2. Role Hierarchy & Permission Rules', () => {
    it('should prevent ELDER from promoting or changing CO_FOUNDER role', async () => {
      mockPrismaService.familyMember.findFirst
        .mockResolvedValueOnce({ id: 'mem-elder', role: 'ELDER' }) // actor
        .mockResolvedValueOnce({ id: 'mem-cofounder', role: 'CO_FOUNDER' }); // target

      await expect(
        roleService.changeMemberRole({
          familyId: 'family-100',
          actorUserId: 'user-elder',
          targetUserId: 'user-cofounder',
          newRole: 'MEMBER',
        }),
      ).rejects.toThrow('cannot manage target role');
    });
  });

  describe('3. Ownership Transfer Engine', () => {
    it('should transfer ownership from FOUNDER to target and make former founder CO_FOUNDER', async () => {
      mockPrismaService.familyMember.findFirst
        .mockResolvedValueOnce({ id: 'mem-founder', role: 'FOUNDER' })
        .mockResolvedValueOnce({ id: 'mem-target', role: 'CO_FOUNDER' });
      mockPrismaService.family.update.mockResolvedValue({});
      mockPrismaService.familyMember.update.mockResolvedValue({});
      mockPrismaService.familyHistory.create.mockResolvedValue({});
      mockPrismaService.familyAudit.create.mockResolvedValue({});

      const result = await familyService.transferOwnership(
        'family-100',
        'user-founder',
        'user-newfounder',
      );
      expect(result.status).toBe('TRANSFERRED');
      expect(result.newFounderId).toBe('user-newfounder');
    });
  });

  describe('4. Member Kick & Ban Logic', () => {
    it('should prevent banning the family founder', async () => {
      mockPrismaService.familyMember.findFirst
        .mockResolvedValueOnce({ id: 'mem-admin', role: 'CO_FOUNDER' })
        .mockResolvedValueOnce({ id: 'mem-founder', role: 'FOUNDER' });

      await expect(
        memberService.banMember({
          familyId: 'family-100',
          actorUserId: 'user-cofounder',
          targetUserId: 'user-founder',
        }),
      ).rejects.toThrow('Cannot ban the family founder');
    });
  });
});
