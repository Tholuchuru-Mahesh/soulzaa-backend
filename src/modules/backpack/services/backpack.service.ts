import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BackpackItem, BackpackItemType, Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
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
import { PROFILE_SERVICE, IProfileService } from 'src/modules/users/interfaces/profile.interface';

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
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    private readonly media: MediaUrlResolver,
  ) {}

  // ---- IBackpackService (cross-module grant seam) ----

  async grant(input: GrantItemInput, tx?: Prisma.TransactionClient): Promise<GrantItemResult> {
    const byKey = await this.repo.findByGrantKey(input.grantKey, tx);
    if (byKey) return { itemId: byKey.id, duplicate: true };

    // Detect existing ownership by refId to merge duplicate rewards/gifts without creating duplicate rows
    if (input.refId) {
      const existing = await this.repo.findByUserIdAndRefId(input.userId, input.refId, tx);
      if (existing) {
        let newExpiresAt: Date | null = existing.expiresAt;

        if (input.expiresAt === null || existing.expiresAt === null) {
          newExpiresAt = null;
        } else if (input.expiresAt !== undefined && existing.expiresAt) {
          const now = new Date();
          const base = existing.expiresAt > now ? existing.expiresAt : now;
          const additionalMs = input.expiresAt.getTime() - now.getTime();
          newExpiresAt = new Date(base.getTime() + (additionalMs > 0 ? additionalMs : 0));
        } else if (input.expiresAt !== undefined) {
          newExpiresAt = input.expiresAt;
        }

        const effectiveTransferable =
          input.source === 'GIFT' || input.transferable === false ? false : existing.transferable;

        const updated = await this.repo.updateItem(
          existing.id,
          {
            expiresAt: newExpiresAt,
            transferable: effectiveTransferable,
            quantity: existing.quantity + (input.quantity ?? 1),
            ...(input.metadata !== undefined
              ? { metadata: input.metadata as Prisma.InputJsonValue }
              : {}),
          },
          tx,
        );

        await this.repo.log(
          input.userId,
          BACKPACK_ACTIONS.GRANTED,
          updated.id,
          {
            type: updated.type,
            source: input.source,
            merged: true,
            previousExpiresAt: existing.expiresAt,
            newExpiresAt: updated.expiresAt,
          },
          tx,
        );

        await this.bus.publish(
          new BackpackItemGrantedEvent({
            userId: updated.userId,
            itemId: updated.id,
            type: updated.type,
            name: updated.name,
            source: input.source,
          }),
        );

        return { itemId: updated.id, duplicate: true };
      }
    }

    const item = await this.repo.create(
      {
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
      },
      tx,
    );
    await this.repo.log(
      input.userId,
      BACKPACK_ACTIONS.GRANTED,
      item.id,
      {
        type: item.type,
        source: item.source,
      },
      tx,
    );
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
  ): Promise<{
    itemId: string;
    cosmeticId: string | null;
    name: string;
    mediaUrl?: string | null;
  } | null> {
    const item = await this.repo.findEquippedByType(userId, type);
    if (!item) return null;
    const metadata = (item.metadata as Record<string, any>) || {};
    let mediaUrl = metadata.mediaUrl || metadata.animationUrl || null;
    if (!mediaUrl && item.refId) {
      const cosmetic = await this.repo.findCosmeticById(item.refId);
      if (cosmetic) mediaUrl = cosmetic.mediaUrl;
    }
    // Stored media is a raw S3 key, not a servable URL (see MediaUrlResolver) —
    // every other read path (catalog list, backpack preview) resolves it before
    // handing it to a client; this is the one that fed a socket broadcast
    // straight from the DB, so equipped effects silently failed to load in-room.
    mediaUrl = await this.media.resolve(mediaUrl);
    return { itemId: item.id, cosmeticId: item.refId, name: item.name, mediaUrl };
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
    const views = await Promise.all(rows.map((i) => this.toView(i)));
    return buildPaginated(views, total, q.page, q.limit);
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
      await this.repo.unequipType(userId, item.type);
      await this.repo.setEquipped(itemId, true);
      await this.repo.log(userId, BACKPACK_ACTIONS.EQUIPPED, itemId, { type: item.type });
      await this.profiles.invalidateProfile(userId);
      await this.bus.publish(new BackpackItemEquippedEvent({ userId, itemId, type: item.type }));
    });
  }

  async unequip(userId: string, itemId: string): Promise<void> {
    await this.locks.withLock(backpackLockKey(userId), async () => {
      const item = await this.ownedItem(userId, itemId);
      await this.repo.setEquipped(itemId, false);
      await this.repo.log(userId, BACKPACK_ACTIONS.UNEQUIPPED, itemId, { type: item.type });
      await this.profiles.invalidateProfile(userId);
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

      // Check if recipient already has an active item with the same refId to merge expiry
      if (item.refId) {
        const existingRecipientItem = await this.repo.findByUserIdAndRefId(toUserId, item.refId);
        let newExpiresAt: Date | null = item.expiresAt;
        if (existingRecipientItem) {
          if (item.expiresAt === null || existingRecipientItem.expiresAt === null) {
            newExpiresAt = null;
          } else if (item.expiresAt && existingRecipientItem.expiresAt) {
            const now = new Date();
            const base =
              existingRecipientItem.expiresAt > now ? existingRecipientItem.expiresAt : now;
            const remainingMs = item.expiresAt.getTime() - now.getTime();
            newExpiresAt = new Date(base.getTime() + (remainingMs > 0 ? remainingMs : 0));
          }

          await this.repo.updateItem(existingRecipientItem.id, {
            expiresAt: newExpiresAt,
            transferable: false,
            source: 'GIFT',
            quantity: existingRecipientItem.quantity + item.quantity,
          });

          await this.repo.deleteItem(itemId);

          // Sync UserCosmetic table: remove from sender, merge into recipient
          await this.repo.syncUserCosmeticsOnTransfer({
            fromUserId: userId,
            toUserId,
            cosmeticId: item.refId,
            expiresAt: newExpiresAt,
            wasEquipped: item.equipped,
          });

          await this.repo.log(userId, BACKPACK_ACTIONS.TRANSFERRED_OUT, itemId, { toUserId });
          await this.repo.log(toUserId, BACKPACK_ACTIONS.TRANSFERRED_IN, existingRecipientItem.id, {
            fromUserId: userId,
            merged: true,
            newExpiresAt,
          });
          await this.profiles.invalidateProfile(userId);
          await this.profiles.invalidateProfile(toUserId);
          await this.bus.publish(
            new BackpackItemTransferredEvent({
              fromUserId: userId,
              toUserId,
              itemId,
              newItemId: existingRecipientItem.id,
            }),
          );
          return;
        }

        const moved = await this.repo.transfer(itemId, toUserId);

        // Sync UserCosmetic table: remove from sender, grant to recipient
        await this.repo.syncUserCosmeticsOnTransfer({
          fromUserId: userId,
          toUserId,
          cosmeticId: item.refId,
          expiresAt: item.expiresAt,
          wasEquipped: item.equipped,
        });

        await this.repo.log(userId, BACKPACK_ACTIONS.TRANSFERRED_OUT, itemId, { toUserId });
        await this.repo.log(toUserId, BACKPACK_ACTIONS.TRANSFERRED_IN, moved.id, {
          fromUserId: userId,
        });
        await this.profiles.invalidateProfile(userId);
        await this.profiles.invalidateProfile(toUserId);
        await this.bus.publish(
          new BackpackItemTransferredEvent({
            fromUserId: userId,
            toUserId,
            itemId,
            newItemId: moved.id,
          }),
        );
        return;
      }

      const moved = await this.repo.transfer(itemId, toUserId);
      await this.repo.log(userId, BACKPACK_ACTIONS.TRANSFERRED_OUT, itemId, { toUserId });
      await this.repo.log(toUserId, BACKPACK_ACTIONS.TRANSFERRED_IN, moved.id, {
        fromUserId: userId,
      });
      await this.profiles.invalidateProfile(userId);
      await this.profiles.invalidateProfile(toUserId);
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

  private async toView(i: BackpackItem) {
    const meta = (i.metadata as Record<string, any>) || {};
    let mediaUrl = meta.mediaUrl;
    let thumbnailUrl = meta.thumbnailUrl;
    if (mediaUrl) mediaUrl = await this.media.resolve(mediaUrl);
    if (thumbnailUrl) thumbnailUrl = await this.media.resolve(thumbnailUrl);

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
      mediaUrl,
      thumbnailUrl,
      metadata: {
        ...meta,
        mediaUrl,
        thumbnailUrl,
      },
    };
  }
}
