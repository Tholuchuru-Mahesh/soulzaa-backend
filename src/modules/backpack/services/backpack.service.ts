import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BackpackItem, BackpackItemType, Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import {
  BACKPACK_ACTIONS,
  EQUIPPABLE_TYPES,
  backpackLockKey,
} from '../constants/backpack.constants';
import {
  BackpackItemEquippedEvent,
  BackpackItemGrantedEvent,
  BackpackItemTransferredEvent,
  BackpackItemUnequippedEvent,
} from '../events/backpack.events';
import type {
  GrantItemInput,
  GrantItemResult,
  IBackpackService,
} from '../interfaces/backpack.service.interface';
import { BackpackRepository } from '../repositories/backpack.repository';

/**
 * The backpack: a user's inventory of earned non-coin rewards. Grants are
 * idempotent (a replay returns the original item). Equipping enforces one item
 * per equippable type per user, under a per-user lock; transfers move a
 * transferable item to another user. Every action appends an immutable log row.
 */
@Injectable()
export class BackpackService implements IBackpackService {
  constructor(
    private readonly repo: BackpackRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  // ---- IBackpackService (cross-module grant seam) ----

  async grant(input: GrantItemInput): Promise<GrantItemResult> {
    const existing = await this.repo.findByGrantKey(input.grantKey);
    if (existing) return { itemId: existing.id, duplicate: true };

    const item = await this.repo.create({
      userId: input.userId,
      type: input.type,
      refId: input.refId ?? null,
      name: input.name,
      source: input.source,
      quantity: input.quantity ?? 1,
      transferable: input.transferable ?? false,
      grantKey: input.grantKey,
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Prisma.InputJsonValue }
        : {}),
      expiresAt: input.expiresAt ?? null,
    });
    await this.repo.log(input.userId, BACKPACK_ACTIONS.GRANTED, item.id, {
      type: item.type,
      source: item.source,
    });
    await this.bus.publish(
      new BackpackItemGrantedEvent({
        userId: item.userId,
        itemId: item.id,
        type: item.type,
        name: item.name,
        source: item.source,
      }),
    );
    return { itemId: item.id, duplicate: false };
  }

  async getEquipped(
    userId: string,
    type: BackpackItemType,
  ): Promise<{ itemId: string; cosmeticId: string | null; name: string } | null> {
    const item = await this.repo.findEquippedByType(userId, type);
    if (!item) return null;
    return { itemId: item.id, cosmeticId: item.refId, name: item.name };
  }

  ownsCosmetic(userId: string, cosmeticId: string): Promise<boolean> {
    return this.repo.ownsRef(userId, cosmeticId);
  }

  // ---- User actions ----

  async list(
    userId: string,
    q: { skip: number; limit: number; page: number; type?: BackpackItemType; equipped?: boolean },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listItems(userId, q.skip, q.limit, {
      type: q.type,
      equipped: q.equipped,
    });
    return buildPaginated(
      rows.map((i) => this.toView(i)),
      total,
      q.page,
      q.limit,
    );
  }

  async equip(userId: string, itemId: string): Promise<void> {
    await this.locks.withLock(backpackLockKey(userId), async () => {
      const item = await this.ownedItem(userId, itemId);
      if (!EQUIPPABLE_TYPES.has(item.type)) {
        throw new BusinessException(
          ERROR_CODES.BACKPACK_ITEM_NOT_EQUIPPABLE,
          'This item cannot be equipped.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (this.isExpired(item)) {
        throw new BusinessException(
          ERROR_CODES.BACKPACK_ITEM_EXPIRED,
          'This item has expired.',
          HttpStatus.CONFLICT,
        );
      }
      // One equipped item per type: unequip the rest first.
      await this.repo.unequipType(userId, item.type);
      await this.repo.setEquipped(itemId, true);
      await this.repo.log(userId, BACKPACK_ACTIONS.EQUIPPED, itemId, { type: item.type });
      await this.bus.publish(new BackpackItemEquippedEvent({ userId, itemId, type: item.type }));
    });
  }

  async unequip(userId: string, itemId: string): Promise<void> {
    await this.locks.withLock(backpackLockKey(userId), async () => {
      const item = await this.ownedItem(userId, itemId);
      await this.repo.setEquipped(itemId, false);
      await this.repo.log(userId, BACKPACK_ACTIONS.UNEQUIPPED, itemId, { type: item.type });
      await this.bus.publish(new BackpackItemUnequippedEvent({ userId, itemId, type: item.type }));
    });
  }

  async transfer(userId: string, itemId: string, toUserId: string): Promise<void> {
    if (userId === toUserId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_TRANSFER_SELF,
        'You cannot transfer an item to yourself.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.locks.withLock(backpackLockKey(userId), async () => {
      const item = await this.ownedItem(userId, itemId);
      if (!item.transferable) {
        throw new BusinessException(
          ERROR_CODES.BACKPACK_ITEM_NOT_TRANSFERABLE,
          'This item cannot be transferred.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (this.isExpired(item)) {
        throw new BusinessException(
          ERROR_CODES.BACKPACK_ITEM_EXPIRED,
          'This item has expired.',
          HttpStatus.CONFLICT,
        );
      }
      const moved = await this.repo.transfer(itemId, toUserId);
      await this.repo.log(userId, BACKPACK_ACTIONS.TRANSFERRED_OUT, itemId, { toUserId });
      await this.repo.log(toUserId, BACKPACK_ACTIONS.TRANSFERRED_IN, moved.id, {
        fromUserId: userId,
      });
      await this.bus.publish(
        new BackpackItemTransferredEvent({
          fromUserId: userId,
          toUserId,
          itemId,
          newItemId: moved.id,
        }),
      );
    });
  }

  async history(
    userId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listLogs(userId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  // ---- Internals ----

  private async ownedItem(userId: string, itemId: string): Promise<BackpackItem> {
    const item = await this.repo.getItem(itemId);
    if (!item || item.userId !== userId) {
      throw new BusinessException(
        ERROR_CODES.BACKPACK_ITEM_NOT_FOUND,
        'Item not found in your backpack.',
        HttpStatus.NOT_FOUND,
      );
    }
    return item;
  }

  private isExpired(item: BackpackItem): boolean {
    return item.expiresAt !== null && item.expiresAt.getTime() <= Date.now();
  }

  private toView(i: BackpackItem) {
    return {
      id: i.id,
      type: i.type,
      refId: i.refId,
      name: i.name,
      source: i.source,
      quantity: i.quantity,
      equipped: i.equipped,
      transferable: i.transferable,
      acquiredAt: i.acquiredAt,
      expiresAt: i.expiresAt,
    };
  }
}
