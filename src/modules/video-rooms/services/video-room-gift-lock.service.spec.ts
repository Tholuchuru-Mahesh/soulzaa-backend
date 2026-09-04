import { HttpStatus } from '@nestjs/common';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomGiftLockService } from './video-room-gift-lock.service';

describe('VideoRoomGiftLockService', () => {
  let service: VideoRoomGiftLockService;
  let repo: any;
  let permissions: any;
  let gifts: any;
  let bus: any;
  let actor: any;

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue({ id: 'room-1', ownerId: 'owner-1' }),
      updateRoom: jest.fn().mockResolvedValue(undefined),
      appendLog: jest.fn().mockResolvedValue(undefined),
      clearCachedSnapshot: jest.fn().mockResolvedValue(undefined),
    };
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    gifts = { isGiftEnabled: jest.fn().mockResolvedValue(true) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    actor = { id: 'owner-1', roles: [] };

    service = new VideoRoomGiftLockService(repo, permissions, gifts, bus, {
      getDetail: jest.fn().mockResolvedValue({ id: 'room-1' }),
    } as any);
  });

  describe('enable', () => {
    it('throws when the room does not exist', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.enable(actor, 'room-404', 'gift-1')).rejects.toThrow(BusinessException);
    });

    it('asserts LOCK_ROOM permission before writing', async () => {
      await service.enable(actor, 'room-1', 'gift-1');
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        { id: 'room-1', ownerId: 'owner-1' },
        VideoRoomPermission.LOCK_ROOM,
      );
    });

    it('rejects a gift that is not an active catalog gift', async () => {
      gifts.isGiftEnabled.mockResolvedValueOnce(false);
      await expect(service.enable(actor, 'room-1', 'gift-bad')).rejects.toThrow(BusinessException);
      expect(repo.updateRoom).not.toHaveBeenCalled();
    });

    it('persists giftLockEnabled + requiredEntryGiftId and logs GIFT_LOCK_ENABLED', async () => {
      await service.enable(actor, 'room-1', 'gift-1');
      expect(repo.updateRoom).toHaveBeenCalledWith(
        'room-1',
        { giftLockEnabled: true, requiredEntryGiftId: 'gift-1' },
        'owner-1',
      );
      expect(repo.appendLog).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: 'room-1', action: 'GIFT_LOCK_ENABLED' }),
      );
    });

    it('publishes GiftLockEnabledEvent', async () => {
      await service.enable(actor, 'room-1', 'gift-1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'video_room.gift_lock_enabled',
          payload: expect.objectContaining({ roomId: 'room-1', giftId: 'gift-1' }),
        }),
      );
    });

    it('clears the cached detail snapshot before returning the fresh view', async () => {
      await service.enable(actor, 'room-1', 'gift-1');
      expect(repo.clearCachedSnapshot).toHaveBeenCalledWith('room-1');
    });
  });

  describe('disable', () => {
    it('asserts LOCK_ROOM permission and clears both fields', async () => {
      await service.disable(actor, 'room-1');
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        actor,
        { id: 'room-1', ownerId: 'owner-1' },
        VideoRoomPermission.LOCK_ROOM,
      );
      expect(repo.updateRoom).toHaveBeenCalledWith(
        'room-1',
        { giftLockEnabled: false, requiredEntryGiftId: null },
        'owner-1',
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.gift_lock_disabled' }),
      );
    });

    it('clears the cached detail snapshot before returning the fresh view', async () => {
      await service.disable(actor, 'room-1');
      expect(repo.clearCachedSnapshot).toHaveBeenCalledWith('room-1');
    });
  });
});
