import type { ConfigService } from '@nestjs/config';
import { CallType, NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { CALL_EVENTS } from '../events/calls.events';
import { CallsPushListener } from './calls-push.listener';

const CALLER = 'caller-1';
const CALLEE = 'callee-1';
const CALL_ID = 'call-1';

function viewFor(userId: string, peerId: string) {
  return {
    id: CALL_ID,
    calleeId: CALLEE,
    callerId: CALLER,
    type: CallType.VOICE,
    peer: { userId: peerId, fullName: 'Jordan', username: 'jordan', avatarUrl: null },
  };
}

describe('CallsPushListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let handlers: Record<string, (e: { payload: unknown }) => Promise<void>>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    const config = { get: () => ({ ringTimeoutSeconds: 45 }) } as unknown as ConfigService;

    const listener = new CallsPushListener(
      bus as unknown as IEventBus,
      notifications as never,
      config,
    );
    listener.onModuleInit();

    handlers = {};
    for (const [event, handler] of bus.subscribe.mock.calls) {
      handlers[event as string] = handler as (e: { payload: unknown }) => Promise<void>;
    }
    expect(Object.keys(handlers).sort()).toEqual(
      [CALL_EVENTS.INITIATED, CALL_EVENTS.MISSED, CALL_EVENTS.CANCELLED].sort(),
    );
  });

  it('marks the incoming-call push preferVoipOnIos, so a killed/locked iPhone still rings', async () => {
    await handlers[CALL_EVENTS.INITIATED]({
      payload: {
        calleeId: CALLEE,
        callId: CALL_ID,
        views: { [CALLEE]: viewFor(CALLEE, CALLER) },
      },
    });

    expect(notifications.notify).toHaveBeenCalledWith(
      CALLEE,
      expect.objectContaining({ preferVoipOnIos: true, priority: 'high' }),
    );
  });

  it('marks the missed-call push preferVoipOnIos, so a still-ringing CallKit screen is dismissed', async () => {
    await handlers[CALL_EVENTS.MISSED]({
      payload: { callId: CALL_ID, views: { [CALLEE]: viewFor(CALLEE, CALLER) } },
    });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CALLEE, type: NotificationType.MISSED_CALL }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      CALLEE,
      expect.objectContaining({ preferVoipOnIos: true }),
    );
  });

  it('marks the cancelled-call push preferVoipOnIos, so a still-ringing CallKit screen is dismissed', async () => {
    await handlers[CALL_EVENTS.CANCELLED]({
      payload: { callId: CALL_ID, views: { [CALLEE]: viewFor(CALLEE, CALLER) } },
    });

    expect(notifications.notify).toHaveBeenCalledWith(
      CALLEE,
      expect.objectContaining({ preferVoipOnIos: true }),
    );
    // No notification-centre row for a call the callee was never given a chance
    // to answer — see the listener's own doc comment.
    expect(notifications.create).not.toHaveBeenCalled();
  });

  // `InMemoryEventBus.publish()` awaits every subscriber via `emitAsync` — an
  // unwrapped handler that throws would propagate back into whichever
  // `CallsService` method published the event (initiate, cancel, the
  // ring-timeout reaper, ...), failing an already-committed call state
  // transition over a notification. These three lock in that a push failure
  // can never do that, for every event this listener handles.
  describe('a failing push never fails the call event that triggered it', () => {
    const payload = { calleeId: CALLEE, callId: CALL_ID, views: { [CALLEE]: viewFor(CALLEE, CALLER) } };

    it('INITIATED: notify() rejecting resolves the handler anyway', async () => {
      notifications.notify.mockRejectedValueOnce(new Error('FCM unreachable'));
      await expect(handlers[CALL_EVENTS.INITIATED]({ payload })).resolves.toBeUndefined();
    });

    it('MISSED: notify() rejecting resolves the handler anyway, after create() already ran', async () => {
      notifications.notify.mockRejectedValueOnce(new Error('FCM unreachable'));
      await expect(handlers[CALL_EVENTS.MISSED]({ payload })).resolves.toBeUndefined();
      // The durable notification-centre row is unaffected by the push failing.
      expect(notifications.create).toHaveBeenCalled();
    });

    it('MISSED: create() rejecting also resolves the handler, not just notify()', async () => {
      notifications.create.mockRejectedValueOnce(new Error('db blip'));
      await expect(handlers[CALL_EVENTS.MISSED]({ payload })).resolves.toBeUndefined();
    });

    it('CANCELLED: notify() rejecting resolves the handler anyway', async () => {
      notifications.notify.mockRejectedValueOnce(new Error('FCM unreachable'));
      await expect(handlers[CALL_EVENTS.CANCELLED]({ payload })).resolves.toBeUndefined();
    });
  });
});
