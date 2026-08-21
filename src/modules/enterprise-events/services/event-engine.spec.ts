import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { EventAuditService } from './event-audit.service';
import { EventConfigurationService } from './event-configuration.service';
import { EventEligibilityService } from './event-eligibility.service';
import { EventEventService } from './event-event.service';
import { EventParticipationService } from './event-participation.service';
import { EventQueryService } from './event-query.service';
import { EventRegistrationService } from './event-registration.service';
import { EventRewardService } from './event-reward.service';
import { EventSchedulerService } from './event-scheduler.service';
import { EventService } from './event.service';
import { EventStatisticsService } from './event-statistics.service';
import { EventValidationService } from './event-validation.service';

describe('Phase 16: Enterprise Events Engine', () => {
  let eventService: EventService;
  let registrationService: EventRegistrationService;
  let participationService: EventParticipationService;
  let eligibilityService: EventEligibilityService;
  let rewardService: EventRewardService;
  let schedulerService: EventSchedulerService;
  let validationService: EventValidationService;
  let _configService: EventConfigurationService;
  let statisticsService: EventStatisticsService;
  let auditService: EventAuditService;
  let _queryService: EventQueryService;

  const mockPrismaService: any = {
    user: {
      // countryId is what eligibility reads now; `country` stays only as the
      // free-text profile label.
      findUnique: jest.fn().mockResolvedValue({ id: 'user-1', country: 'US', countryId: 'c-us' }),
    },
    country: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            (where?.code?.in ?? []).includes('US') ? [{ id: 'c-us', code: 'US' }] : [],
          ),
        ),
    },
    userProfile: {
      findUnique: jest.fn().mockResolvedValue({ userId: 'user-1', country: 'US' }),
    },
    userStatistics: {
      findUnique: jest.fn().mockResolvedValue({ userId: 'user-1', level: 10, vipLevel: 2 }),
    },
    // createEvent now mirrors an event's tasks into TaskDefinition and reads
    // them back when enriching the response.
    taskDefinition: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({ id: 't-1' }),
    },
    eventDefinition: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(5),
    },
    eventRegistration: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'reg-1', status: 'REGISTERED' }),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    eventParticipant: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'part-1', status: 'PARTICIPATING' }),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    eventReward: {
      create: jest.fn().mockResolvedValue({ id: 'rew-1', dispatched: true }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    eventHistory: {
      create: jest.fn().mockResolvedValue({ id: 'hist-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    eventStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    eventAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    eventConfiguration: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const mockConfigEngine = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'event.max_participants') return Promise.resolve(1000);
      if (key === 'event.registration_duration') return Promise.resolve(24);
      if (key === 'event.default_visibility') return Promise.resolve('PUBLIC');
      return Promise.resolve(null);
    }),
  };

  const mockEventBus = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventConfigurationService,
        EventValidationService,
        EventAuditService,
        EventEventService,
        EventEligibilityService,
        EventRewardService,
        EventRegistrationService,
        EventParticipationService,
        EventSchedulerService,
        EventService,
        EventStatisticsService,
        EventQueryService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigurationEngineService, useValue: mockConfigEngine },
        { provide: EVENT_BUS, useValue: mockEventBus },
      ],
    }).compile();

    eventService = module.get<EventService>(EventService);
    registrationService = module.get<EventRegistrationService>(EventRegistrationService);
    participationService = module.get<EventParticipationService>(EventParticipationService);
    eligibilityService = module.get<EventEligibilityService>(EventEligibilityService);
    rewardService = module.get<EventRewardService>(EventRewardService);
    schedulerService = module.get<EventSchedulerService>(EventSchedulerService);
    validationService = module.get<EventValidationService>(EventValidationService);
    _configService = module.get<EventConfigurationService>(EventConfigurationService);
    statisticsService = module.get<EventStatisticsService>(EventStatisticsService);
    auditService = module.get<EventAuditService>(EventAuditService);
    _queryService = module.get<EventQueryService>(EventQueryService);

    jest.clearAllMocks();
  });

  // ─── 1. Event Definition Creation ────────────────────────────────────────

  describe('1. Event Definition Creation', () => {
    it('should create an event definition with valid parameters', async () => {
      const now = new Date();
      const start = new Date(now.getTime() + 3600000);
      const end = new Date(now.getTime() + 7200000);

      const created = {
        id: 'event-1',
        code: 'TOURNAMENT_2025',
        name: 'Grand Tournament',
        category: 'TOURNAMENT',
        status: 'SCHEDULED',
      };
      mockPrismaService.eventDefinition.create.mockResolvedValue(created);

      const result = await eventService.createEvent({
        code: 'TOURNAMENT_2025',
        name: 'Grand Tournament',
        category: 'TOURNAMENT',
        startTime: start,
        endTime: end,
      });

      expect(result.code).toBe('TOURNAMENT_2025');
      expect(mockPrismaService.eventDefinition.create).toHaveBeenCalled();
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'event.created' }),
      );
    });

    it('should throw when end time is before start time', async () => {
      const now = new Date();
      const start = new Date(now.getTime() + 7200000);
      const end = new Date(now.getTime() + 3600000);

      await expect(
        eventService.createEvent({
          code: 'BAD_TIMES',
          name: 'Invalid Times',
          category: 'TOURNAMENT',
          startTime: start,
          endTime: end,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw on invalid category', async () => {
      const now = new Date();
      await expect(
        eventService.createEvent({
          code: 'BAD_CAT',
          name: 'Invalid Category',
          category: 'INVALID_CATEGORY' as any,
          startTime: now,
          endTime: new Date(now.getTime() + 1000),
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── 2. Registration Engine ──────────────────────────────────────────────

  describe('2. Registration Engine', () => {
    it('should register user if eligible, within window, and capacity available', async () => {
      const eventDef = {
        id: 'event-1',
        status: 'REGISTRATION_OPEN',
        maxParticipants: 100,
        regStartTime: new Date(Date.now() - 3600000),
        regEndTime: new Date(Date.now() + 3600000),
        eligibilityRules: { minLevel: 5 },
      };

      mockPrismaService.eventDefinition.findUnique.mockResolvedValue(eventDef);
      mockPrismaService.eventRegistration.count.mockResolvedValue(10);
      mockPrismaService.eventRegistration.findUnique.mockResolvedValue(null);

      const reg = await registrationService.registerUser('event-1', 'user-1');

      expect(reg.id).toBe('reg-1');
      expect(mockPrismaService.eventRegistration.upsert).toHaveBeenCalled();
    });

    it('should throw if capacity is full', async () => {
      const eventDef = {
        id: 'event-1',
        status: 'REGISTRATION_OPEN',
        maxParticipants: 10,
        regStartTime: new Date(Date.now() - 3600000),
        regEndTime: new Date(Date.now() + 3600000),
      };

      mockPrismaService.eventDefinition.findUnique.mockResolvedValue(eventDef);
      mockPrismaService.eventRegistration.count.mockResolvedValue(10); // full

      await expect(registrationService.registerUser('event-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw if user is already registered', async () => {
      const eventDef = {
        id: 'event-1',
        status: 'REGISTRATION_OPEN',
        maxParticipants: 100,
        regStartTime: new Date(Date.now() - 3600000),
        regEndTime: new Date(Date.now() + 3600000),
      };

      mockPrismaService.eventDefinition.findUnique.mockResolvedValue(eventDef);
      mockPrismaService.eventRegistration.count.mockResolvedValue(5);
      mockPrismaService.eventRegistration.findUnique.mockResolvedValue({ status: 'REGISTERED' });

      await expect(registrationService.registerUser('event-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── 3. Eligibility Engine ───────────────────────────────────────────────

  describe('3. Eligibility Engine', () => {
    it('should approve user meeting all requirements', async () => {
      const eventDef = {
        id: 'event-1',
        eligibilityRules: { minLevel: 5, minVipLevel: 1, allowedCountries: ['US', 'CA'] },
      };
      mockPrismaService.eventDefinition.findUnique.mockResolvedValue(eventDef);

      const result = await eligibilityService.checkEligibility('user-1', 'event-1');

      expect(result.eligible).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('should reject user failing level or country checks', async () => {
      const eventDef = {
        id: 'event-1',
        eligibilityRules: { minLevel: 100, allowedCountries: ['UK'] },
      };
      mockPrismaService.eventDefinition.findUnique.mockResolvedValue(eventDef);

      const result = await eligibilityService.checkEligibility('user-1', 'event-1');

      expect(result.eligible).toBe(false);
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  });

  // ─── 4. Participation Engine ──────────────────────────────────────────────

  describe('4. Participation Engine', () => {
    it('should join an active event', async () => {
      mockPrismaService.eventDefinition.findUnique.mockResolvedValue({
        id: 'event-1',
        status: 'ACTIVE',
      });

      const participant = await participationService.joinEvent('event-1', 'user-1');
      expect(participant.id).toBe('part-1');
      expect(mockPrismaService.eventParticipant.upsert).toHaveBeenCalled();
    });

    it('should update participant score and mark complete', async () => {
      mockPrismaService.eventParticipant.findUnique.mockResolvedValue({
        id: 'part-1',
        score: BigInt(50),
      });

      await participationService.updateParticipantScore('event-1', 'user-1', 25);
      expect(mockPrismaService.eventParticipant.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { score: BigInt(75) } }),
      );

      await participationService.completeParticipation('event-1', 'user-1');
      expect(mockPrismaService.eventParticipant.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
      );
    });

    it('should disqualify participant', async () => {
      mockPrismaService.eventParticipant.findUnique.mockResolvedValue({ id: 'part-1' });

      await participationService.disqualifyParticipant('event-1', 'user-1', 'Rule violation');
      expect(mockPrismaService.eventParticipant.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'DISQUALIFIED' }) }),
      );
    });
  });

  // ─── 5. Scheduler Service ────────────────────────────────────────────────

  describe('5. Scheduler Service', () => {
    it('should transition events into REGISTRATION_OPEN, ACTIVE, COMPLETED based on time windows', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 3600000);
      const future = new Date(now.getTime() + 3600000);

      // Event 1 needs reg open
      mockPrismaService.eventDefinition.findMany.mockResolvedValueOnce([
        { id: 'ev-1', status: 'SCHEDULED', regStartTime: past, regEndTime: future },
      ]);
      // Event 2 needs reg close
      mockPrismaService.eventDefinition.findMany.mockResolvedValueOnce([]);
      // Event 3 needs active
      mockPrismaService.eventDefinition.findMany.mockResolvedValueOnce([
        { id: 'ev-3', status: 'SCHEDULED', startTime: past, endTime: future },
      ]);
      // Event 4 needs completed
      mockPrismaService.eventDefinition.findMany.mockResolvedValueOnce([
        { id: 'ev-4', status: 'ACTIVE', endTime: past },
      ]);

      const result = await schedulerService.processEventSchedules();

      expect(result.registrationOpened).toBe(1);
      expect(result.started).toBe(1);
      expect(result.completed).toBe(1);
    });
  });

  // ─── 6. Reward Service ────────────────────────────────────────────────────

  describe('6. Reward Service', () => {
    it('should dispatch reward and publish event without touching wallet', async () => {
      mockPrismaService.eventDefinition.findUnique.mockResolvedValue({
        id: 'event-1',
        rewardDefinition: { type: 'COINS', amount: 500 },
      });

      const reward = await rewardService.dispatchReward('event-1', 'user-1');

      expect(reward.dispatched).toBe(true);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'event.reward.dispatched' }),
      );
    });
  });

  // ─── 7. Validation & Audit Services ──────────────────────────────────────

  describe('7. Validation & Audit Services', () => {
    it('should throw NotFoundException for missing event', async () => {
      mockPrismaService.eventDefinition.findUnique.mockResolvedValue(null);
      await expect(validationService.validateEventExists('missing-event')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should write audit log entries', async () => {
      await auditService.logAudit('EVENT_CREATED', 'event-1', 'admin-1', { code: 'TEST' });
      expect(mockPrismaService.eventAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'EVENT_CREATED' }),
        }),
      );
    });

    it('should return platform summary stats', async () => {
      const summary = await statisticsService.getPlatformSummary();
      expect(summary.activeEvents).toBe(5);
    });
  });
});
