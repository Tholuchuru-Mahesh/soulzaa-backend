import { ConfigService } from '@nestjs/config';
import { RoomMemberRole, RoomVisibility } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { IProfileService } from 'src/modules/users/interfaces/profile.interface';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import { AudioRoomSeatsService } from './audio-room-seats.service';
import { AudioRoomsService, type RoomActor } from './audio-rooms.service';
import { RoomPasswordService } from './room-password.service';
import { RoomPermissionService } from './room-permission.service';

const OWNER: RoomActor = { id: 'owner-1', roles: ['USER'] };
const OTHER: RoomActor = { id: 'user-2', roles: ['USER'] };
const ADMIN: RoomActor = { id: 'admin-1', roles: ['ADMIN'] };

function roomRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    ownerId: OWNER.id,
    name: 'My Room',
    description: null,
    imageKey: null,
    categoryId: null,
    language: null,
    visibility: RoomVisibility.PUBLIC,
    isLocked: false,
    passwordHash: null,
    isDiscoverable: true,
    maxParticipants: 5,
    status: 'LIVE',
    endedAt: null,
    agoraChannel: 'chan-1',
    zegoRoomId: 'zego-1',
    createdAt: new Date(Date.now() - 60_000),
    ...overrides,
  } as never;
}

describe('AudioRoomsService', () => {
  let repo: Record<string, jest.Mock>;
  let presence: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let passwords: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let seatsService: Record<string, jest.Mock>;
  let moderation: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let users: Record<string, jest.Mock>;
  let profiles: Partial<IProfileService>;
  let service: AudioRoomsService;

  beforeEach(() => {
    repo = {
      countActiveRoomsOwnedBy: jest.fn().mockResolvedValue(0),
      findOwnedRoom: jest.fn().mockResolvedValue(null),
      categoryExists: jest.fn().mockResolvedValue(true),
      languageExists: jest.fn().mockResolvedValue(true),
      createRoomTx: jest.fn().mockResolvedValue(roomRow()),
      setCachedSnapshot: jest.fn().mockResolvedValue(undefined),
      getCachedSnapshot: jest.fn().mockResolvedValue(null),
      findRoomRow: jest.fn().mockResolvedValue(roomRow()),
      findLiveRoomRow: jest.fn().mockResolvedValue(roomRow()),
      updateRoom: jest.fn().mockResolvedValue(roomRow()),
      softDeleteRoom: jest.fn().mockResolvedValue(undefined),
      endRoom: jest.fn().mockResolvedValue(undefined),
      setOwner: jest.fn().mockResolvedValue(roomRow({ ownerId: OTHER.id })),
      getMember: jest.fn().mockResolvedValue({ isActive: true, role: RoomMemberRole.AUDIENCE }),
      upsertActiveMember: jest.fn().mockResolvedValue(undefined),
      setMemberRole: jest.fn().mockResolvedValue(undefined),
      deactivateMember: jest.fn().mockResolvedValue(undefined),
      listActiveMembers: jest.fn().mockResolvedValue([]),
      upsertPresence: jest.fn().mockResolvedValue(undefined),
      removePresence: jest.fn().mockResolvedValue(undefined),
      bumpStatsOnJoin: jest.fn().mockResolvedValue(undefined),
      bumpStatsOnLeave: jest.fn().mockResolvedValue(undefined),
      trendingBump: jest.fn().mockResolvedValue(undefined),
      trendingRemove: jest.fn().mockResolvedValue(undefined),
      appendLog: jest.fn().mockResolvedValue(undefined),
      invalidateSnapshot: jest.fn().mockResolvedValue(undefined),
    };
    presence = {
      roomMemberCount: jest.fn().mockResolvedValue(1),
      isInRoom: jest.fn().mockResolvedValue(false),
      joinRoom: jest.fn().mockResolvedValue(undefined),
      leaveRoom: jest.fn().mockResolvedValue(undefined),
      roomMembers: jest.fn().mockResolvedValue([]),
    };
    locks = {
      // Execute the critical section immediately (no real Redis lock in unit tests).
      withLock: jest.fn(<T>(_key: string, fn: () => Promise<T>) => fn()) as never,
    };
    passwords = {
      hash: jest.fn().mockResolvedValue('hashed'),
      verify: jest.fn().mockResolvedValue(true),
    };
    permissions = {
      getEffectiveRole: jest.fn().mockResolvedValue(RoomMemberRole.LISTENER),
      userHasPermission: jest.fn().mockResolvedValue(false),
      isSpeaker: jest.fn().mockResolvedValue(false),
    };
    seatsService = {
      isRoomMuted: jest.fn().mockResolvedValue(false),
      isSeatMuted: jest.fn().mockResolvedValue(false),
      getStage: jest.fn().mockResolvedValue({ seats: [], queue: [], settings: {} }),
      takeSeat: jest.fn().mockResolvedValue(undefined),
      onRoomOpened: jest.fn().mockResolvedValue(undefined),
      onRoomClosed: jest.fn().mockResolvedValue(undefined),
    };
    moderation = {
      isKickedCached: jest.fn().mockResolvedValue(false),
      findActiveKick: jest.fn().mockResolvedValue(null),
      addKickCache: jest.fn().mockResolvedValue(undefined),
      isBannedCached: jest.fn().mockResolvedValue(false),
      findActiveBan: jest.fn().mockResolvedValue(null),
      addBanCache: jest.fn().mockResolvedValue(undefined),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    users = { findById: jest.fn().mockResolvedValue({ username: 'bob' }) };
    profiles = {
      resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()),
    };
    const config = {
      get: () => ({
        defaultMaxParticipants: 50,
        maxParticipantsCap: 500,
        cacheTtlSeconds: 60,
        defaultSpeakerSeats: 8,
        defaultPremiumAdminSeats: 0,
      }),
    } as unknown as ConfigService;

    service = new AudioRoomsService(
      repo as unknown as AudioRoomsRepository,
      presence as unknown as PresenceService,
      locks as unknown as LockService,
      passwords as unknown as RoomPasswordService,
      config,
      permissions as unknown as RoomPermissionService,
      seatsService as unknown as AudioRoomSeatsService,
      moderation as unknown as ModerationRepository,
      bus,
      users as unknown as IUsersService,
      profiles as unknown as IProfileService,
    );
  });

  describe('create', () => {
    it('creates a room and publishes room.created', async () => {
      const view = await service.create(OWNER, { name: 'My Room' });
      expect(repo.createRoomTx).toHaveBeenCalled();
      expect(view.id).toBe('room-1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.created' }),
      );
    });

    it('returns the existing room if already created', async () => {
      repo.findOwnedRoom.mockResolvedValue(roomRow({ id: 'existing-1' }));
      const view = await service.create(OWNER, { name: 'Another' });
      expect(view.id).toBe('existing-1');
      expect(repo.createRoomTx).not.toHaveBeenCalled();
    });

    it('clamps maxParticipants to the configured cap', async () => {
      await service.create(OWNER, { name: 'Big', maxParticipants: 10_000 });
      expect(repo.createRoomTx).toHaveBeenCalledWith(
        expect.objectContaining({ maxParticipants: 500 }),
      );
    });

    it('hashes a supplied password', async () => {
      await service.create(OWNER, { name: 'Locked', password: 'secret' });
      expect(passwords.hash).toHaveBeenCalledWith('secret');
      expect(repo.createRoomTx).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: 'hashed' }),
      );
    });
  });

  describe('join', () => {
    beforeEach(() => {
      repo.getMember.mockResolvedValue(null);
    });

    it('rejects a wrong password on a locked room', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ isLocked: true, passwordHash: 'hashed' }));
      passwords.verify.mockResolvedValue(false);
      await expect(service.join(OTHER, 'room-1', { password: 'nope' })).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(presence.joinRoom).not.toHaveBeenCalled();
    });

    it('accepts a correct password and joins', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ isLocked: true, passwordHash: 'hashed' }));
      passwords.verify.mockResolvedValue(true);
      await service.join(OTHER, 'room-1', { password: 'secret' });
      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', OTHER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.joined' }),
      );
    });

    it('bypasses password check for existing active members', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ isLocked: true, passwordHash: 'hashed' }));
      repo.getMember.mockResolvedValue({ isActive: true, role: RoomMemberRole.AUDIENCE } as any);
      await service.join(OTHER, 'room-1', {});
      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', OTHER.id);
    });

    it('bypasses password check for room owner and platform admin', async () => {
      // Owner bypass
      repo.findRoomRow.mockResolvedValue(
        roomRow({ ownerId: OWNER.id, isLocked: true, passwordHash: 'hashed' }),
      );
      await service.join(OWNER, 'room-1', {});
      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', OWNER.id);

      // Platform Admin bypass
      repo.findRoomRow.mockResolvedValue(
        roomRow({ ownerId: OWNER.id, isLocked: true, passwordHash: 'hashed' }),
      );
      await service.join(ADMIN, 'room-1', {});
      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', ADMIN.id);
    });

    it('rejects when the room is full', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ maxParticipants: 2 }));
      presence.isInRoom.mockResolvedValue(false);
      presence.roomMemberCount.mockResolvedValue(2);
      await expect(service.join(OTHER, 'room-1', {})).rejects.toBeInstanceOf(BusinessException);
    });

    it('rejects joining an ended room', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ status: 'ENDED' }));
      await expect(service.join(OTHER, 'room-1', {})).rejects.toBeInstanceOf(BusinessException);
    });

    it('rejects a rejoin by a user on the kick list (Redis gate)', async () => {
      moderation.isKickedCached.mockResolvedValue(true);
      await expect(service.join(OTHER, 'room-1', {})).rejects.toBeInstanceOf(BusinessException);
      expect(presence.joinRoom).not.toHaveBeenCalled();
    });

    it('rejects a rejoin by a kicked user on a cache miss, and warms the gate', async () => {
      moderation.isKickedCached.mockResolvedValue(false);
      moderation.findActiveKick.mockResolvedValue({ id: 'kick-1' });
      await expect(service.join(OTHER, 'room-1', {})).rejects.toBeInstanceOf(BusinessException);
      expect(moderation.addKickCache).toHaveBeenCalledWith('room-1', OTHER.id);
      expect(presence.joinRoom).not.toHaveBeenCalled();
    });

    it('lets a restored user rejoin once their kick is lifted', async () => {
      moderation.isKickedCached.mockResolvedValue(false);
      moderation.findActiveKick.mockResolvedValue(null);
      await service.join(OTHER, 'room-1', {});
      expect(presence.joinRoom).toHaveBeenCalledWith('room-1', OTHER.id);
    });
  });

  describe('ownership / management', () => {
    it('forbids a non-owner non-admin from editing', async () => {
      permissions.getEffectiveRole.mockResolvedValue(RoomMemberRole.LISTENER);
      await expect(service.update(OTHER, 'room-1', { name: 'x' })).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('allows a platform admin to edit', async () => {
      await expect(service.update(ADMIN, 'room-1', { name: 'x' })).resolves.toBeDefined();
      expect(repo.updateRoom).toHaveBeenCalled();
    });

    it('allows in-room admin or premium admin to manage settings', async () => {
      permissions.getEffectiveRole.mockResolvedValue(RoomMemberRole.ADMIN);
      await expect(service.update(OTHER, 'room-1', { name: 'x' })).resolves.toBeDefined();

      permissions.getEffectiveRole.mockResolvedValue(RoomMemberRole.PREMIUM_ADMIN);
      await expect(service.update(OTHER, 'room-1', { name: 'y' })).resolves.toBeDefined();
    });

    it('requires password on creation if isLocked is true', async () => {
      await expect(
        service.create(OWNER, { name: 'Locked', isLocked: true }),
      ).rejects.toBeInstanceOf(BusinessException);
    });

    it('requires password on update if isLocked is true and no existing password', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ isLocked: false, passwordHash: null }));
      await expect(service.update(OWNER, 'room-1', { isLocked: true })).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('clears passwordHash when isLocked is updated to false (unlocked)', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ isLocked: true, passwordHash: 'hashed' }));
      await service.update(OWNER, 'room-1', { isLocked: false });
      expect(repo.updateRoom).toHaveBeenCalledWith(
        'room-1',
        expect.objectContaining({ isLocked: false, passwordHash: null }),
        OWNER.id,
      );
    });

    it('transfers ownership only to an active member', async () => {
      repo.getMember.mockResolvedValue({ isActive: false } as never);
      await expect(
        service.transferOwnership(OWNER, 'room-1', { newOwnerId: OTHER.id }),
      ).rejects.toBeInstanceOf(BusinessException);
    });

    it('transfers ownership to an active member and publishes the event', async () => {
      repo.getMember.mockResolvedValue({ isActive: true, role: RoomMemberRole.AUDIENCE } as never);
      await service.transferOwnership(OWNER, 'room-1', { newOwnerId: OTHER.id });
      expect(repo.setOwner).toHaveBeenCalledWith('room-1', OTHER.id, OWNER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.ownership_transferred' }),
      );
    });
  });

  describe('getMyRoom', () => {
    it("returns the caller's active owned room", async () => {
      repo.findOwnedRoom.mockResolvedValue(roomRow());
      const view = await service.getMyRoom(OWNER);
      expect(repo.findOwnedRoom).toHaveBeenCalledWith(OWNER.id);
      expect(view?.id).toBe('room-1');
    });

    it('returns null when the caller owns no active room', async () => {
      repo.findOwnedRoom.mockResolvedValue(null);
      const view = await service.getMyRoom(OTHER);
      expect(repo.findOwnedRoom).toHaveBeenCalledWith(OTHER.id);
      expect(view).toBeNull();
    });
  });

  describe('end', () => {
    it('ends a room and publishes room.ended', async () => {
      await service.end(OWNER, 'room-1');
      expect(repo.endRoom).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.ended' }),
      );
    });
  });

  describe('start (go live again)', () => {
    /** A room the owner previously ended — the state a "start another live" begins from. */
    const endedRoom = () => roomRow({ status: 'OFFLINE', endedAt: new Date() });

    it('flips an ended room back to LIVE and publishes room.started', async () => {
      repo.findRoomRow.mockResolvedValue(endedRoom());
      repo.updateRoom.mockResolvedValue(roomRow({ status: 'LIVE' }));

      const view = await service.start(OWNER, 'room-1');

      expect(repo.updateRoom).toHaveBeenCalledWith(
        'room-1',
        { status: 'LIVE', endedAt: null },
        OWNER.id,
      );
      expect(view.status).toBe('LIVE');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.started' }),
      );
    });

    it('carries the fields a lobby client needs to render the room without a refetch', async () => {
      repo.findRoomRow.mockResolvedValue(endedRoom());
      repo.updateRoom.mockResolvedValue(roomRow({ status: 'LIVE' }));

      await service.start(OWNER, 'room-1');

      const started = bus.publish.mock.calls
        .map(([event]) => event)
        .find((event) => (event as { name: string }).name === 'audio_room.started');
      expect((started as { payload: Record<string, unknown> }).payload).toEqual(
        expect.objectContaining({
          roomId: 'room-1',
          ownerId: OWNER.id,
          name: 'My Room',
          status: 'LIVE',
          visibility: RoomVisibility.PUBLIC,
          isDiscoverable: true,
        }),
      );
    });

    it('discards runtime state left over from the previous session', async () => {
      repo.findRoomRow.mockResolvedValue(endedRoom());
      presence.roomMembers.mockResolvedValue(['ghost-1', 'ghost-2']);

      await service.start(OWNER, 'room-1');

      expect(presence.leaveRoom).toHaveBeenCalledWith('room-1', 'ghost-1');
      expect(presence.leaveRoom).toHaveBeenCalledWith('room-1', 'ghost-2');
    });

    it('is idempotent on an already-LIVE room: never evicts the current audience', async () => {
      repo.findRoomRow.mockResolvedValue(roomRow({ status: 'LIVE' }));
      presence.roomMembers.mockResolvedValue(['listener-1']);

      await service.start(OWNER, 'room-1');

      expect(presence.leaveRoom).not.toHaveBeenCalled();
    });

    it('refreshes the cached snapshot so reads never serve the ended room', async () => {
      repo.findRoomRow.mockResolvedValue(endedRoom());
      repo.updateRoom.mockResolvedValue(roomRow({ status: 'LIVE' }));

      await service.start(OWNER, 'room-1');

      expect(repo.setCachedSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'room-1', status: 'LIVE' }),
        expect.any(Number),
      );
    });
  });

  describe('create on an existing owned room', () => {
    it('reactivates an ended room instead of handing back the stale one', async () => {
      repo.findOwnedRoom.mockResolvedValue(roomRow({ status: 'OFFLINE', endedAt: new Date() }));
      repo.findRoomRow.mockResolvedValue(roomRow({ status: 'OFFLINE', endedAt: new Date() }));
      repo.updateRoom.mockResolvedValue(roomRow({ status: 'LIVE' }));

      const view = await service.create(OWNER, { name: 'Another' });

      expect(repo.createRoomTx).not.toHaveBeenCalled();
      expect(view.status).toBe('LIVE');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.started' }),
      );
    });

    it('leaves an already-LIVE owned room untouched (no redundant restart)', async () => {
      repo.findOwnedRoom.mockResolvedValue(roomRow({ status: 'LIVE' }));

      const view = await service.create(OWNER, { name: 'Another' });

      expect(view.status).toBe('LIVE');
      expect(repo.updateRoom).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.started' }),
      );
    });
  });

  describe('removeOwner (admin)', () => {
    const member = (userId: string, role: RoomMemberRole, ageMs = 0) =>
      ({ userId, role, joinedAt: new Date(Date.now() - ageMs), isActive: true }) as never;

    it('promotes the highest-ranking active member and demotes the old owner', async () => {
      repo.listActiveMembers.mockResolvedValue([
        member(OWNER.id, RoomMemberRole.OWNER),
        member('user-2', RoomMemberRole.LISTENER),
        member('user-3', RoomMemberRole.SPEAKER),
      ]);
      await service.removeOwner(ADMIN, 'room-1');
      expect(repo.setMemberRole).toHaveBeenCalledWith(
        'room-1',
        OWNER.id,
        RoomMemberRole.LISTENER,
        ADMIN.id,
      );
      expect(repo.setOwner).toHaveBeenCalledWith('room-1', 'user-3', ADMIN.id);
      expect(repo.endRoom).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.ownership_transferred' }),
      );
    });

    it('closes the room when there is no other active member', async () => {
      repo.listActiveMembers.mockResolvedValue([member(OWNER.id, RoomMemberRole.OWNER)]);
      await service.removeOwner(ADMIN, 'room-1');
      expect(repo.setOwner).not.toHaveBeenCalled();
      expect(repo.endRoom).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.ended' }),
      );
    });

    it('rejects a non-owner non-admin caller', async () => {
      await expect(service.removeOwner(OTHER, 'room-1')).rejects.toBeInstanceOf(BusinessException);
    });
  });
});
