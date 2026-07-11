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
