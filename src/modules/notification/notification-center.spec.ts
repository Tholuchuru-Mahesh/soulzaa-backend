/**
 * Enterprise Notification Center — Phase 19 Test Suite
 *
 * Covers:
 * - NotificationConfigurationService
 * - NotificationValidationService
 * - NotificationTemplateService
 * - NotificationPreferenceService
 * - NotificationChannelService
 * - NotificationAuditService
 * - NotificationEventService
 * - NotificationStatisticsService
 * - NotificationInboxService
 * - NotificationDispatchService
 * - NotificationCenterService (lifecycle & broadcast)
 * - NotificationQueryService
 */

function makeUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildPrismaMock(overrides: Record<string, unknown> = {}) {
  return {
    notificationConfiguration: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: makeUuid() }),
    },
    notificationTemplate: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    enterpriseNotificationPreference: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    enterpriseNotification: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) =>
          Promise.resolve({ id: makeUuid(), retryCount: 0, ...args.data }),
        ),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    notificationInbox: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args) => Promise.resolve({ id: makeUuid(), ...args.data })),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    notificationHistory: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    notificationStatistics: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { sentCount: 0, readCount: 0, failedCount: 0 } }),
    },
    notificationAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

function buildEventEmitterMock() {
  return { emit: jest.fn() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NotificationConfigurationService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationConfigurationService } from './services/notification-configuration.service';

describe('NotificationConfigurationService', () => {
  let service: NotificationConfigurationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new NotificationConfigurationService(prisma as any);
  });

  it('returns safe fallback values', async () => {
    expect(await service.getRetryCount()).toBe(3);
    expect(await service.getDefaultChannel()).toBe('IN_APP');
    expect(await service.getRetentionDays()).toBe(30);
    expect(await service.getBatchSize()).toBe(100);
    expect(await service.getBroadcastLimit()).toBe(5);
  });

  it('retrieves config values from DB when set', async () => {
    prisma.notificationConfiguration.findUnique.mockResolvedValue({
      key: 'notification.retry_count',
      value: 5,
    });
    expect(await service.getRetryCount()).toBe(5);
  });

  it('saves config values via upsert', async () => {
    await service.set('notification.retry_count', 10);
    expect(prisma.notificationConfiguration.upsert).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NotificationValidationService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationValidationService } from './services/notification-validation.service';

describe('NotificationValidationService', () => {
  let service: NotificationValidationService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new NotificationValidationService(prisma as any);
  });

  it('throws NotFoundException when recipient does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.assertRecipientExists(makeUuid())).rejects.toThrow();
  });

  it('throws NotFoundException when template does not exist', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);
    await expect(service.assertTemplateExists('NO_CODE')).rejects.toThrow();
  });

  it('throws on invalid notification category type', () => {
    expect(() => service.assertNotificationTypeValid('INVALID_TYPE')).toThrow();
  });

  it('passes on valid notification category type', () => {
    expect(() => service.assertNotificationTypeValid('WALLET')).not.toThrow();
  });

  it('throws on invalid delivery channel name', () => {
    expect(() => service.assertChannelValid('INVALID_CHANNEL')).toThrow();
  });

  it('passes on valid delivery channel name', () => {
    expect(() => service.assertChannelValid('PUSH')).not.toThrow();
  });

  it('throws when daily broadcast limit is reached', async () => {
    prisma.enterpriseNotification.count.mockResolvedValue(5);
    await expect(service.assertBroadcastLimitNotExceeded(5)).rejects.toThrow('limit (5) exceeded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NotificationTemplateService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationTemplateService } from './services/notification-template.service';

describe('NotificationTemplateService', () => {
  let service: NotificationTemplateService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new NotificationTemplateService(prisma as any);
  });

  it('creates and renders a template with placeholders', async () => {
    const input = {
      code: 'WELCOME',
      titleTemplate: 'Hi {name}',
      bodyTemplate: 'Welcome to {platform}',
    };
    prisma.notificationTemplate.findUnique.mockResolvedValue(input);

    const rendered = await service.renderTemplate('WELCOME', {
      name: 'Alice',
      platform: 'Soulzaa',
    });
    expect(rendered.title).toBe('Hi Alice');
    expect(rendered.body).toBe('Welcome to Soulzaa');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. NotificationPreferenceService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationPreferenceService } from './services/notification-preference.service';

describe('NotificationPreferenceService', () => {
  let service: NotificationPreferenceService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new NotificationPreferenceService(prisma as any);
  });

  it('defaults to enabled: true when preference is missing', async () => {
    const result = await service.isEnabled(makeUuid(), 'GIFT', 'SMS');
    expect(result).toBe(true);
  });

  it('returns preference status when defined in DB', async () => {
    prisma.enterpriseNotificationPreference.findUnique.mockResolvedValue({ enabled: false });
    const result = await service.isEnabled(makeUuid(), 'GIFT', 'EMAIL');
    expect(result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NotificationChannelService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationChannelService } from './services/notification-channel.service';

describe('NotificationChannelService', () => {
  let service: NotificationChannelService;

  beforeEach(() => {
    service = new NotificationChannelService();
  });

  it('registers custom channels and dispatches context simulation', async () => {
    service.registerChannel('TELEGRAM');
    expect(service.isChannelRegistered('TELEGRAM')).toBe(true);

    const res = await service.dispatchToChannel('TELEGRAM', { notificationId: makeUuid() });
    expect(res.success).toBe(true);
  });

  it('returns failure when dispatching to an unregistered channel', async () => {
    const res = await service.dispatchToChannel('DISCORD', { notificationId: makeUuid() });
    expect(res.success).toBe(false);
    expect(res.errorMessage).toContain('not registered');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. NotificationAuditService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationAuditService } from './services/notification-audit.service';

describe('NotificationAuditService', () => {
  let service: NotificationAuditService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new NotificationAuditService(prisma as any);
  });

  it('logs audit entries and retrieves them', async () => {
    await service.log({ action: 'NOTIFICATION_CREATED', notificationId: makeUuid() });
    expect(prisma.notificationAudit.create).toHaveBeenCalled();

    await service.queryByAction('NOTIFICATION_CREATED');
    expect(prisma.notificationAudit.findMany).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. NotificationEventService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationEventService } from './services/notification-event.service';

describe('NotificationEventService', () => {
  let service: NotificationEventService;
  let emitter: ReturnType<typeof buildEventEmitterMock>;

  beforeEach(() => {
    emitter = buildEventEmitterMock();
    service = new NotificationEventService(emitter as any);
  });

  it('emits lifecycle events on the Nest event bus', () => {
    service.emitNotificationCreated({ notificationId: '1' });
    expect(emitter.emit).toHaveBeenCalledWith('notification.created', { notificationId: '1' });

    service.emitNotificationSent({ notificationId: '1', channel: 'SMS' });
    expect(emitter.emit).toHaveBeenCalledWith('notification.sent', {
      notificationId: '1',
      channel: 'SMS',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. NotificationStatisticsService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationStatisticsService } from './services/notification-statistics.service';

describe('NotificationStatisticsService', () => {
  let service: NotificationStatisticsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new NotificationStatisticsService(prisma as any);
  });

  it('increments usage stats and computes rate summaries', async () => {
    await service.incrementStat('PUSH', 'sentCount');
    expect(prisma.notificationStatistics.upsert).toHaveBeenCalled();

    prisma.notificationStatistics.aggregate.mockResolvedValue({
      _sum: { sentCount: 100, readCount: 80, failedCount: 5 },
    });

    const rates = await service.getGlobalRates();
    expect(rates.readRate).toBe(80);
    expect(rates.deliveryRate).toBe(95);
    expect(rates.failureRate).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. NotificationInboxService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationInboxService } from './services/notification-inbox.service';

describe('NotificationInboxService', () => {
  let service: NotificationInboxService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let events: NotificationEventService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    events = new NotificationEventService(buildEventEmitterMock() as any);
    const stats = new NotificationStatisticsService(prisma as any);
    const audit = new NotificationAuditService(prisma as any);
    service = new NotificationInboxService(prisma as any, events, stats, audit);
  });

  it('marks items read, tracks stats, and soft-deletes notifications', async () => {
    const id = makeUuid();
    const user = makeUuid();
    prisma.notificationInbox.findFirst.mockResolvedValue({ id, notificationId: makeUuid() });

    await service.markAsRead(id, user);
    expect(prisma.notificationInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { read: true, readAt: expect.any(Date) } }),
    );

    await service.softDelete(id, user);
    expect(prisma.notificationInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deleted: true, deletedAt: expect.any(Date) } }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. NotificationDispatchService
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationDispatchService } from './services/notification-dispatch.service';

describe('NotificationDispatchService', () => {
  let service: NotificationDispatchService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let channelService: NotificationChannelService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    channelService = new NotificationChannelService();
    const config = new NotificationConfigurationService(prisma as any);
    const preference = new NotificationPreferenceService(prisma as any);
    const statistics = new NotificationStatisticsService(prisma as any);
    const events = new NotificationEventService(buildEventEmitterMock() as any);
    const audit = new NotificationAuditService(prisma as any);

    service = new NotificationDispatchService(
      prisma as any,
      channelService,
      preference,
      statistics,
      events,
      audit,
      config,
    );
  });

  it('skips dispatching to channel if user disabled it in preferences', async () => {
    // Mock preference: disabled
    prisma.enterpriseNotificationPreference.findUnique.mockResolvedValue({ enabled: false });

    await service.dispatch({
      notificationId: makeUuid(),
      recipientId: makeUuid(),
      type: 'GIFT',
      title: 'A gift!',
      body: 'You received a gift!',
      channels: ['PUSH'],
    });

    // History and delivery should NOT be written for disabled channels
    expect(prisma.notificationHistory.create).not.toHaveBeenCalled();
  });

  it('dispatches to channel and writes logs if allowed', async () => {
    // Mock preference: enabled (returns null fallback to true)
    prisma.enterpriseNotificationPreference.findUnique.mockResolvedValue(null);

    await service.dispatch({
      notificationId: makeUuid(),
      recipientId: makeUuid(),
      type: 'GIFT',
      title: 'A gift!',
      body: 'You received a gift!',
      channels: ['IN_APP', 'PUSH'],
    });

    expect(prisma.notificationInbox.create).toHaveBeenCalled();
    expect(prisma.notificationHistory.create).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. NotificationCenterService — Lifecycle and Broadcast Integration
// ─────────────────────────────────────────────────────────────────────────────

import { NotificationCenterService } from './services/notification-center.service';

describe('NotificationCenterService — Lifecycle', () => {
  let service: NotificationCenterService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  const recipientId = makeUuid();
  const templateCode = 'WELCOME';
  const variables = { username: 'Bob' };

  beforeEach(() => {
    prisma = buildPrismaMock();
    const config = new NotificationConfigurationService(prisma as any);
    const validation = new NotificationValidationService(prisma as any);
    const templateService = new NotificationTemplateService(prisma as any);
    const preference = new NotificationPreferenceService(prisma as any);
    const statistics = new NotificationStatisticsService(prisma as any);
    const events = new NotificationEventService(buildEventEmitterMock() as any);
    const audit = new NotificationAuditService(prisma as any);
    const channels = new NotificationChannelService();
    const dispatch = new NotificationDispatchService(
      prisma as any,
      channels,
      preference,
      statistics,
      events,
      audit,
      config,
    );

    service = new NotificationCenterService(
      prisma as any,
      validation,
      templateService,
      dispatch,
      events,
      audit,
      config,
    );

    // Seed mock template
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      code: templateCode,
      titleTemplate: 'Hello {username}',
      bodyTemplate: 'Welcome to Soulzaa',
    });
  });

  it('sends immediate notification and dispatches to channels', async () => {
    const notif: any = await service.send({
      recipientId,
      type: 'SYSTEM',
      templateCode,
      variables,
      channels: ['IN_APP'],
    });

    expect(notif.recipientId).toBe(recipientId);
    expect(notif.status).toBe('DISPATCHED');
    expect(prisma.notificationInbox.create).toHaveBeenCalled();
  });

  it('keeps scheduled notification in pending status without immediate dispatch', async () => {
    const scheduledDate = new Date(Date.now() + 100000);
    const notif: any = await service.send({
      recipientId,
      type: 'SYSTEM',
      templateCode,
      variables,
      scheduledAt: scheduledDate,
      channels: ['PUSH'],
    });

    expect(notif.recipientId).toBe(recipientId);
    expect(notif.status).toBe('PENDING');
    // Inbox creation should NOT be called for scheduled items yet
    expect(prisma.notificationInbox.create).not.toHaveBeenCalled();
  });

  it('broadcasts announcements globally and publishes events', async () => {
    const announcement: any = await service.broadcastAnnouncement(templateCode, variables);
    expect(announcement.recipientId).toBeNull();
    expect(announcement.type).toBe('ANNOUNCEMENT');
  });

  it('cancels pending scheduled notifications', async () => {
    const id = makeUuid();
    await service.cancel(id);
    expect(prisma.enterpriseNotification.update).toHaveBeenCalledWith({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  });

  it('purges expired database rows matching retention policies', async () => {
    prisma.enterpriseNotification.deleteMany.mockResolvedValue({ count: 25 });
    const count = await service.purgeExpired();
    expect(count).toBe(25);
  });
});
