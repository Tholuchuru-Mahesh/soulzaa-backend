/**
 * Enterprise Business Admin Dashboard — Phase 21 Test Suite
 *
 * Covers:
 * - DashboardConfigurationService
 * - DashboardValidationService
 * - DashboardAuditService
 * - DashboardEventService
 * - DashboardStatisticsService
 * - DashboardHealthService
 * - DashboardWidgetService
 * - DashboardExportService
 * - DashboardQueryService
 * - AdminDashboardService
 */

function makeUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildPrismaMock(overrides: Record<string, unknown> = {}) {
  return {
    dashboardConfiguration: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    dashboardWidget: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    dashboardLayout: {
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      updateMany: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    dashboardAlert: {
      create: jest
        .fn()
        .mockImplementation((args) =>
          Promise.resolve({ id: makeUuid(), resolved: false, ...args.data }),
        ),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    dashboardStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    dashboardAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      count: jest.fn().mockResolvedValue(150),
      findMany: jest.fn().mockResolvedValue([]),
    },
    country: {
      count: jest.fn().mockResolvedValue(5),
    },
    wallet: {
      count: jest.fn().mockResolvedValue(150),
    },
    referralCode: {
      count: jest.fn().mockResolvedValue(50),
    },
    referralCampaign: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    enterpriseNotification: {
      count: jest.fn().mockResolvedValue(1000),
    },
    analyticsReport: {
      count: jest.fn().mockResolvedValue(10),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
    ...overrides,
  };
}

function buildEventEmitterMock() {
  return { emit: jest.fn() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DashboardConfigurationService
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardConfigurationService } from './services/dashboard-configuration.service';

describe('DashboardConfigurationService', () => {
  let service: DashboardConfigurationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new DashboardConfigurationService(prisma as any);
  });

  it('retrieves default parameters when no config records present', async () => {
    expect(await service.getRefreshInterval()).toBe(30);
    expect(await service.getDefaultLayout()).toBe('GRID_3X3');
    expect(await service.getWidgetLimit()).toBe(20);
    expect(await service.getExportLimit()).toBe(1000);
    expect(await service.getCacheTtl()).toBe(60);
  });

  it('overrides parameters using DB configs', async () => {
    prisma.dashboardConfiguration.findUnique.mockResolvedValue({
      key: 'dashboard.refresh_interval',
      value: 15,
    });
    expect(await service.getRefreshInterval()).toBe(15);
  });

  it('updates dashboard configuration values', async () => {
    await service.set('dashboard.refresh_interval', 45);
    expect(prisma.dashboardConfiguration.upsert).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DashboardValidationService
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardValidationService } from './services/dashboard-validation.service';

describe('DashboardValidationService', () => {
  let service: DashboardValidationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new DashboardValidationService(prisma as any);
  });

  it('throws NotFoundException if widget does not exist', async () => {
    prisma.dashboardWidget.findUnique.mockResolvedValue(null);
    await expect(service.assertWidgetExists(makeUuid())).rejects.toThrow();
  });

  it('guards layout object configuration parameters structure', () => {
    expect(() => service.assertLayoutIntegrity(null as any)).toThrow();
    expect(() => service.assertLayoutIntegrity({ widgets: [] })).not.toThrow();
  });

  it('enforces role-based widget visibility permissions', () => {
    expect(() => service.assertRoleCanViewWidget('USER', ['ADMIN'])).toThrow();
    expect(() => service.assertRoleCanViewWidget('ADMIN', ['ADMIN'])).not.toThrow();
  });

  it('enforces export format validation', () => {
    expect(() => service.assertValidExportFormat('XML')).toThrow();
    expect(() => service.assertValidExportFormat('CSV')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DashboardAuditService
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardAuditService } from './services/dashboard-audit.service';

describe('DashboardAuditService', () => {
  let service: DashboardAuditService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new DashboardAuditService(prisma as any);
  });

  it('creates console log audits and retrieves them', async () => {
    await service.log({ action: 'DASHBOARD_VIEWED', userId: makeUuid() });
    expect(prisma.dashboardAudit.create).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DashboardEventService
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardEventService } from './services/dashboard-event.service';

describe('DashboardEventService', () => {
  let service: DashboardEventService;
  let emitter: ReturnType<typeof buildEventEmitterMock>;

  beforeEach(() => {
    emitter = buildEventEmitterMock();
    service = new DashboardEventService(emitter as any);
  });

  it('emits dashboard socket events', () => {
    service.emitLayoutUpdated({ userId: '1', layoutId: 'layout-id' });
    expect(emitter.emit).toHaveBeenCalledWith('dashboard.layout.updated', {
      userId: '1',
      layoutId: 'layout-id',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DashboardStatisticsService
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardStatisticsService } from './services/dashboard-statistics.service';

describe('DashboardStatisticsService', () => {
  let service: DashboardStatisticsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new DashboardStatisticsService(prisma as any);
  });

  it('increments widgets and exports statistical counters', async () => {
    await service.incrementStat('widgetRefreshes');
    expect(prisma.dashboardStatistics.upsert).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DashboardHealthService — Platform Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardHealthService } from './services/dashboard-health.service';

describe('DashboardHealthService', () => {
  let service: DashboardHealthService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const events = new DashboardEventService(buildEventEmitterMock() as any);
    const statistics = new DashboardStatisticsService(prisma as any);
    service = new DashboardHealthService(prisma as any, events, statistics);
  });

  it('reports database as healthy when raw queries execute', async () => {
    const report = await service.checkHealth();
    expect(report.database).toBe('HEALTHY');
    expect(report.apiStatus).toBe('HEALTHY');
  });

  it('reports degraded system status and raises alert when database query fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('Connection timeout'));
    const report = await service.checkHealth();
    expect(report.database).toBe('UNHEALTHY');
    expect(report.apiStatus).toBe('DEGRADED');
    expect(prisma.dashboardAlert.create).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. DashboardWidgetService — Widgets Manager
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardWidgetService } from './services/dashboard-widget.service';

describe('DashboardWidgetService', () => {
  let service: DashboardWidgetService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const validation = new DashboardValidationService(prisma as any);
    const events = new DashboardEventService(buildEventEmitterMock() as any);
    const audit = new DashboardAuditService(prisma as any);
    service = new DashboardWidgetService(prisma as any, validation, events, audit);
  });

  it('creates widget definitions', async () => {
    const widget: any = await service.createWidget({
      name: 'Wallets Total',
      type: 'NUMBER',
      metricKey: 'total_wallets',
      visibleToRoles: ['ADMIN'],
    });

    expect(widget.name).toBe('Wallets Total');
    expect(widget.visibleToRoles).toContain('ADMIN');
  });

  it('filters list of widgets by user role visibility settings', async () => {
    prisma.dashboardWidget.findMany.mockResolvedValue([
      { id: makeUuid(), name: 'W1', type: 'NUMBER', visibleToRoles: ['ADMIN'], metricKey: 'k' },
      { id: makeUuid(), name: 'W2', type: 'NUMBER', visibleToRoles: ['USER'], metricKey: 'k' },
    ]);

    const adminList = await service.listWidgets('ADMIN');
    expect(adminList.length).toBe(1);

    const userList = await service.listWidgets('USER');
    expect(userList.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. DashboardExportService — Layout Exports
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardExportService } from './services/dashboard-export.service';

describe('DashboardExportService', () => {
  let service: DashboardExportService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const events = new DashboardEventService(buildEventEmitterMock() as any);
    const audit = new DashboardAuditService(prisma as any);
    const statistics = new DashboardStatisticsService(prisma as any);

    service = new DashboardExportService(prisma as any, events, audit, statistics);
  });

  it('creates export download paths and increments analytics stats', async () => {
    const res: any = await service.exportDashboard({
      layoutId: makeUuid(),
      format: 'EXCEL',
    });

    expect(res.url).toContain('.excel');
    expect(prisma.dashboardStatistics.upsert).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. DashboardQueryService — Cross-Module Searches
// ─────────────────────────────────────────────────────────────────────────────

import { DashboardQueryService } from './services/dashboard-query.service';

describe('DashboardQueryService', () => {
  let service: DashboardQueryService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new DashboardQueryService(prisma as any);
  });

  it('returns consolidated count overview read-only', async () => {
    const overview = await service.getOverviewStats();
    expect(overview.totalUsers).toBe(150);
    expect(overview.totalReferralCodes).toBe(50);
  });

  it('returns global cross-module query search records matching keywords', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: makeUuid(), username: 'alice', email: 'alice@soulzaa.app' },
    ]);
    prisma.referralCampaign.findMany.mockResolvedValue([
      { id: makeUuid(), name: 'Summer Campaign', code: 'SUMMER' },
    ]);

    const searchResults: any = await service.searchGlobal('alice');
    expect(searchResults.length).toBe(2);
    expect(searchResults[0].title).toBe('alice');
    expect(searchResults[1].title).toBe('Summer Campaign');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. AdminDashboardService — Personalized Layouts
// ─────────────────────────────────────────────────────────────────────────────

import { AdminDashboardService } from './services/admin-dashboard.service';

describe('AdminDashboardService', () => {
  let service: AdminDashboardService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    const validation = new DashboardValidationService(prisma as any);
    const events = new DashboardEventService(buildEventEmitterMock() as any);
    const audit = new DashboardAuditService(prisma as any);
    const statistics = new DashboardStatisticsService(prisma as any);

    service = new AdminDashboardService(prisma as any, validation, events, audit, statistics);
  });

  it('saves custom layouts and toggles default views', async () => {
    const userId = makeUuid();
    await service.createLayout({
      userId,
      name: 'Mobile Layout',
      isDefault: true,
      gridConfig: { cols: 2 },
    });

    // Unsets previous default layouts for this user
    expect(prisma.dashboardLayout.updateMany).toHaveBeenCalledWith({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
    expect(prisma.dashboardLayout.create).toHaveBeenCalled();
  });
});
