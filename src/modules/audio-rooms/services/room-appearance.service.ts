import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CosmeticType, RoomAppearance, RoomMemberRole } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  BACKPACK_SERVICE,
  type IBackpackService,
} from 'src/modules/backpack/interfaces/backpack.service.interface';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { RoomAppearanceUpdatedEvent } from '../events/audio-room-appearance.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { RoomAppearanceRepository } from '../repositories/room-appearance.repository';
import { RoomPermissionService } from './room-permission.service';

const MANAGER_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

const THEME_PRESETS = new Map<string, string>([
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab1', 'Sunlight'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab2', 'Galaxy'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab3', 'Sunset Glow'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab4', 'Royal Purple'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab5', 'Nature'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab6', 'Ocean Breeze'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab7', 'Golden Luxury'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eab8', 'Neon Cyber'],

  // Nature Collection
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac1', 'Golden Sunrise'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac2', 'Crystal Beach'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac3', 'Paradise Island'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac4', 'Sakura Garden'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac5', 'Autumn Forest'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac6', 'Misty Forest'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac7', 'Snow Mountains'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eac8', 'Lavender Fields'],

  // Night Collection
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0ead1', 'Galaxy Space'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0ead2', 'Moonlight Lake'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0ead3', 'Aurora Borealis'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0ead4', 'Tokyo Night'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0ead5', 'Cyber Neon City'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0ead6', 'Purple Skyline'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0ead7', 'Rainy Night Street'],

  // Luxury Collection
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eae1', 'Luxury Royal Purple'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eae2', 'Golden Palace'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eae3', 'Velvet Gradient'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eae4', 'Crystal Glass'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eae5', 'Silk Gradient'],

  // Fantasy Collection
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eaf1', 'Fantasy Kingdom'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eaf2', 'Mystic Temple'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eaf3', 'Dragon Realm'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eaf4', 'Celestial Dream'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eaf5', 'Ancient Castle'],

  // Abstract Collection
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb01', 'Liquid Purple'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb02', 'Neon Waves'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb03', 'Glass Geometry'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb04', 'Cosmic Purple'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb05', 'Deep Ocean Night'],

  // Colors Collection
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb10', 'Purple Gradient'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb11', 'Blue Gradient'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb12', 'Emerald'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb13', 'Royal Gold'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb14', 'Neon Pink'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb15', 'Ocean Blue'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb16', 'Rose Sunset'],
  ['e1f8638c-fe89-4680-9c7f-4db1e6b0eb20', 'Pure White'],

  // Solid Color Themes
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e001', 'Royal Purple'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e002', 'Deep Purple'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e003', 'Lavender'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e004', 'Indigo'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e005', 'Sapphire Blue'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e006', 'Ocean Blue'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e007', 'Sky Blue'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e008', 'Cyan'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e009', 'Emerald Green'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e00a', 'Forest Green'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e00b', 'Mint Green'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e00c', 'Lime Green'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e00d', 'Golden Yellow'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e00e', 'Amber'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e00f', 'Orange'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e010', 'Coral'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e011', 'Crimson Red'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e012', 'Ruby Red'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e013', 'Rose Pink'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e014', 'Hot Pink'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e015', 'Magenta'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e016', 'Brown'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e017', 'Slate Grey'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e018', 'Charcoal Black'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e019', 'White'],

  // Gradient Color Themes
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e101', 'Royal Purple to Violet'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e102', 'Purple to Pink'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e103', 'Blue to Cyan'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e104', 'Ocean Blue to Turquoise'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e105', 'Emerald to Mint'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e106', 'Forest Green to Emerald'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e107', 'Sunset Orange to Pink'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e108', 'Peach to Orange'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e109', 'Gold to Orange'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e10a', 'Crimson to Purple'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e10b', 'Rose Gold'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e10c', 'Midnight Blue to Purple'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e10d', 'Black to Purple'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e10e', 'Galaxy Purple'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e10f', 'Cosmic Blue'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e110', 'Neon Pink to Blue'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e111', 'Aurora Green to Blue'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e112', 'Lavender to Pink'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e113', 'Fire Orange to Red'],
  ['c010c010-f1d8-4680-9c7f-4db1e6b0e114', 'Silk Purple Gradient'],
]);

/** Max decorations applied to a room at once. */
const MAX_DECORATIONS = 10;

/**
 * Room appearance (AR-8): the owner/admin applies a THEME (background) and
 * DECORATION cosmetics they own in their backpack to the room. Ownership is
 * verified via BACKPACK_SERVICE and the cosmetic type via COSMETICS_SERVICE; the
 * active appearance is persisted and broadcast to participants (bridged to the
 * `/audio-room` socket). Reset clears it.
 */
@Injectable()
export class RoomAppearanceService {
  constructor(
    private readonly repo: RoomAppearanceRepository,
    private readonly permissions: RoomPermissionService,
    @Inject(BACKPACK_SERVICE) private readonly backpack: IBackpackService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async getAppearance(roomId: string): Promise<unknown> {
    const row = await this.repo.get(roomId);
    return this.toView(roomId, row);
  }

  async applyTheme(actor: RoomActor, roomId: string, cosmeticId: string): Promise<unknown> {
    await this.assertManager(roomId, actor);
    const cosmetic = await this.assertOwnedCosmetic(actor.id, cosmeticId, CosmeticType.THEME);
    const row = await this.repo.setTheme(roomId, cosmeticId, cosmetic.name, actor.id);
    return this.publish(roomId, row, actor.id);
  }

  async removeTheme(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.assertManager(roomId, actor);
    const row = await this.repo.setTheme(roomId, null, null, actor.id);
    return this.publish(roomId, row, actor.id);
  }

  async setDecorations(actor: RoomActor, roomId: string, cosmeticIds: string[]): Promise<unknown> {
    await this.assertManager(roomId, actor);
    const unique = [...new Set(cosmeticIds)].slice(0, MAX_DECORATIONS);
    const names: string[] = [];
    for (const id of unique) {
      const cosmetic = await this.assertOwnedCosmetic(actor.id, id, CosmeticType.DECORATION);
      names.push(cosmetic.name);
    }
    const row = await this.repo.setDecorations(roomId, unique, names, actor.id);
    return this.publish(roomId, row, actor.id);
  }

  async reset(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.assertManager(roomId, actor);
    const row = await this.repo.reset(roomId, actor.id);
    return this.publish(roomId, row, actor.id);
  }

  // ---- Internals ----

  private async assertManager(roomId: string, actor: RoomActor): Promise<void> {
    const role = await this.permissions.getEffectiveRole(roomId, actor.id);
    if (!role || !MANAGER_ROLES.has(role)) {
      throw new BusinessException(
        ERROR_CODES.APPEARANCE_NOT_AUTHORIZED,
        'Only the room owner or an admin can change the room appearance.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertOwnedCosmetic(
    userId: string,
    cosmeticId: string,
    expectedType: CosmeticType,
  ): Promise<{ name: string }> {
    const presetName = THEME_PRESETS.get(cosmeticId);
    if (presetName) {
      return { name: presetName };
    }
    if (cosmeticId.startsWith('preset_')) {
      return { name: cosmeticId.substring(7) };
    }
    const cosmetic = await this.cosmetics.getCosmetic(cosmeticId);
    if (!cosmetic || !cosmetic.enabled) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'Cosmetic not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (cosmetic.type !== expectedType) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_WRONG_TYPE,
        `Expected a ${expectedType} cosmetic.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!(await this.backpack.ownsCosmetic(userId, cosmeticId))) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_OWNED,
        'You do not own this cosmetic.',
        HttpStatus.FORBIDDEN,
      );
    }
    return { name: cosmetic.name };
  }

  private async publish(roomId: string, row: RoomAppearance, updatedBy: string): Promise<unknown> {
    await this.bus.publish(
      new RoomAppearanceUpdatedEvent({
        roomId,
        themeCosmeticId: row.themeCosmeticId,
        themeName: row.themeName,
        decorationCosmeticIds: row.decorationCosmeticIds,
        decorationNames: row.decorationNames,
        updatedBy,
      }),
    );
    return this.toView(roomId, row);
  }

  private toView(roomId: string, row: RoomAppearance | null) {
    return {
      roomId,
      themeCosmeticId: row?.themeCosmeticId ?? null,
      themeName: row?.themeName ?? null,
      decorationCosmeticIds: row?.decorationCosmeticIds ?? [],
      decorationNames: row?.decorationNames ?? [],
    };
  }
}
