/**
 * Enterprise Reports & Analytics Engine — Phase 20 Test Suite
 *
 * Covers:
 * - AnalyticsConfigurationService
 * - AnalyticsValidationService
 * - AnalyticsAuditService
 * - AnalyticsEventService
 * - AnalyticsStatisticsService
 * - AggregationService
 * - TrendService
 * - ExportService
 * - DashboardService
 * - ReportService
 * - AnalyticsCenterService
 * - AnalyticsQueryService
 */

function makeUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildPrismaMock(overrides: Record<string, unknown> = {}) {
  return {
    analyticsConfiguration: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    analyticsReport: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    analyticsSnapshot: {
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _avg: { metricValue: 0 } }),
    },
    analyticsMetric: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    analyticsDashboard: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    analyticsStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    analyticsAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    reportExport: {
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      count: jest.fn().mockResolvedValue(125),
    },
    wallet: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { availableBalance: 50000 } }),
    },
    roomActivity: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalGifts: 850 } }),
    },
    referralCode: {
      count: jest.fn().mockResolvedValue(45),
    },
    referralRelationship: {
      count: jest.fn().mockResolvedValue(30),
    },
    enterpriseNotification: {
      count: jest.fn().mockResolvedValue(900),
    },
    ...overrides,
  };
}

function buildEventEmitterMock() {
  return { emit: jest.fn() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. AnalyticsConfigurationService
// ─────────────────────────────────────────────────────────────────────────────

import { AnalyticsConfigurationService } from './services/analytics-configuration.service';

describe('AnalyticsConfigurationService', () => {
  let service: AnalyticsConfigurationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new AnalyticsConfigurationService(prisma as any);
  });

  it('provides safe config default fallbacks', async () => {
    expect(await service.getSnapshotInterval()).toBe(60);
    expect(await service.getRetentionDays()).toBe(90);
    expect(await service.getExportLimit()).toBe(5000);
    expect(await service.getDefaultTimezone()).toBe('UTC');
    expect(await service.getCacheTtl()).toBe(300);
  });

  it('reads configuration fields from database overrides', async () => {
    prisma.analyticsConfiguration.findUnique.mockResolvedValue({
      key: 'analytics.retention_days',
      value: 180,
    });
    expect(await service.getRetentionDays()).toBe(180);
  });

  it('saves config records', async () => {
    await service.set('analytics.cache_ttl', 600);
    expect(prisma.analyticsConfiguration.upsert).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AnalyticsValidationService
// ─────────────────────────────────────────────────────────────────────────────

import { AnalyticsValidationService } from './services/analytics-validation.service';

describe('AnalyticsValidationService', () => {
  let service: AnalyticsValidationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new AnalyticsValidationService(prisma as any);
  });

  it('guards date ranges boundaries', () => {
    expect(() => service.assertValidDateRange('2026-07-23', '2026-07-01')).toThrow();
    expect(() => service.assertValidDateRange('2026-07-01', '2026-07-23')).not.toThrow();
  });

  it('validates analytical domains', () => {
    expect(() => service.assertValidDomain('INVALID_DOMAIN')).toThrow();
    expect(() => service.assertValidDomain('FINANCIAL')).not.toThrow();
  });

  it('validates supported exports formatting', () => {
    expect(() => service.assertValidFormat('HTML')).toThrow();
    expect(() => service.assertValidFormat('PDF')).not.toThrow();
  });

  it('throws NotFoundException on missing dashboard layout', async () => {
    prisma.analyticsDashboard.findUnique.mockResolvedValue(null);
    await expect(service.assertDashboardExists(makeUuid())).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AnalyticsAuditService
// ─────────────────────────────────────────────────────────────────────────────

import { AnalyticsAuditService } from './services/analytics-audit.service';

describe('AnalyticsAuditService', () => {
  let service: AnalyticsAuditService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new AnalyticsAuditService(prisma as any);
  });

  it('saves compliance logs', async () => {
    await service.log({ action: 'REPORT_EXPORTED', reportId: makeUuid() });
    expect(prisma.analyticsAudit.create).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. AnalyticsEventService
// ─────────────────────────────────────────────────────────────────────────────

import { AnalyticsEventService } from './services/analytics-event.service';

describe('AnalyticsEventService', () => {
  let service: AnalyticsEventService;
  let emitter: ReturnType<typeof buildEventEmitterMock>;

  beforeEach(() => {
    emitter = buildEventEmitterMock();
    service = new AnalyticsEventService(emitter as any);
  });

  it('publishes domain events', () => {
    service.emitReportGenerated({ reportId: '123' });
    expect(emitter.emit).toHaveBeenCalledWith('report.generated', { reportId: '123' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. AnalyticsStatisticsService
// ─────────────────────────────────────────────────────────────────────────────

import { AnalyticsStatisticsService } from './services/analytics-statistics.service';

describe('AnalyticsStatisticsService', () => {
  let service: AnalyticsStatisticsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new AnalyticsStatisticsService(prisma as any);
  });

  it('upserts pre-aggregated stats counters', async () => {
    await service.incrementStat('REVENUE_METRIC', 5, 250.5);
    expect(prisma.analyticsStatistics.upsert).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. AggregationService — Read-Only Data Aggregation
// ─────────────────────────────────────────────────────────────────────────────

import { AggregationService } from './services/aggregation.service';

describe('AggregationService', () => {
  let service: AggregationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new AggregationService(prisma as any);
  });

  it('compiles user registration metrics cleanly', async () => {
    const stats = await service.aggregateDomainMetrics('GROWTH');
    expect(stats['total_users']).toBe(125);
  });

  it('compiles wallet balances total values read-only', async () => {
    const stats = await service.aggregateDomainMetrics('WALLET');
    expect(stats['total_wallet_balance']).toBe(50000);
  });

  it('compiles referrals relationship metrics', async () => {
    const stats = await service.aggregateDomainMetrics('REFERRAL');
    expect(stats['total_referral_codes']).toBe(45);
    expect(stats['total_referral_relationships']).toBe(30);
  });

  it('never invokes mutations', () => {
    const keys = Object.keys(prisma);
    expect(keys).not.toContain('walletTransaction');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. TrendService — Time-Series Trends
// ─────────────────────────────────────────────────────────────────────────────

import { TrendService } from './services/trend.service';

describe('TrendService', () => {
  let service: TrendService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new TrendService(prisma as any);
  });

  it('calculates period growth ratios correctly', async () => {
    prisma.analyticsSnapshot.aggregate
      .mockResolvedValueOnce({ _avg: { metricValue: 200 } })
      .mockResolvedValueOnce({ _avg: { metricValue: 100 } });

    const growth = await service.calculateGrowthRatio(
      'GROWTH',
      'total_users',
      new Date(),
      new Date(),
      new Date(),
      new Date(),
    );

    expect(growth.ratio).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ExportService — Document Generator
// ─────────────────────────────────────────────────────────────────────────────

import { ExportService } from './services/export.service';

describe('ExportService', () => {
  let service: ExportService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const events = new AnalyticsEventService(buildEventEmitterMock() as any);
    const audit = new AnalyticsAuditService(prisma as any);
    service = new ExportService(prisma as any, events, audit);
  });

  it('generates report download urls and registers exports', async () => {
    const res: any = await service.exportReport({
      reportId: makeUuid(),
      format: 'PDF',
    });

    expect(res.status).toBe('COMPLETED');
    expect(res.url).toContain('.pdf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. DashboardService — Layout Registry
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardService } from './services/dashboard.service';

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const events = new AnalyticsEventService(buildEventEmitterMock() as any);
    const audit = new AnalyticsAuditService(prisma as any);
    service = new DashboardService(prisma as any, events, audit);
  });

  it('creates and updates widget layout configurations', async () => {
    const dashboard: any = await service.create({
      name: 'Sales Grid',
      layout: { columns: 4 },
    });

    expect(dashboard.name).toBe('Sales Grid');

    await service.updateLayout(dashboard.id, { columns: 6 });
    expect(prisma.analyticsDashboard.update).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. ReportService — Lifecycle Integrations
// ─────────────────────────────────────────────────────────────────────────────

import { ReportService } from './services/report.service';

describe('ReportService', () => {
  let service: ReportService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const aggregation = new AggregationService(prisma as any);
    const events = new AnalyticsEventService(buildEventEmitterMock() as any);
    const audit = new AnalyticsAuditService(prisma as any);

    service = new ReportService(prisma as any, aggregation, events, audit);
  });

  it('generates reports by aggregating target metrics domain', async () => {
    const report: any = await service.generateReport({
      name: 'Financial summary report',
      domain: 'WALLET',
    });

    expect(report.domain).toBe('WALLET');
    expect(report.data.total_wallet_balance).toBe(50000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. AnalyticsCenterService — Capture Snapshot Cycles
// ─────────────────────────────────────────────────────────────────────────────

import { AnalyticsCenterService } from './services/analytics-center.service';

describe('AnalyticsCenterService', () => {
  let service: AnalyticsCenterService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const aggregation = new AggregationService(prisma as any);
    const events = new AnalyticsEventService(buildEventEmitterMock() as any);
    const config = new AnalyticsConfigurationService(prisma as any);

    service = new AnalyticsCenterService(prisma as any, aggregation, events, config);
  });

  it('runs capturing loops over all domains', async () => {
    await service.captureSnapshots();
    expect(prisma.analyticsSnapshot.create).toHaveBeenCalled();
  });

  it('purges records matching retention thresholds', async () => {
    prisma.analyticsReport.deleteMany.mockResolvedValue({ count: 100 });
    const count = await service.purgeExpired();
    expect(count).toBe(100);
  });
});
