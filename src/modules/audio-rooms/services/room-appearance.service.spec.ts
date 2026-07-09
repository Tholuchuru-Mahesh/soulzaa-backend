import { CosmeticType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import type { IBackpackService } from 'src/modules/backpack/interfaces/backpack.service.interface';
import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { RoomAppearanceRepository } from '../repositories/room-appearance.repository';
import { RoomPermissionService } from './room-permission.service';
import { RoomAppearanceService } from './room-appearance.service';

const OWNER: RoomActor = { id: 'owner-1', roles: ['USER'] };
const ROOM = 'room-1';
const THEME_ID = '11111111-1111-1111-1111-111111111111';

function cosmetic(type: CosmeticType) {
  return { id: THEME_ID, type, name: 'Galaxy Theme', enabled: true };
}

describe('RoomAppearanceService', () => {
  let repo: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let backpack: Record<string, jest.Mock>;
  let cosmetics: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let service: RoomAppearanceService;

  beforeEach(() => {
    repo = {
      get: jest.fn().mockResolvedValue(null),
      setTheme: jest.fn().mockImplementation((roomId, themeCosmeticId, themeName, updatedBy) =>
        Promise.resolve({
          roomId,
          themeCosmeticId,
          themeName,
          decorationCosmeticIds: [],
          decorationNames: [],
          updatedBy,
        }),
      ),
      setDecorations: jest.fn().mockResolvedValue({
        roomId: ROOM,
        themeCosmeticId: null,
        themeName: null,
        decorationCosmeticIds: [THEME_ID],
        decorationNames: ['Deco'],
        updatedBy: OWNER.id,
      }),
      reset: jest.fn().mockResolvedValue({
        roomId: ROOM,
        themeCosmeticId: null,
        themeName: null,
        decorationCosmeticIds: [],
        decorationNames: [],
        updatedBy: OWNER.id,
      }),
    };
    permissions = { getEffectiveRole: jest.fn().mockResolvedValue('OWNER') };
    backpack = { ownsCosmetic: jest.fn().mockResolvedValue(true) };
    cosmetics = { getCosmetic: jest.fn().mockResolvedValue(cosmetic(CosmeticType.THEME)) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new RoomAppearanceService(
      repo as unknown as RoomAppearanceRepository,
      permissions as unknown as RoomPermissionService,
      backpack as unknown as IBackpackService,
      cosmetics as unknown as ICosmeticsService,
      bus,
    );
  });

  describe('applyTheme', () => {
    it('applies an owned THEME and broadcasts', async () => {
      await service.applyTheme(OWNER, ROOM, THEME_ID);
      expect(repo.setTheme).toHaveBeenCalledWith(ROOM, THEME_ID, 'Galaxy Theme', OWNER.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.appearance_updated' }),
      );
    });

    it('rejects a non owner/admin', async () => {
      permissions.getEffectiveRole.mockResolvedValue('LISTENER');
      await expect(service.applyTheme(OWNER, ROOM, THEME_ID)).rejects.toMatchObject({
        errorCode: 'APPEARANCE_NOT_AUTHORIZED',
      });
    });

    it('rejects a cosmetic the user does not own', async () => {
      backpack.ownsCosmetic.mockResolvedValue(false);
      await expect(service.applyTheme(OWNER, ROOM, THEME_ID)).rejects.toMatchObject({
        errorCode: 'COSMETIC_NOT_OWNED',
      });
    });

    it('rejects a cosmetic of the wrong type', async () => {
      cosmetics.getCosmetic.mockResolvedValue(cosmetic(CosmeticType.FRAME));
      await expect(service.applyTheme(OWNER, ROOM, THEME_ID)).rejects.toMatchObject({
        errorCode: 'COSMETIC_WRONG_TYPE',
      });
    });
  });

  describe('setDecorations', () => {
    it('applies owned DECORATION cosmetics', async () => {
      cosmetics.getCosmetic.mockResolvedValue(cosmetic(CosmeticType.DECORATION));
      await service.setDecorations(OWNER, ROOM, [THEME_ID]);
      expect(repo.setDecorations).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.appearance_updated' }),
      );
    });
  });

  describe('reset', () => {
    it('clears the appearance and broadcasts', async () => {
      await service.reset(OWNER, ROOM);
      expect(repo.reset).toHaveBeenCalledWith(ROOM, OWNER.id);
      expect(bus.publish).toHaveBeenCalled();
    });
  });
});
