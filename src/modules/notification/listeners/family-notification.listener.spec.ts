import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { FAMILY_EVENTS } from 'src/modules/families/events/families.events';
import type { IFamiliesService } from 'src/modules/families/interfaces/families.service.interface';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { FamilyNotificationListener } from './family-notification.listener';

const FAMILY = 'fam-1';
const FOUNDER = 'founder-1';
const ELDER = 'elder-1';
const JOINER = 'joiner-1';

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void>;

/** A big roster, to prove the fan-out cap actually caps. */
const bigRoster = [FOUNDER, ELDER, ...Array.from({ length: 48 }, (_, i) => `member-${i}`)];

describe('FamilyNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let families: { getOfficerIds: jest.Mock; getMemberIds: jest.Mock };
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    guard = {
      once: jest.fn((_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    };
    families = {
      getOfficerIds: jest.fn().mockResolvedValue([FOUNDER, ELDER]),
      getMemberIds: jest.fn().mockResolvedValue(bigRoster),
    };

    const listener = new FamilyNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
      families as unknown as IFamiliesService,
    );
    listener.onModuleInit();

    handlers = new Map<string, Handler>(bus.subscribe.mock.calls as [string, Handler][]);
  });

  const recipients = () =>
    notifications.create.mock.calls.map((c) => (c[0] as { userId: string }).userId);

  // The fan-out cap. A 50-member family must not turn one join into 50 rows.
  it('notifies only officers when a member joins', async () => {
    await handlers.get(FAMILY_EVENTS.MEMBER_JOINED)!({
      payload: { familyId: FAMILY, userId: JOINER },
    });

    expect(recipients().sort()).toEqual([ELDER, FOUNDER].sort());
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(families.getMemberIds).not.toHaveBeenCalled();
  });

  it('never tells the joiner about their own join', async () => {
    families.getOfficerIds.mockResolvedValue([FOUNDER, ELDER, JOINER]);

    await handlers.get(FAMILY_EVENTS.MEMBER_JOINED)!({
      payload: { familyId: FAMILY, userId: JOINER },
    });

    expect(recipients()).not.toContain(JOINER);
  });

  it('uses the FAMILY push category', async () => {
    await handlers.get(FAMILY_EVENTS.MEMBER_JOINED)!({
      payload: { familyId: FAMILY, userId: JOINER },
    });

    expect(notifications.notify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: PUSH_CATEGORIES.FAMILY }),
    );
  });

  // Being removed is the one membership change the *subject* must hear about.
  it('tells a kicked member they were removed, and nobody else', async () => {
    await handlers.get(FAMILY_EVENTS.MEMBER_LEFT)!({
      payload: { familyId: FAMILY, userId: JOINER, kicked: true, actorId: FOUNDER },
    });

    expect(recipients()).toEqual([JOINER]);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: JOINER, type: NotificationType.FAMILY_REMOVED }),
    );
  });

  it('tells officers when a member leaves voluntarily, but not the leaver', async () => {
    await handlers.get(FAMILY_EVENTS.MEMBER_LEFT)!({
      payload: { familyId: FAMILY, userId: JOINER, kicked: false, actorId: JOINER },
    });

    expect(recipients().sort()).toEqual([ELDER, FOUNDER].sort());
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.FAMILY_MEMBER_LEFT }),
    );
  });

  // The one genuine full fan-out: rare, and it concerns everyone.
  it('tells every member when the family is deleted', async () => {
    await handlers.get(FAMILY_EVENTS.DELETED)!({
      payload: { familyId: FAMILY, leaderId: FOUNDER },
    });

    expect(notifications.create).toHaveBeenCalledTimes(bigRoster.length);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.FAMILY_REMOVED }),
    );
  });

  it('dedupes per family, user and event', async () => {
    await handlers.get(FAMILY_EVENTS.MEMBER_JOINED)!({
      payload: { familyId: FAMILY, userId: JOINER },
    });

    expect(guard.once).toHaveBeenCalledWith(
      expect.stringContaining(`family:${FAMILY}:`),
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('does nothing when a family has no officers', async () => {
    families.getOfficerIds.mockResolvedValue([]);

    await handlers.get(FAMILY_EVENTS.MEMBER_JOINED)!({
      payload: { familyId: FAMILY, userId: JOINER },
    });

    expect(notifications.create).not.toHaveBeenCalled();
  });
});
