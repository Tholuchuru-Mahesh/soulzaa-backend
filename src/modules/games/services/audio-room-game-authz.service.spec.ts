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
    it('allows an OWNER in a live room', async () => {
      rooms.getEffectiveRole.mockResolvedValue(RoomMemberRole.OWNER);
      await expect(svc.assertCanStartBoardGame(ROOM, USER)).resolves.toBeUndefined();
    });

    it('allows an ADMIN and PREMIUM_ADMIN in a live room', async () => {
      rooms.getEffectiveRole.mockResolvedValue(RoomMemberRole.ADMIN);
      await expect(svc.assertCanStartBoardGame(ROOM, USER)).resolves.toBeUndefined();
      rooms.getEffectiveRole.mockResolvedValue(RoomMemberRole.PREMIUM_ADMIN);
      await expect(svc.assertCanStartBoardGame(ROOM, USER)).resolves.toBeUndefined();
    });

    it('rejects a LISTENER / SPEAKER / non-member', async () => {
      for (const role of [RoomMemberRole.LISTENER, RoomMemberRole.SPEAKER, null]) {
        rooms.getEffectiveRole.mockResolvedValue(role);
        await expect(svc.assertCanStartBoardGame(ROOM, USER)).rejects.toMatchObject({
          errorCode: ERROR_CODES.GAME_NOT_AUTHORIZED,
        });
      }
    });

    it('rejects a manager when the room is not live', async () => {
      rooms.getEffectiveRole.mockResolvedValue(RoomMemberRole.OWNER);
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
