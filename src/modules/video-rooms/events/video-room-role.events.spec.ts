import { VideoRoomMemberRole } from '@prisma/client';
import {
  OwnershipTransferredEvent,
  RoleAssignedEvent,
  RoleRemovedEvent,
  RoleUpdatedEvent,
  TemporaryRoleExpiredEvent,
  TemporaryRoleGrantedEvent,
  VIDEO_ROOM_ROLE_EVENTS,
} from './video-room-role.events';
import { VIDEO_ROOM_EVENTS } from './video-room.events';

describe('VR-7 role events', () => {
  // VR-4/VR-5 precedent: each phase owns its own registry. VIDEO_ROOM_EVENTS
  // belongs to VideoRoomSocketListener, whose spec asserts it relays every name
  // in it — appending there without extending that listener breaks its contract.
  it('lives in its own registry, not the core one', () => {
    expect(Object.values(VIDEO_ROOM_EVENTS)).not.toContain(VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED);
    expect(Object.values(VIDEO_ROOM_ROLE_EVENTS)).toHaveLength(6);
  });

  it('names RoleAssignedEvent on the role registry and carries the expiry', () => {
    const event = new RoleAssignedEvent({
      roomId: 'r1',
      userId: 'u1',
      actorId: 'a1',
      role: VideoRoomMemberRole.ADMIN,
      expiresAt: null,
    });
    expect(event.name).toBe(VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED);
    expect(event.payload).toMatchObject({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
  });

  it('names RoleRemovedEvent', () => {
    expect(
      new RoleRemovedEvent({
        roomId: 'r1',
        userId: 'u1',
        actorId: 'a1',
        role: VideoRoomMemberRole.ADMIN,
      }).name,
    ).toBe(VIDEO_ROOM_ROLE_EVENTS.ROLE_REMOVED);
  });

  it('names RoleUpdatedEvent and carries both the old and new role', () => {
    const event = new RoleUpdatedEvent({
      roomId: 'r1',
      userId: 'u1',
      actorId: 'a1',
      previousRole: VideoRoomMemberRole.MODERATOR,
      role: VideoRoomMemberRole.ADMIN,
      expiresAt: null,
    });
    expect(event.name).toBe(VIDEO_ROOM_ROLE_EVENTS.ROLE_UPDATED);
    expect(event.payload.previousRole).toBe(VideoRoomMemberRole.MODERATOR);
    expect(event.payload.role).toBe(VideoRoomMemberRole.ADMIN);
  });

  it('names the temporary-grant events', () => {
    expect(
      new TemporaryRoleGrantedEvent({
        roomId: 'r1',
        userId: 'u1',
        actorId: 'a1',
        role: VideoRoomMemberRole.ADMIN,
        expiresAt: '2026-07-22T00:00:00.000Z',
      }).name,
    ).toBe(VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_GRANTED);
    expect(
      new TemporaryRoleExpiredEvent({
        roomId: 'r1',
        userId: 'u1',
        role: VideoRoomMemberRole.ADMIN,
      }).name,
    ).toBe(VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_EXPIRED);
  });

  it('distinguishes a deliberate transfer from succession', () => {
    const transfer = new OwnershipTransferredEvent({
      roomId: 'r1',
      previousOwnerId: 'o1',
      newOwnerId: 'o2',
      actorId: 'a1',
      reason: 'TRANSFER',
    });
    const recovery = new OwnershipTransferredEvent({
      roomId: 'r1',
      previousOwnerId: 'o1',
      newOwnerId: 'o2',
      actorId: 'staff',
      reason: 'RECOVERY',
    });
    expect(transfer.name).toBe(VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED);
    expect(recovery.name).toBe(VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED);
    expect(transfer.payload.reason).not.toBe(recovery.payload.reason);
  });
});
