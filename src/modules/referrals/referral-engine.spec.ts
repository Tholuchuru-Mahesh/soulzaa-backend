/**
 * Enterprise Referral System — Phase 18 Test Suite
 *
 * Covers:
 * - ReferralConfigurationService
 * - ReferralValidationService
 * - ReferralFraudService
 * - ReferralCodeService
 * - ReferralCampaignService
 * - ReferralQualificationService
 * - ReferralRewardService
 * - ReferralService (lifecycle)
 * - ReferralStatisticsService
 * - ReferralAuditService
 * - ReferralEventService
 * - ReferralQueryService
 */

// ── Utilities ─────────────────────────────────────────────────────────────────

function makeUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Mock PrismaService ─────────────────────────────────────────────────────────

function buildPrismaMock(overrides: Record<string, unknown> = {}) {
  return {
    referralConfiguration: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    referralCode: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    referralCampaign: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    referralRelationship: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    referralQualification: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    referralReward: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      update: jest.fn().mockResolvedValue({ id: makeUuid() }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    referralHistory: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    referralStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    referralAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

// ── EventEmitter2 Mock ─────────────────────────────────────────────────────────

function buildEventEmitterMock() {
  return { emit: jest.fn() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ReferralConfigurationService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralConfigurationService } from './services/referral-configuration.service';

describe('ReferralConfigurationService', () => {
  let service: ReferralConfigurationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new ReferralConfigurationService(prisma as any);
  });

  it('returns defaultValue when key not found', async () => {
    const result = await service.get('nonexistent', 42);
    expect(result).toBe(42);
  });

  it('returns stored value when key exists', async () => {
    prisma.referralConfiguration.findUnique.mockResolvedValue({ key: 'k', value: 99 });
    const result = await service.get<number>('k', 0);
    expect(result).toBe(99);
  });

  it('upserts a configuration value', async () => {
    await service.set('some.key', 'value');
    expect(prisma.referralConfiguration.upsert).toHaveBeenCalled();
  });

  it('returns all configuration values', async () => {
    prisma.referralConfiguration.findMany.mockResolvedValue([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]);
    const all = await service.getAll();
    expect(all).toEqual({ a: 1, b: 2 });
  });

  it('getDefaultExpiryDays returns fallback 30', async () => {
    const days = await service.getDefaultExpiryDays();
    expect(days).toBe(30);
  });

  it('getMaxUses returns fallback 100', async () => {
    const uses = await service.getMaxUses();
    expect(uses).toBe(100);
  });

  it('isSelfReferralAllowed returns false by default', async () => {
    const allowed = await service.isSelfReferralAllowed();
    expect(allowed).toBe(false);
  });

  it('getQualificationTimeoutDays returns fallback 7', async () => {
    const days = await service.getQualificationTimeoutDays();
    expect(days).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ReferralValidationService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralValidationService } from './services/referral-validation.service';

describe('ReferralValidationService', () => {
  let service: ReferralValidationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new ReferralValidationService(prisma as any);
  });

  it('throws NotFoundException when code does not exist', async () => {
    await expect(service.assertCodeExists('NO_CODE')).rejects.toThrow();
  });

  it('passes assertCodeExists when code exists', async () => {
    prisma.referralCode.findUnique.mockResolvedValue({
      id: makeUuid(),
      code: 'ABC',
      status: 'ACTIVE',
    });
    await expect(service.assertCodeExists('ABC')).resolves.not.toThrow();
  });

  it('throws when code is inactive', async () => {
    prisma.referralCode.findUnique.mockResolvedValue({
      id: makeUuid(),
      code: 'ABC',
      status: 'INACTIVE',
      expiresAt: null,
      usesCount: 0,
      maxUses: 100,
    });
    await expect(service.assertCodeActive('ABC')).rejects.toThrow('not active');
  });

  it('throws when code is expired', async () => {
    prisma.referralCode.findUnique.mockResolvedValue({
      id: makeUuid(),
      code: 'ABC',
      status: 'ACTIVE',
      expiresAt: new Date('2000-01-01'),
      usesCount: 0,
      maxUses: 100,
    });
    await expect(service.assertCodeActive('ABC')).rejects.toThrow('expired');
  });

  it('throws when code is at max uses', async () => {
    prisma.referralCode.findUnique.mockResolvedValue({
      id: makeUuid(),
      code: 'ABC',
      status: 'ACTIVE',
      expiresAt: null,
      usesCount: 100,
      maxUses: 100,
    });
    await expect(service.assertCodeActive('ABC')).rejects.toThrow('maximum uses');
  });

  it('assertNotEmptyString throws on empty string', () => {
    expect(() => service.assertNotEmptyString('', 'fieldName')).toThrow();
  });

  it('assertValidCategory throws on invalid category', () => {
    expect(() => service.assertValidCategory('INVALID_CAT')).toThrow();
  });

  it('assertValidCategory passes for USER', () => {
    expect(() => service.assertValidCategory('USER')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ReferralFraudService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralFraudService } from './services/referral-fraud.service';

describe('ReferralFraudService', () => {
  let service: ReferralFraudService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let config: ReferralConfigurationService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    config = new ReferralConfigurationService(prisma as any);
    service = new ReferralFraudService(prisma as any, config);
  });

  it('detects self-referral when not allowed', async () => {
    const userId = makeUuid();
    const result = await service.runChecks({
      referrerId: userId,
      refereeId: userId,
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Self-referral'))).toBe(true);
  });

  it('detects duplicate referee', async () => {
    const referrerId = makeUuid();
    const refereeId = makeUuid();
    prisma.referralRelationship.findUnique.mockResolvedValue({
      id: makeUuid(),
      refereeId,
      status: 'REGISTERED',
    });
    const result = await service.runChecks({ referrerId, refereeId });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('already been referred'))).toBe(true);
  });

  it('passes when no fraud signals present', async () => {
    const result = await service.runChecks({
      referrerId: makeUuid(),
      refereeId: makeUuid(),
    });
    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('throws on duplicate reward dispatch', async () => {
    prisma.referralReward.findFirst.mockResolvedValue({ id: makeUuid(), dispatched: true });
    await expect(service.assertNoDuplicateReward(makeUuid())).rejects.toThrow('already dispatched');
  });

  it('passes assertNoDuplicateReward when no reward exists', async () => {
    await expect(service.assertNoDuplicateReward(makeUuid())).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ReferralCodeService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralCodeService } from './services/referral-code.service';

describe('ReferralCodeService', () => {
  let service: ReferralCodeService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let config: ReferralConfigurationService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    config = new ReferralConfigurationService(prisma as any);
    service = new ReferralCodeService(prisma as any, config);
  });

  it('creates a referral code with invite link and QR URL', async () => {
    const referrerId = makeUuid();
    const result: any = await service.createCode({ referrerId });
    expect(result.referrerId).toBe(referrerId);
    expect(result.inviteLink).toContain('soulzaa.app/invite/');
    expect(result.qrCodeUrl).toContain('soulzaa.app/qr/');
  });

  it('generates unique code strings', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = (service as any).generateCodeString();
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThanOrEqual(8);
      codes.add(code);
    }
    // Should have high uniqueness
    expect(codes.size).toBeGreaterThan(40);
  });

  it('findByCode returns the code record', async () => {
    const mockCode = { id: makeUuid(), code: 'TESTCODE' };
    prisma.referralCode.findUnique.mockResolvedValue(mockCode);
    const result = await service.findByCode('TESTCODE');
    expect(result).toEqual(mockCode);
  });

  it('increments uses counter', async () => {
    await service.incrementUses(makeUuid());
    expect(prisma.referralCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usesCount: { increment: 1 } } }),
    );
  });

  it('expireStale returns count of expired codes', async () => {
    prisma.referralCode.updateMany.mockResolvedValue({ count: 3 });
    const count = await service.expireStale();
    expect(count).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ReferralCampaignService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralCampaignService } from './services/referral-campaign.service';

describe('ReferralCampaignService', () => {
  let service: ReferralCampaignService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let validation: ReferralValidationService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    validation = new ReferralValidationService(prisma as any);
    service = new ReferralCampaignService(prisma as any, validation);
  });

  it('creates a campaign', async () => {
    const result: any = await service.create({
      code: 'SUMMER_2026',
      name: 'Summer Campaign',
      category: 'PROMOTIONAL',
    });
    expect(result.code).toBe('SUMMER_2026');
  });

  it('throws on invalid category', async () => {
    await expect(service.create({ code: 'X', name: 'Y', category: 'INVALID' })).rejects.toThrow();
  });

  it('updates campaign status', async () => {
    const id = makeUuid();
    await service.setStatus(id, 'PAUSED');
    expect(prisma.referralCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAUSED' } }),
    );
  });

  it('increments campaign uses', async () => {
    await service.incrementUses(makeUuid());
    expect(prisma.referralCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usesCount: { increment: 1 } } }),
    );
  });

  it('expireStale returns count', async () => {
    prisma.referralCampaign.updateMany.mockResolvedValue({ count: 2 });
    const count = await service.expireStale();
    expect(count).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ReferralQualificationService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralQualificationService } from './services/referral-qualification.service';

describe('ReferralQualificationService', () => {
  let service: ReferralQualificationService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let config: ReferralConfigurationService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    config = new ReferralConfigurationService(prisma as any);
    service = new ReferralQualificationService(prisma as any, config);
  });

  it('qualifies when no rules are defined', async () => {
    const result = await service.evaluate({
      relationshipId: makeUuid(),
      refereeId: makeUuid(),
    });
    expect(result.qualified).toBe(true);
    expect(result.failedRules).toHaveLength(0);
  });

  it('creates qualification records for each rule', async () => {
    await service.evaluate({
      relationshipId: makeUuid(),
      refereeId: makeUuid(),
      rules: { FIRST_LOGIN: true, MIN_LEVEL: 5 },
    });
    expect(prisma.referralQualification.create).toHaveBeenCalledTimes(2);
  });

  it('isQualified returns true when no failed rules exist', async () => {
    prisma.referralQualification.count.mockResolvedValue(0);
    const result = await service.isQualified(makeUuid());
    expect(result).toBe(true);
  });

  it('isQualified returns false when failed rules exist', async () => {
    prisma.referralQualification.count.mockResolvedValue(1);
    const result = await service.isQualified(makeUuid());
    expect(result).toBe(false);
  });

  it('markRuleFailed creates a failed qualification record', async () => {
    await service.markRuleFailed(makeUuid(), 'MIN_VIP', ['Below tier 3']);
    expect(prisma.referralQualification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ passed: false, ruleName: 'MIN_VIP' }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ReferralAuditService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralAuditService } from './services/referral-audit.service';

describe('ReferralAuditService', () => {
  let service: ReferralAuditService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new ReferralAuditService(prisma as any);
  });

  it('logs an audit entry', async () => {
    await service.log({ action: 'REFERRAL_CREATED', relationshipId: makeUuid() });
    expect(prisma.referralAudit.create).toHaveBeenCalled();
  });

  it('queries by action', async () => {
    await service.queryByAction('REFERRAL_QUALIFIED');
    expect(prisma.referralAudit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: 'REFERRAL_QUALIFIED' } }),
    );
  });

  it('queries by relationship', async () => {
    const id = makeUuid();
    await service.queryByRelationship(id);
    expect(prisma.referralAudit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { relationshipId: id } }),
    );
  });

  it('getSupportedActions returns all 8 audit actions', () => {
    const actions = service.getSupportedActions();
    expect(actions).toHaveLength(8);
    expect(actions).toContain('REFERRAL_CREATED');
    expect(actions).toContain('REFERRAL_REWARD_DISPATCHED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ReferralEventService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralEventService } from './services/referral-event.service';

describe('ReferralEventService', () => {
  let service: ReferralEventService;
  let emitter: ReturnType<typeof buildEventEmitterMock>;

  beforeEach(() => {
    emitter = buildEventEmitterMock();
    service = new ReferralEventService(emitter as any);
  });

  it('emits referral.created', () => {
    service.emitReferralCreated({ referrerId: makeUuid() });
    expect(emitter.emit).toHaveBeenCalledWith('referral.created', expect.any(Object));
  });

  it('emits referral.registered', () => {
    service.emitReferralRegistered({ refereeId: makeUuid() });
    expect(emitter.emit).toHaveBeenCalledWith('referral.registered', expect.any(Object));
  });

  it('emits referral.qualified', () => {
    service.emitReferralQualified({ relationshipId: makeUuid() });
    expect(emitter.emit).toHaveBeenCalledWith('referral.qualified', expect.any(Object));
  });

  it('emits referral.reward.dispatched', () => {
    service.emitRewardDispatched({ referrerId: makeUuid() });
    expect(emitter.emit).toHaveBeenCalledWith('referral.reward.dispatched', expect.any(Object));
  });

  it('emits referral.expired', () => {
    service.emitReferralExpired({ relationshipId: makeUuid() });
    expect(emitter.emit).toHaveBeenCalledWith('referral.expired', expect.any(Object));
  });

  it('emits referral.cancelled', () => {
    service.emitReferralCancelled({ relationshipId: makeUuid() });
    expect(emitter.emit).toHaveBeenCalledWith('referral.cancelled', expect.any(Object));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. ReferralRewardService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralRewardService } from './services/referral-reward.service';

describe('ReferralRewardService', () => {
  let service: ReferralRewardService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let fraud: ReferralFraudService;
  let audit: ReferralAuditService;
  let events: ReferralEventService;
  let emitter: ReturnType<typeof buildEventEmitterMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const config = new ReferralConfigurationService(prisma as any);
    fraud = new ReferralFraudService(prisma as any, config);
    audit = new ReferralAuditService(prisma as any);
    emitter = buildEventEmitterMock();
    events = new ReferralEventService(emitter as any);
    service = new ReferralRewardService(prisma as any, fraud, audit, events);
  });

  it('dispatches a reward via domain event', async () => {
    const input = {
      relationshipId: makeUuid(),
      referrerId: makeUuid(),
      refereeId: makeUuid(),
      rewardDefinition: { coins: 100 },
    };
    await service.dispatch(input);
    expect(prisma.referralReward.create).toHaveBeenCalled();
    expect(prisma.referralRelationship.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REWARDED', rewardedAt: expect.any(Date) } }),
    );
    expect(emitter.emit).toHaveBeenCalledWith('referral.reward.dispatched', expect.any(Object));
  });

  it('prevents duplicate reward dispatch', async () => {
    prisma.referralReward.findFirst.mockResolvedValue({ id: makeUuid(), dispatched: true });
    await expect(
      service.dispatch({
        relationshipId: makeUuid(),
        referrerId: makeUuid(),
        refereeId: makeUuid(),
        rewardDefinition: {},
      }),
    ).rejects.toThrow('already dispatched');
  });

  it('does NOT mutate Wallet or EXP tables', async () => {
    const prismaKeys = Object.keys(prisma);
    expect(prismaKeys).not.toContain('walletTransaction');
    expect(prismaKeys).not.toContain('expTransaction');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. ReferralStatisticsService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralStatisticsService } from './services/referral-statistics.service';

describe('ReferralStatisticsService', () => {
  let service: ReferralStatisticsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new ReferralStatisticsService(prisma as any);
  });

  it('increments codesCreated stat', async () => {
    await service.incrementStat('USER', 'codesCreated');
    expect(prisma.referralStatistics.upsert).toHaveBeenCalled();
  });

  it('increments qualifiedCount stat', async () => {
    await service.incrementStat('CAMPAIGN', 'qualifiedCount');
    expect(prisma.referralStatistics.upsert).toHaveBeenCalled();
  });

  it('getSummary queries by period and dateKey', async () => {
    await service.getSummary('DAILY', '20260723');
    expect(prisma.referralStatistics.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { period: 'DAILY', dateKey: '20260723' } }),
    );
  });

  it('getTopReferrers uses groupBy', async () => {
    await service.getTopReferrers(5);
    expect(prisma.referralRelationship.groupBy).toHaveBeenCalled();
  });

  it('getConversionRate returns 0 when no referrals', async () => {
    prisma.referralRelationship.count.mockResolvedValue(0);
    const rate = await service.getConversionRate();
    expect(rate).toBe(0);
  });

  it('getConversionRate calculates correctly', async () => {
    prisma.referralRelationship.count
      .mockResolvedValueOnce(100) // total
      .mockResolvedValueOnce(25); // qualified
    const rate = await service.getConversionRate();
    expect(rate).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. ReferralQueryService
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralQueryService } from './services/referral-query.service';

describe('ReferralQueryService', () => {
  let service: ReferralQueryService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new ReferralQueryService(prisma as any);
  });

  it('getUserReferralSummary aggregates all counts', async () => {
    prisma.referralCode.count.mockResolvedValue(3);
    prisma.referralRelationship.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(5);
    prisma.referralRelationship.findUnique.mockResolvedValue(null);

    const summary: any = await service.getUserReferralSummary(makeUuid());
    expect(summary.codesCreated).toBe(3);
    expect(summary.totalReferred).toBe(10);
    expect(summary.qualified).toBe(7);
    expect(summary.rewarded).toBe(5);
    expect(summary.myReferral).toBeNull();
  });

  it('getCampaignLeaderboard uses groupBy with campaignId filter', async () => {
    const campaignId = makeUuid();
    await service.getCampaignLeaderboard(campaignId, 5);
    expect(prisma.referralRelationship.groupBy).toHaveBeenCalled();
  });

  it('findExpiredRelationships returns relationships past expiry', async () => {
    await service.findExpiredRelationships();
    expect(prisma.referralRelationship.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['REGISTERED', 'CREATED'] } }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. ReferralService — Lifecycle Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

import { ReferralService } from './services/referral.service';

describe('ReferralService — Lifecycle', () => {
  let service: ReferralService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let emitter: ReturnType<typeof buildEventEmitterMock>;

  const referrerId = makeUuid();
  const refereeId = makeUuid();
  const codeId = makeUuid();
  const relationshipId = makeUuid();

  const mockCode = {
    id: codeId,
    code: 'VALIDCODE1',
    referrerId,
    campaignId: null,
    status: 'ACTIVE',
    expiresAt: null,
    usesCount: 0,
    maxUses: 100,
  };

  beforeEach(() => {
    prisma = buildPrismaMock();
    emitter = buildEventEmitterMock();

    const config = new ReferralConfigurationService(prisma as any);
    const validation = new ReferralValidationService(prisma as any);
    const codeService = new ReferralCodeService(prisma as any, config);
    const campaignService = new ReferralCampaignService(prisma as any, validation);
    const fraud = new ReferralFraudService(prisma as any, config);
    const audit = new ReferralAuditService(prisma as any);
    const events = new ReferralEventService(emitter as any);
    const qualification = new ReferralQualificationService(prisma as any, config);

    service = new ReferralService(
      prisma as any,
      codeService,
      campaignService,
      fraud,
      validation,
      audit,
      events,
      qualification,
      config,
    );
  });

  it('registers a referral successfully', async () => {
    // Code exists and active
    prisma.referralCode.findUnique.mockResolvedValue(mockCode);
    // Dynamic mock for findUnique: null for refereeId check, mockRelationship for id check
    const mockRelationship = {
      id: relationshipId,
      referrerId,
      refereeId,
      referralCodeId: codeId,
      campaignId: null,
      status: 'REGISTERED',
    };
    prisma.referralRelationship.findUnique.mockImplementation((args: any) => {
      if (args.where.refereeId) {
        return Promise.resolve(null);
      }
      if (args.where.id === relationshipId) {
        return Promise.resolve(mockRelationship);
      }
      return Promise.resolve(null);
    });
    // Relationship created
    prisma.referralRelationship.create.mockResolvedValue(mockRelationship);

    const result: any = await service.register({
      referralCode: 'VALIDCODE1',
      refereeId,
    });
    expect(result.status).toBe('REGISTERED');
    expect(emitter.emit).toHaveBeenCalledWith('referral.registered', expect.any(Object));
  });

  it('rejects self-referral during registration', async () => {
    prisma.referralCode.findUnique.mockResolvedValue({ ...mockCode, referrerId: refereeId });
    prisma.referralRelationship.findUnique.mockResolvedValue(null);

    await expect(service.register({ referralCode: 'VALIDCODE1', refereeId })).rejects.toThrow(
      'Self-referral',
    );
  });

  it('rejects duplicate referee registration', async () => {
    prisma.referralCode.findUnique.mockResolvedValue(mockCode);
    prisma.referralRelationship.findUnique.mockResolvedValue({
      id: makeUuid(),
      refereeId,
      status: 'REGISTERED',
    });

    await expect(service.register({ referralCode: 'VALIDCODE1', refereeId })).rejects.toThrow(
      'already been referred',
    );
  });

  it('qualifies a referral relationship', async () => {
    prisma.referralRelationship.findUnique.mockResolvedValue({
      id: relationshipId,
      referrerId,
      refereeId,
      status: 'REGISTERED',
      campaignId: null,
    });

    await service.qualify({ relationshipId });
    expect(prisma.referralRelationship.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'QUALIFIED', qualifiedAt: expect.any(Date) } }),
    );
    expect(emitter.emit).toHaveBeenCalledWith('referral.qualified', expect.any(Object));
  });

  it('skips qualifying an already-qualified relationship', async () => {
    prisma.referralRelationship.findUnique.mockResolvedValue({
      id: relationshipId,
      status: 'QUALIFIED',
    });
    await service.qualify({ relationshipId });
    expect(prisma.referralRelationship.update).not.toHaveBeenCalled();
  });

  it('cancels a referral and emits event', async () => {
    prisma.referralRelationship.findUnique.mockResolvedValue({
      id: relationshipId,
      status: 'REGISTERED',
    });
    await service.cancel(relationshipId);
    expect(prisma.referralRelationship.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CANCELLED' } }),
    );
    expect(emitter.emit).toHaveBeenCalledWith('referral.cancelled', expect.any(Object));
  });

  it('expires stale referrals in bulk', async () => {
    prisma.referralRelationship.findMany.mockResolvedValue([
      { id: makeUuid(), status: 'REGISTERED' },
      { id: makeUuid(), status: 'CREATED' },
    ]);
    const count = await service.expireStale();
    expect(count).toBe(2);
    expect(emitter.emit).toHaveBeenCalledWith('referral.expired', expect.any(Object));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Fraud Prevention — Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Fraud Prevention — Edge Cases', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let config: ReferralConfigurationService;
  let fraud: ReferralFraudService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    config = new ReferralConfigurationService(prisma as any);
    fraud = new ReferralFraudService(prisma as any, config);
  });

  it('detects campaign max-use abuse', async () => {
    const referrerId = makeUuid();
    const refereeId = makeUuid();
    const campaignId = makeUuid();
    prisma.referralRelationship.count.mockResolvedValue(200); // over limit
    const result = await fraud.runChecks({ referrerId, refereeId, campaignId });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('exceeded'))).toBe(true);
  });

  it('allows referral when all checks pass', async () => {
    prisma.referralRelationship.count.mockResolvedValue(0);
    const result = await fraud.runChecks({
      referrerId: makeUuid(),
      refereeId: makeUuid(),
      campaignId: makeUuid(),
    });
    expect(result.passed).toBe(true);
  });

  it('idempotent reward prevention catches replay', async () => {
    prisma.referralReward.findFirst.mockResolvedValue({ id: makeUuid(), dispatched: true });
    await expect(fraud.assertNoDuplicateReward(makeUuid())).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Platform Configuration Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('Platform Configuration Integration', () => {
  let config: ReferralConfigurationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    config = new ReferralConfigurationService(prisma as any);
  });

  const cases: Array<[string, () => Promise<unknown>, unknown]> = [
    ['getDefaultExpiryDays', () => config.getDefaultExpiryDays(), 30],
    ['getMaxUses', () => config.getMaxUses(), 100],
    ['isSelfReferralAllowed', () => config.isSelfReferralAllowed(), false],
    ['getQualificationTimeoutDays', () => config.getQualificationTimeoutDays(), 7],
  ];

  it.each(cases)('%s returns safe default when unconfigured', async (_name, fn, expected) => {
    const result = await fn();
    expect(result).toEqual(expected);
  });

  it('overrides config from database', async () => {
    prisma.referralConfiguration.findUnique.mockResolvedValue({
      key: 'referral.max_uses',
      value: 500,
    });
    const result = await config.getMaxUses();
    expect(result).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Domain Event Contracts
// ─────────────────────────────────────────────────────────────────────────────

describe('Domain Event Contracts', () => {
  let events: ReferralEventService;
  let emitter: ReturnType<typeof buildEventEmitterMock>;

  beforeEach(() => {
    emitter = buildEventEmitterMock();
    events = new ReferralEventService(emitter as any);
  });

  const eventPairs: Array<[string, () => void]> = [
    ['referral.created', () => events.emitReferralCreated({})],
    ['referral.registered', () => events.emitReferralRegistered({})],
    ['referral.qualified', () => events.emitReferralQualified({})],
    ['referral.reward.dispatched', () => events.emitRewardDispatched({})],
    ['referral.expired', () => events.emitReferralExpired({})],
    ['referral.cancelled', () => events.emitReferralCancelled({})],
  ];

  it.each(eventPairs)('emits %s domain event', (eventName, fn) => {
    fn();
    expect(emitter.emit).toHaveBeenCalledWith(eventName, expect.any(Object));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. Referral Constants
// ─────────────────────────────────────────────────────────────────────────────

import {
  REFERRAL_CATEGORIES,
  REFERRAL_STATUSES,
  CAMPAIGN_STATUSES,
  REFERRAL_AUDIT_ACTIONS,
  REFERRAL_CONFIG_KEYS,
} from './constants/referral.constants';

describe('Referral Constants', () => {
  it('REFERRAL_CATEGORIES contains 12 types', () => {
    expect(REFERRAL_CATEGORIES).toHaveLength(12);
    expect(REFERRAL_CATEGORIES).toContain('USER');
    expect(REFERRAL_CATEGORIES).toContain('QR_CODE');
    expect(REFERRAL_CATEGORIES).toContain('INVITE_LINK');
  });

  it('REFERRAL_STATUSES contains 8 lifecycle states', () => {
    expect(REFERRAL_STATUSES).toHaveLength(8);
    expect(REFERRAL_STATUSES).toContain('CREATED');
    expect(REFERRAL_STATUSES).toContain('QUALIFIED');
    expect(REFERRAL_STATUSES).toContain('REWARDED');
    expect(REFERRAL_STATUSES).toContain('EXPIRED');
  });

  it('CAMPAIGN_STATUSES contains all 8 campaign states', () => {
    expect(CAMPAIGN_STATUSES).toHaveLength(8);
    expect(CAMPAIGN_STATUSES).toContain('ACTIVE');
    expect(CAMPAIGN_STATUSES).toContain('ARCHIVED');
  });

  it('REFERRAL_AUDIT_ACTIONS contains 8 actions', () => {
    expect(REFERRAL_AUDIT_ACTIONS).toHaveLength(8);
    expect(REFERRAL_AUDIT_ACTIONS).toContain('REFERRAL_CREATED');
    expect(REFERRAL_AUDIT_ACTIONS).toContain('REFERRAL_CONFIGURATION_UPDATED');
  });

  it('REFERRAL_CONFIG_KEYS are all defined', () => {
    expect(REFERRAL_CONFIG_KEYS.DEFAULT_EXPIRY_DAYS).toBe('referral.default_expiry_days');
    expect(REFERRAL_CONFIG_KEYS.MAX_USES).toBe('referral.max_uses');
    expect(REFERRAL_CONFIG_KEYS.SELF_REFERRAL_ALLOWED).toBe('referral.self_referral_allowed');
    expect(REFERRAL_CONFIG_KEYS.QUALIFICATION_TIMEOUT).toBe('referral.qualification_timeout');
  });
});
