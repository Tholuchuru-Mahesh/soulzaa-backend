import { VideoRoomMemberRole } from '@prisma/client';
import { VIDEO_ROOM_ROLE_EVENTS } from '../events/video-room-role.events';
import { VideoRoomRoleMetricsListener } from './video-room-role-metrics.listener';

describe('VideoRoomRoleMetricsListener', () => {
  const handlers = new Map<string, (event: unknown) => void>();
  let bus: any;
  let metrics: any;
  let subject: VideoRoomRoleMetricsListener;

  beforeEach(() => {
    handlers.clear();
    bus = {
      subscribe: jest.fn((name: string, handler: (event: unknown) => void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
    };
    metrics = {
      incRoleAssignment: jest.fn(),
      incOwnershipTransfer: jest.fn(),
      incTemporaryRole: jest.fn(),
    };
    subject = new VideoRoomRoleMetricsListener(bus, metrics);
    subject.onModuleInit();
  });

  const fire = (name: string, payload: Record<string, unknown> = {}): void => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler subscribed for ${name}`);
    handler({ payload });
  };

  it('subscribes to every role event', () => {
    for (const name of Object.values(VIDEO_ROOM_ROLE_EVENTS)) {
      expect(handlers.has(name)).toBe(true);
    }
  });

  it('labels an assignment by role', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED, { role: VideoRoomMemberRole.ADMIN });
    expect(metrics.incRoleAssignment).toHaveBeenCalledWith(VideoRoomMemberRole.ADMIN, 'assigned');
  });

  it('labels a removal by role', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.ROLE_REMOVED, { role: VideoRoomMemberRole.MODERATOR });
    expect(metrics.incRoleAssignment).toHaveBeenCalledWith(
      VideoRoomMemberRole.MODERATOR,
      'removed',
    );
  });

  it('labels an update by the new role', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.ROLE_UPDATED, {
      previousRole: VideoRoomMemberRole.MODERATOR,
      role: VideoRoomMemberRole.ADMIN,
    });
    expect(metrics.incRoleAssignment).toHaveBeenCalledWith(VideoRoomMemberRole.ADMIN, 'updated');
  });

  it('counts an ownership transfer', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED);
    expect(metrics.incOwnershipTransfer).toHaveBeenCalledTimes(1);
  });

  it('counts temporary grant and expiry separately', () => {
    fire(VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_GRANTED);
    fire(VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_EXPIRED);
    expect(metrics.incTemporaryRole).toHaveBeenCalledWith('granted');
    expect(metrics.incTemporaryRole).toHaveBeenCalledWith('expired');
  });
});
