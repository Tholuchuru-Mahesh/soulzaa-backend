import { VideoRoomMemberRole } from '@prisma/client';
import {
  ELEVATED_VIDEO_ROOM_ROLES,
  isElevatedVideoRoomRole,
  VIDEO_ROOM_PERMISSION_MATRIX,
  VideoRoomPermission,
  videoRoomRoleHasPermission,
} from './video-room-permissions';

describe('VideoRoom permission matrix', () => {
  it('OWNER has every permission', () => {
    const owner = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.OWNER];
    for (const p of Object.values(VideoRoomPermission)) {
      expect(owner.has(p)).toBe(true);
    }
  });

  it('ADMIN has all permissions EXCEPT ownership transfer + room close', () => {
    const admin = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.ADMIN];
    expect(admin.has(VideoRoomPermission.TRANSFER_OWNERSHIP)).toBe(false);
    expect(admin.has(VideoRoomPermission.CLOSE_ROOM)).toBe(false);
    // ...but everything else.
    const expected = Object.values(VideoRoomPermission).filter(
      (p) => p !== VideoRoomPermission.TRANSFER_OWNERSHIP && p !== VideoRoomPermission.CLOSE_ROOM,
    );
    for (const p of expected) expect(admin.has(p)).toBe(true);
  });

  it('ADMIN is a strict subset of OWNER', () => {
    const owner = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.OWNER];
    const admin = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.ADMIN];
    for (const p of admin) expect(owner.has(p)).toBe(true);
    expect(admin.size).toBeLessThan(owner.size);
  });

  it('MODERATOR can discipline + manage content but NOT reshape the room', () => {
    const mod = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.MODERATOR];
    // Can:
    expect(mod.has(VideoRoomPermission.KICK_USERS)).toBe(true);
    expect(mod.has(VideoRoomPermission.BLOCK_USERS)).toBe(true);
    expect(mod.has(VideoRoomPermission.MUTE_USERS)).toBe(true);
    expect(mod.has(VideoRoomPermission.MANAGE_ANNOUNCEMENTS)).toBe(true);
    // Cannot:
    expect(mod.has(VideoRoomPermission.MANAGE_SEATS)).toBe(false);
    expect(mod.has(VideoRoomPermission.GRANT_ROLES)).toBe(false);
    expect(mod.has(VideoRoomPermission.CHANGE_THEME)).toBe(false);
    expect(mod.has(VideoRoomPermission.START_PK)).toBe(false);
  });

  it('HOST / PARTICIPANT / VIEWER carry no management permissions', () => {
    for (const role of [
      VideoRoomMemberRole.HOST,
      VideoRoomMemberRole.PARTICIPANT,
      VideoRoomMemberRole.VIEWER,
    ]) {
      expect(VIDEO_ROOM_PERMISSION_MATRIX[role].size).toBe(0);
    }
  });

  it('has an entry for every role (no undefined lookups)', () => {
    for (const role of Object.values(VideoRoomMemberRole)) {
      expect(VIDEO_ROOM_PERMISSION_MATRIX[role]).toBeInstanceOf(Set);
    }
  });

  it('exposes no BAN permission (Video Room has no ban feature)', () => {
    const names = Object.keys(VideoRoomPermission);
    expect(names.some((n) => n.includes('BAN'))).toBe(false);
  });

  describe('helpers', () => {
    it('isElevatedVideoRoomRole is true only for OWNER/ADMIN/MODERATOR', () => {
      expect(ELEVATED_VIDEO_ROOM_ROLES).toEqual([
        VideoRoomMemberRole.OWNER,
        VideoRoomMemberRole.ADMIN,
        VideoRoomMemberRole.MODERATOR,
      ]);
      expect(isElevatedVideoRoomRole(VideoRoomMemberRole.HOST)).toBe(false);
      expect(isElevatedVideoRoomRole(VideoRoomMemberRole.ADMIN)).toBe(true);
    });

    it('videoRoomRoleHasPermission resolves against the matrix', () => {
      expect(
        videoRoomRoleHasPermission(VideoRoomMemberRole.OWNER, VideoRoomPermission.CLOSE_ROOM),
      ).toBe(true);
      expect(
        videoRoomRoleHasPermission(VideoRoomMemberRole.MODERATOR, VideoRoomPermission.CLOSE_ROOM),
      ).toBe(false);
    });
  });
});
