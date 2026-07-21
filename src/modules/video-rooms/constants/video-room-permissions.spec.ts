import { VideoRoomMemberRole } from '@prisma/client';
import {
  ELEVATED_VIDEO_ROOM_ROLES,
  isElevatedVideoRoomRole,
  VIDEO_ROOM_PERMISSION_MATRIX,
  VIDEO_ROOM_ROLE_RANK,
  VideoRoomPermission,
  videoRoomRoleHasPermission,
  videoRoomRolePermissions,
} from './video-room-permissions';
import { videoRoomPermissionKey, videoRoomPermissionVersionKey } from './video-room.constants';

describe('VideoRoom permission matrix', () => {
  it('OWNER has every permission', () => {
    const owner = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.OWNER];
    for (const p of Object.values(VideoRoomPermission)) {
      expect(owner.has(p)).toBe(true);
    }
  });

  // VR-7: ADMIN is the PRD's Room Admin (production.txt:3349-3372), NOT a
  // near-owner. The PRD's "Admin Restrictions" section is the authority here.
  it.each([
    VideoRoomPermission.MANAGE_ROOM,
    VideoRoomPermission.LOCK_ROOM,
    VideoRoomPermission.GRANT_ROLES,
    VideoRoomPermission.CHANGE_THEME,
    VideoRoomPermission.TRANSFER_OWNERSHIP,
    VideoRoomPermission.CLOSE_ROOM,
  ])('denies %s to ADMIN (PRD admin restrictions)', (perm) => {
    expect(VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.ADMIN].has(perm)).toBe(false);
  });

  it.each([
    VideoRoomPermission.MANAGE_SEATS,
    VideoRoomPermission.MANAGE_PARTICIPANTS,
    VideoRoomPermission.INVITE_USERS,
    VideoRoomPermission.KICK_USERS,
    VideoRoomPermission.BLOCK_USERS,
    VideoRoomPermission.MUTE_USERS,
    VideoRoomPermission.ROOM_MUTE,
    VideoRoomPermission.PIN_MESSAGES,
    VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
    VideoRoomPermission.VIEW_ANALYTICS,
    VideoRoomPermission.START_PK,
  ])('grants %s to ADMIN (PRD admin duties)', (perm) => {
    expect(VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.ADMIN].has(perm)).toBe(true);
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

describe('VR-7 hierarchy + helpers', () => {
  it('gives OWNER every permission including MANAGE_ROOM', () => {
    const owner = VIDEO_ROOM_PERMISSION_MATRIX[VideoRoomMemberRole.OWNER];
    expect(owner.size).toBe(Object.values(VideoRoomPermission).length);
    expect(owner.has(VideoRoomPermission.MANAGE_ROOM)).toBe(true);
  });

  // Inheritance is by construction (ADMIN is built from MODERATOR's set), so it
  // is asserted rather than walked at runtime.
  it('makes each role a superset of the role below it', () => {
    const descending = [
      VideoRoomMemberRole.OWNER,
      VideoRoomMemberRole.ADMIN,
      VideoRoomMemberRole.MODERATOR,
      VideoRoomMemberRole.HOST,
      VideoRoomMemberRole.PARTICIPANT,
      VideoRoomMemberRole.VIEWER,
    ];
    for (let i = 0; i < descending.length - 1; i++) {
      const higher = VIDEO_ROOM_PERMISSION_MATRIX[descending[i]];
      const lower = VIDEO_ROOM_PERMISSION_MATRIX[descending[i + 1]];
      for (const perm of lower) expect(higher.has(perm)).toBe(true);
    }
  });

  it('ranks roles strictly descending', () => {
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.OWNER]).toBe(5);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.ADMIN]).toBe(4);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.MODERATOR]).toBe(3);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.HOST]).toBe(2);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.PARTICIPANT]).toBe(1);
    expect(VIDEO_ROOM_ROLE_RANK[VideoRoomMemberRole.VIEWER]).toBe(0);
  });

  it('lists a role permissions as a stable sorted array', () => {
    expect(videoRoomRolePermissions(VideoRoomMemberRole.VIEWER)).toEqual([]);
    const mod = videoRoomRolePermissions(VideoRoomMemberRole.MODERATOR);
    expect(mod).toEqual([...mod].sort());
    expect(mod).toContain(VideoRoomPermission.KICK_USERS);
  });
});

describe('VR-7 permission cache keys', () => {
  // Both keys must land in the same Redis Cluster slot or the MGET that reads
  // them together would span slots. The hash tag is the FIRST {...} in a key, so
  // both tag on the room id — never the user id.
  it('hash-tags both keys on the room id', () => {
    expect(videoRoomPermissionVersionKey('r1')).toBe('video-room:{r1}:perm:ver');
    expect(videoRoomPermissionKey('r1', 'u1')).toBe('video-room:{r1}:perm:u1');
  });
});
