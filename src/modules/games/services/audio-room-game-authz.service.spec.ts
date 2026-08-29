import { HttpStatus } from '@nestjs/common';
import { RoomMemberRole } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { type IAudioRoomsService } from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import { AudioRoomGameAuthzService } from './audio-room-game-authz.service';

const ROOM = 'room-1';
const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('AudioRoomGameAuthzService', () => {
  let rooms: Record<string, jest.Mock>;
  let svc: AudioRoomGameAuthzService;

  beforeEach(() => {
    rooms = {
      getEffectiveRole: jest.fn().mockResolvedValue(null),
      getOwnerId: jest.fn().mockResolvedValue(null),
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn().mockResolvedValue(undefined),
      isMember: jest.fn().mockResolvedValue(false),
    };
    svc = new AudioRoomGameAuthzService(rooms as unknown as IAudioRoomsService);
  });

  describe('assertCanStartBoardGame', () => {
    it('allows the room owner in a live room', async () => {
      rooms.getOwnerId.mockResolvedValue(USER);
      await expect(svc.assertCanStartBoardGame(ROOM, USER)).resolves.toBeUndefined();
    });

    // Deliberately tighter than it used to be. A game takes over the room's
    // whole Game Area for everyone in it and escrows the players' stakes, so
    // it is the owner's call — an ADMIN or PREMIUM_ADMIN moderating the room
    // is not entitled to start one on their behalf.
    it('rejects an ADMIN / PREMIUM_ADMIN who is not the owner', async () => {
      rooms.getOwnerId.mockResolvedValue(OTHER);
      for (const role of [RoomMemberRole.ADMIN, RoomMemberRole.PREMIUM_ADMIN]) {
        rooms.getEffectiveRole.mockResolvedValue(role);
        await expect(svc.assertCanStartBoardGame(ROOM, USER)).rejects.toMatchObject({
          errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
        });
      }
    });

    it('rejects a SPEAKER, a LISTENER and a non-member', async () => {
      for (const owner of [OTHER, null]) {
        rooms.getOwnerId.mockResolvedValue(owner);
        await expect(svc.assertCanStartBoardGame(ROOM, USER)).rejects.toMatchObject({
          errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
        });
      }
    });

    it('rejects the owner when the room is not live', async () => {
      rooms.getOwnerId.mockResolvedValue(USER);
      rooms.isRoomLive.mockResolvedValue(false);
      await expect(svc.assertCanStartBoardGame(ROOM, USER)).rejects.toMatchObject({
        errorCode: ERROR_CODES.ROOM_ENDED,
        status: HttpStatus.CONFLICT,
      });
    });
  });

  describe('assertCanStartCasinoWindow', () => {
    it('allows only the exact room owner in a live room', async () => {
      rooms.getOwnerId.mockResolvedValue(USER);
      await expect(svc.assertCanStartCasinoWindow(ROOM, USER)).resolves.toBeUndefined();
    });

    it('rejects a non-owner (admin, listener, stranger)', async () => {
      rooms.getOwnerId.mockResolvedValue(OTHER);
      await expect(svc.assertCanStartCasinoWindow(ROOM, USER)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
      });
    });

    it('rejects the owner when the room is not live', async () => {
      rooms.getOwnerId.mockResolvedValue(USER);
      rooms.isRoomLive.mockResolvedValue(false);
      await expect(svc.assertCanStartCasinoWindow(ROOM, USER)).rejects.toMatchObject({
        errorCode: ERROR_CODES.ROOM_ENDED,
      });
    });

    it('rejects when the room does not exist', async () => {
      rooms.getOwnerId.mockResolvedValue(null);
      await expect(svc.assertCanStartCasinoWindow(ROOM, USER)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
      });
    });
  });

  describe('assertCanWatch', () => {
    it('delegates to rooms.assertMember and rethrows NOT_ROOM_MEMBER for strangers', async () => {
      await expect(svc.assertCanWatch(ROOM, USER)).resolves.toBeUndefined();
      rooms.assertMember.mockRejectedValue(
        new BusinessException(ERROR_CODES.NOT_ROOM_MEMBER, 'not a member', HttpStatus.FORBIDDEN),
      );
      await expect(svc.assertCanWatch(ROOM, USER)).rejects.toMatchObject({
        errorCode: ERROR_CODES.NOT_ROOM_MEMBER,
      });
      expect(rooms.assertMember).toHaveBeenCalledWith(ROOM, USER);
    });
  });

  describe('isMember', () => {
    it('returns the room membership verdict', async () => {
      rooms.isMember.mockResolvedValue(true);
      await expect(svc.isMember(ROOM, USER)).resolves.toBe(true);
      rooms.isMember.mockResolvedValue(false);
      await expect(svc.isMember(ROOM, USER)).resolves.toBe(false);
    });
  });
});
