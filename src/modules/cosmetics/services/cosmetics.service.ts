import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { BackpackItemType, Cosmetic, CosmeticType, Prisma } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  BackpackItemEquippedEvent,
  BackpackItemUnequippedEvent,
} from 'src/modules/backpack/events/backpack.events';
import { FrameProcessorService } from 'src/infra/storage/frame-processor.service';
import { S3Service } from 'src/infra/storage/s3.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import {
  BACKPACK_SERVICE,
  type IBackpackService,
} from 'src/modules/backpack/interfaces/backpack.service.interface';
import type { CosmeticDto, ListCosmeticsDto, UpdateCosmeticDto } from '../dto/cosmetics.dto';
import type {
  CosmeticGrantResult,
  ICosmeticsService,
} from '../interfaces/cosmetics.service.interface';
import { CosmeticsRepository } from '../repositories/cosmetics.repository';

/** Cosmetic types map 1:1 to backpack item types (same member names). */
const TO_BACKPACK_TYPE: Record<CosmeticType, BackpackItemType> = {
  FRAME: BackpackItemType.FRAME,
  BADGE: BackpackItemType.BADGE,
  ENTRANCE_EFFECT: BackpackItemType.ENTRANCE_EFFECT,
  THEME: BackpackItemType.THEME,
  DECORATION: BackpackItemType.DECORATION,
};

/**
 * The cosmetics catalog: the definition of every frame/badge/entrance-effect and
 * the single seam through which the economy features award them. `grantToUser`
 * looks up the catalog entry and deposits a per-user instance into the backpack
 * (idempotent) or user cosmetics depending on style customisation needs, keeping
 * backpack coupling out of the EXP/VIP/treasure modules.
 */
@Injectable()
export class CosmeticsService implements ICosmeticsService {
  private readonly logger = new Logger(CosmeticsService.name);

  constructor(
    private readonly repo: CosmeticsRepository,
    @Inject(BACKPACK_SERVICE) private readonly backpack: IBackpackService,
    private readonly frameProcessor: FrameProcessorService,
    private readonly s3: S3Service,
    private readonly media: MediaUrlResolver,
    private readonly prisma: PrismaService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  // ---- ICosmeticsService ----

  getCosmetic(cosmeticId: string): Promise<Cosmetic | null> {
    return this.repo.getById(cosmeticId);
  }

  async listActive(type?: CosmeticType): Promise<Cosmetic[]> {
    const cosmetics = await this.repo.listActive(type);
    return Promise.all(
      cosmetics.map(async (raw) => {
        const c = await this.ensureFrameTransparent(raw);
        return {
          ...c,
          mediaUrl: await this.media.resolve(c.mediaUrl),
          thumbnailUrl: await this.media.resolve(c.thumbnailUrl),
        };
      }),
    );
  }

  async ensureCosmetic(input: {
    type: CosmeticType;
    name: string;
    rarity: import('@prisma/client').CosmeticRarity;
    mediaUrl?: string;
    transferable?: boolean;
  }): Promise<string> {
    const existing = await this.repo.findByTypeName(input.type, input.name);
    if (existing) return existing.id;
    const created = await this.create('00000000-0000-0000-0000-000000000000', {
      type: input.type,
      name: input.name,
      rarity: input.rarity,
      mediaUrl: input.mediaUrl,
      transferable: input.transferable,
      enabled: true,
    });
    return created.id;
  }

  async grantCosmeticToUser(input: {
    userId: string;
    cosmeticId: string;
    expiresAt?: Date | null;
  }): Promise<{ id: string; duplicate: boolean }> {
    const existing = await this.prisma.userCosmetic.findUnique({
      where: {
        userId_cosmeticId: {
          userId: input.userId,
          cosmeticId: input.cosmeticId,
        },
      },
    });
    if (existing) {
      if (input.expiresAt !== undefined) {
        let newExpiresAt: Date | null = existing.expiresAt;
        if (input.expiresAt === null || existing.expiresAt === null) {
          newExpiresAt = null;
        } else if (existing.expiresAt && input.expiresAt) {
          const now = new Date();
          const base = existing.expiresAt > now ? existing.expiresAt : now;
          const additionalMs = input.expiresAt.getTime() - now.getTime();
          newExpiresAt = new Date(base.getTime() + (additionalMs > 0 ? additionalMs : 0));
        } else if (input.expiresAt) {
          newExpiresAt = input.expiresAt;
        }
        await this.prisma.userCosmetic.update({
          where: { id: existing.id },
          data: { expiresAt: newExpiresAt },
        });
      }
      return { id: existing.id, duplicate: true };
    }

    const userCos = await this.prisma.userCosmetic.create({
      data: {
        userId: input.userId,
        cosmeticId: input.cosmeticId,
        expiresAt: input.expiresAt ?? null,
        equipped: false,
      },
    });
    return { id: userCos.id, duplicate: false };
  }

  async grantToUser(input: {
    userId: string;
    cosmeticId: string;
    source: import('@prisma/client').BackpackItemSource;
    grantKey: string;
    durationDays?: number;
    expiresAt?: Date | null;
    transferable?: boolean;
  }): Promise<CosmeticGrantResult | null> {
    let cosmetic = await this.repo.getById(input.cosmeticId);
    if (!cosmetic) {
      const byName = await this.prisma.cosmetic.findFirst({
        where: {
          OR: [
            { name: { equals: input.cosmeticId, mode: 'insensitive' } },
            { id: input.cosmeticId.length === 36 ? input.cosmeticId : undefined },
          ],
        },
      });
      if (byName) cosmetic = byName;
    }
    if (!cosmetic) {
      const lower = input.cosmeticId.toLowerCase();
      let inferredType: import('@prisma/client').CosmeticType = 'FRAME';
      if (lower.includes('theme') || lower.includes('wallpaper') || lower.includes('bg')) {
        inferredType = 'THEME';
      } else if (lower.includes('entrance') || lower.includes('ride') || lower.includes('car') || lower.includes('effect')) {
        inferredType = 'ENTRANCE_EFFECT';
      } else if (lower.includes('badge')) {
        inferredType = 'BADGE';
      }
      // No 'bubble' branch: `CosmeticType` has no BUBBLE member (schema only
      // defines FRAME/BADGE/ENTRANCE_EFFECT/THEME/DECORATION) — chat bubbles
      // are granted through a different reward field entirely (TaskReward's
      // bubbleId, not a catalog Cosmetic), so a bubble-named id falls through
      // to the FRAME default like any other unrecognized keyword would.

      const displayName = input.cosmeticId
        .replace(/^frame[-_]|^theme[-_]|^ride[-_]|^effect[-_]|^bubble[-_]|^badge[-_]/i, '')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());

      // `Cosmetic` has no `description`/`priceCoins`/`priceDiamonds` columns
      // (see prisma/schema/cosmetics.prisma) — those three fields here used
      // to be silently invalid, which the strict `tsc` build refused to
      // compile at all. The one piece worth keeping, a human-readable blurb,
      // goes into `metadata` (a Json column meant for exactly this); pricing
      // uses the real `price`/`isPremium` columns — an auto-created ad hoc
      // cosmetic is free/non-purchasable, matching the old `0`/`0` intent.
      cosmetic = await this.prisma.cosmetic.create({
        data: {
          name: displayName.trim().length > 0 ? displayName.trim() : input.cosmeticId,
          type: inferredType,
          rarity: 'RARE',
          enabled: true,
          isPremium: false,
          price: 0,
          transferable: false,
          metadata: {
            code: input.cosmeticId,
            description: `${displayName || input.cosmeticId} (${inferredType})`,
            durationDays: input.durationDays ?? 7,
          },
        },
      });
    }
    if (!cosmetic.enabled) return null;

    let computedExpiresAt: Date | null = input.expiresAt ?? null;
    const meta = (cosmetic.metadata as Record<string, any>) || {};
    let durDays = input.durationDays ?? meta.durationDays ?? meta.ttlDays;

    if (durDays === undefined && meta.ttlValue !== undefined) {
      const val = Number(meta.ttlValue);
      const unit = String(meta.ttlUnit || 'days').toLowerCase();
      if (!isNaN(val) && val > 0) {
        if (unit.startsWith('hour')) durDays = val / 24;
        else if (unit.startsWith('month')) durDays = val * 30;
        else if (unit.startsWith('min')) durDays = val / 1440;
        else durDays = val;
      }
    }

    if (!computedExpiresAt && durDays && Number(durDays) > 0) {
      computedExpiresAt = new Date(Date.now() + Number(durDays) * 24 * 60 * 60 * 1000);
    }

    if (
      cosmetic.type === 'FRAME' ||
      cosmetic.type === 'THEME' ||
      cosmetic.type === 'ENTRANCE_EFFECT'
    ) {
      await this.grantCosmeticToUser({
        userId: input.userId,
        cosmeticId: cosmetic.id,
        expiresAt: computedExpiresAt,
      });
    }

    const effectiveTransferable =
      input.transferable !== undefined
        ? input.transferable
        : input.source === 'GIFT'
          ? false
          : cosmetic.transferable;

    const res = await this.backpack.grant({
      userId: input.userId,
      type: TO_BACKPACK_TYPE[cosmetic.type] || 'OTHER',
      name: cosmetic.name,
      source: input.source,
      refId: cosmetic.id,
      transferable: effectiveTransferable,
      grantKey: input.grantKey,
      expiresAt: computedExpiresAt ?? undefined,
      metadata: {
        cosmeticId: cosmetic.id,
        rarity: cosmetic.rarity,
        mediaUrl: cosmetic.mediaUrl,
        thumbnailUrl: cosmetic.thumbnailUrl,
      },
    });
    return { cosmeticId: cosmetic.id, backpackItemId: res.itemId, duplicate: res.duplicate };
  }

  async equip(userId: string, cosmeticId: string): Promise<void> {
    const cosmetic = await this.repo.getById(cosmeticId);
    if (!cosmetic) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'Cosmetic not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (
      cosmetic.type === 'FRAME' ||
      cosmetic.type === 'THEME' ||
      cosmetic.type === 'ENTRANCE_EFFECT'
    ) {
      await this.equipCosmetic(userId, cosmeticId);
      return;
    }
    const item = await this.prisma.backpackItem.findFirst({
      where: { userId, refId: cosmeticId },
      orderBy: { acquiredAt: 'desc' },
    });
    if (!item) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'You do not own this cosmetic.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.backpack.equip(userId, item.id);
  }

  async unequip(userId: string, cosmeticId: string): Promise<void> {
    const cosmetic = await this.repo.getById(cosmeticId);
    if (!cosmetic) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'Cosmetic not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (
      cosmetic.type === 'FRAME' ||
      cosmetic.type === 'THEME' ||
      cosmetic.type === 'ENTRANCE_EFFECT'
    ) {
      await this.unequipCosmetic(userId, cosmeticId);
      return;
    }
    const item = await this.prisma.backpackItem.findFirst({
      where: { userId, refId: cosmeticId },
      orderBy: { acquiredAt: 'desc' },
    });
    if (!item) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'You do not own this cosmetic.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.backpack.unequip(userId, item.id);
  }

  async isEquipped(userId: string, cosmeticId: string): Promise<boolean> {
    const cosmetic = await this.repo.getById(cosmeticId);
    if (!cosmetic) return false;
    if (
      cosmetic.type === 'FRAME' ||
      cosmetic.type === 'THEME' ||
      cosmetic.type === 'ENTRANCE_EFFECT'
    ) {
      const userCos = await this.prisma.userCosmetic.findUnique({
        where: { userId_cosmeticId: { userId, cosmeticId } },
      });
      return userCos?.equipped ?? false;
    }
    const item = await this.prisma.backpackItem.findFirst({
      where: { userId, refId: cosmeticId },
      orderBy: { acquiredAt: 'desc' },
    });
    return item?.equipped ?? false;
  }

  async setMedia(cosmeticId: string, mediaUrl: string): Promise<void> {
    await this.prisma.cosmetic.update({
      where: { id: cosmeticId },
      data: { mediaUrl },
    });
  }

  // ---- Public catalog ----

  listCatalog(type?: CosmeticType): Promise<Cosmetic[]> {
    return this.listActive(type);
  }

  // ---- Admin CRUD ----

  async list(q: ListCosmeticsDto): Promise<Paginated<Cosmetic>> {
    const [rows, total] = await this.repo.list(q.skip, q.limit, {
      type: q.type,
      enabled: q.enabled,
    });
    const resolvedRows = await Promise.all(
      rows.map(async (raw) => {
        const c = await this.ensureFrameTransparent(raw);
        return {
          ...c,
          mediaUrl: await this.media.resolve(c.mediaUrl),
          thumbnailUrl: await this.media.resolve(c.thumbnailUrl),
        };
      }),
    );
    return buildPaginated(resolvedRows, total, q.page, q.limit);
  }

  async create(actorId: string, dto: CosmeticDto): Promise<Cosmetic> {
    let finalMediaUrl = dto.mediaUrl ?? null;
    let finalThumbnailUrl = dto.thumbnailUrl ?? null;

    if (dto.type === 'FRAME' && finalMediaUrl) {
      const processed = await this.processFrameMedia(finalMediaUrl, finalThumbnailUrl);
      finalMediaUrl = processed.mediaUrl ?? finalMediaUrl;
      finalThumbnailUrl = processed.thumbnailUrl ?? finalThumbnailUrl;
    }

    const finalMetadata = {
      ...((dto.metadata as Record<string, any>) || {}),
      ...(dto.durationDays !== undefined
        ? { durationDays: dto.durationDays, ttlDays: dto.durationDays }
        : {}),
    };

    const created = await this.repo.create(
      {
        type: dto.type,
        name: dto.name,
        mediaUrl: finalMediaUrl,
        thumbnailUrl: finalThumbnailUrl,
        rarity: dto.rarity,
        price: dto.price ?? 0,
        isPremium: dto.isPremium ?? false,
        transferable: dto.transferable ?? false,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
        ...(finalMetadata !== undefined
          ? { metadata: finalMetadata as Prisma.InputJsonValue }
          : {}),
      },
      actorId,
    );
    return {
      ...created,
      mediaUrl: await this.media.resolve(created.mediaUrl),
      thumbnailUrl: await this.media.resolve(created.thumbnailUrl),
    };
  }

  async update(actorId: string, id: string, dto: UpdateCosmeticDto): Promise<Cosmetic> {
    const existing = await this.repo.getById(id);
    if (!existing) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'Cosmetic not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    let finalMediaUrl = dto.mediaUrl;
    let finalThumbnailUrl = dto.thumbnailUrl;

    const isFrame = (dto.type ?? existing.type) === 'FRAME';
    if (isFrame && finalMediaUrl) {
      const processed = await this.processFrameMedia(finalMediaUrl, finalThumbnailUrl);
      finalMediaUrl = processed.mediaUrl ?? finalMediaUrl;
      finalThumbnailUrl = processed.thumbnailUrl ?? finalThumbnailUrl;
    }

    const updatedMetadata =
      dto.metadata !== undefined || dto.durationDays !== undefined
        ? {
            ...((existing.metadata as Record<string, any>) || {}),
            ...((dto.metadata as Record<string, any>) || {}),
            ...(dto.durationDays !== undefined
              ? { durationDays: dto.durationDays, ttlDays: dto.durationDays }
              : {}),
          }
        : undefined;

    const data: Prisma.CosmeticUpdateInput = {
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(finalMediaUrl !== undefined ? { mediaUrl: finalMediaUrl } : {}),
      ...(finalThumbnailUrl !== undefined ? { thumbnailUrl: finalThumbnailUrl } : {}),
      ...(dto.rarity !== undefined ? { rarity: dto.rarity } : {}),
      ...(dto.price !== undefined ? { price: dto.price } : {}),
      ...(dto.isPremium !== undefined ? { isPremium: dto.isPremium } : {}),
      ...(dto.transferable !== undefined ? { transferable: dto.transferable } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(updatedMetadata !== undefined
        ? { metadata: updatedMetadata as Prisma.InputJsonValue }
        : {}),
    };
    const updated = await this.repo.update(id, data, actorId);
    return {
      ...updated,
      mediaUrl: await this.media.resolve(updated.mediaUrl),
      thumbnailUrl: await this.media.resolve(updated.thumbnailUrl),
    };
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    if (!(await this.repo.getById(id))) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'Cosmetic not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.repo.delete(id);
    return { deleted: true };
  }

  private extractS3Key(urlOrKey: string): string {
    if (!urlOrKey) return '';
    let clean = urlOrKey.trim();
    const queryIndex = clean.indexOf('?');
    if (queryIndex !== -1) {
      clean = clean.substring(0, queryIndex);
    }
    clean = clean.replace(/^https?:\/\/[^/]+(?:\/api)?\/storage\/download\//i, '');
    clean = clean.replace(/^(?:\/api)?\/storage\/download\//i, '');
    clean = clean.replace(/^https?:\/\/[^/]+\//i, '');
    const bucket = process.env.S3_BUCKET || 'soulzaa-media';
    if (clean.startsWith(`${bucket}/`)) {
      clean = clean.substring(bucket.length + 1);
    } else if (clean.startsWith(`/${bucket}/`)) {
      clean = clean.substring(bucket.length + 2);
    }
    return clean.replace(/^\/+/, '');
  }

  private async processFrameMedia(
    mediaUrl: string,
    thumbnailUrl?: string | null,
  ): Promise<{ mediaUrl: string; thumbnailUrl?: string | null }> {
    try {
      if (!mediaUrl) return { mediaUrl, thumbnailUrl };

      const cleanKey = this.extractS3Key(mediaUrl);
      let buffer: Buffer | null = null;
      let contentType = 'image/png';

      const head: { exists: boolean; size: number; contentType?: string } =
        await this.s3
          .headObject(cleanKey)
          .catch(() => ({ exists: false, size: 0, contentType: undefined }));
      if (head.exists) {
        buffer = await this.s3.getObjectBuffer(cleanKey);
        contentType = head.contentType ?? 'image/png';
      } else if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
        try {
          const res = await fetch(mediaUrl);
          if (res.ok) {
            const arr = await res.arrayBuffer();
            buffer = Buffer.from(arr);
            contentType = res.headers.get('content-type') || 'image/png';
          }
        } catch (fetchErr: any) {
          this.logger.warn(`Could not fetch frame media via HTTP fallback: ${fetchErr?.message}`);
        }
      }

      if (!buffer || buffer.length === 0) {
        this.logger.warn(`Frame media buffer empty or not found for key "${cleanKey}" / "${mediaUrl}"`);
        return { mediaUrl, thumbnailUrl };
      }

      const result = await this.frameProcessor.processFrame(buffer, contentType);
      if (!result.isProcessed) {
        return { mediaUrl, thumbnailUrl };
      }

      const ext = result.mimeType.includes('svg') ? 'svg' : 'png';
      const targetBaseKey =
        cleanKey && !cleanKey.includes('://')
          ? cleanKey
          : `cosmetic-assets/frame_${Date.now()}`;
      const processedKey = `${targetBaseKey.replace(/\.[^/.]+$/, '')}_transparent.${ext}`;

      await this.s3.putObject(processedKey, result.buffer, result.mimeType);
      this.logger.log(`Successfully processed and saved transparent frame to ${processedKey}`);

      return {
        mediaUrl: processedKey,
        thumbnailUrl:
          thumbnailUrl && thumbnailUrl !== mediaUrl
            ? thumbnailUrl
            : processedKey,
      };
    } catch (err: any) {
      this.logger.error(`Failed to process frame background: ${err?.message ?? err}`);
      return { mediaUrl, thumbnailUrl };
    }
  }

  private async ensureFrameTransparent(c: Cosmetic): Promise<Cosmetic> {
    if (
      c.type === 'FRAME' &&
      c.mediaUrl &&
      !c.mediaUrl.includes('_transparent.') &&
      !c.mediaUrl.startsWith('default_pink') &&
      !c.mediaUrl.startsWith('neon_') &&
      !c.mediaUrl.startsWith('royal_')
    ) {
      try {
        const processed = await this.processFrameMedia(c.mediaUrl, c.thumbnailUrl);
        if (processed.mediaUrl && processed.mediaUrl !== c.mediaUrl) {
          const updated = await this.prisma.cosmetic.update({
            where: { id: c.id },
            data: {
              mediaUrl: processed.mediaUrl,
              thumbnailUrl: processed.thumbnailUrl,
            },
          });
          return updated;
        }
      } catch (err: any) {
        this.logger.warn(`Could not backfill transparent frame for ${c.id}: ${err?.message}`);
      }
    }
    return c;
  }

  async equipCosmetic(userId: string, cosmeticId: string): Promise<void> {
    let userCos = await this.prisma.userCosmetic.findFirst({
      where: {
        userId,
        OR: [
          { cosmeticId },
          { id: cosmeticId.length === 36 ? cosmeticId : undefined },
          { cosmetic: { name: { equals: cosmeticId, mode: 'insensitive' } } },
        ],
      },
      include: {
        cosmetic: true,
      },
    });

    if (!userCos) {
      // Check if the user owns it via BackpackItem
      const backpackItem = await this.prisma.backpackItem.findFirst({
        where: {
          userId,
          OR: [
            { id: cosmeticId },
            { refId: cosmeticId },
            { name: { equals: cosmeticId, mode: 'insensitive' } },
          ],
        },
      });

      if (backpackItem) {
        let targetCosId: string | null | undefined = backpackItem.refId;
        if (!targetCosId || targetCosId.length !== 36) {
          const cos = await this.prisma.cosmetic.findFirst({
            where: {
              OR: [
                { name: { equals: backpackItem.name, mode: 'insensitive' } },
                { id: targetCosId && targetCosId.length === 36 ? targetCosId : undefined },
              ],
            },
          });
          targetCosId = cos?.id;
        }

        if (targetCosId) {
          await this.grantCosmeticToUser({
            userId,
            cosmeticId: targetCosId,
            expiresAt: backpackItem.expiresAt,
          });
          userCos = await this.prisma.userCosmetic.findUnique({
            where: { userId_cosmeticId: { userId, cosmeticId: targetCosId } },
            include: { cosmetic: true },
          });
        }
      }
    }

    if (!userCos) {
      const cosmetic = await this.repo.getById(cosmeticId);
      if (cosmetic && (cosmetic.price <= 0 || !cosmetic.isPremium)) {
        await this.grantCosmeticToUser({ userId, cosmeticId });
        userCos = await this.prisma.userCosmetic.findUnique({
          where: {
            userId_cosmeticId: {
              userId,
              cosmeticId,
            },
          },
          include: {
            cosmetic: true,
          },
        });
      }
    }

    if (!userCos) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'You do not own this cosmetic.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (userCos.expiresAt && userCos.expiresAt.getTime() <= Date.now()) {
      throw new BusinessException(
        ERROR_CODES.BACKPACK_ITEM_EXPIRED,
        'This cosmetic has expired.',
        HttpStatus.CONFLICT,
      );
    }

    const actualCosId = userCos.cosmeticId;

    // Unequip all other cosmetics of the same type for this user
    const sameTypeCosmetics = await this.prisma.userCosmetic.findMany({
      where: {
        userId,
        cosmetic: {
          type: userCos.cosmetic.type,
        },
      },
    });

    await this.prisma.$transaction([
      // Unequip all of this type
      this.prisma.userCosmetic.updateMany({
        where: {
          id: { in: sameTypeCosmetics.map((c) => c.id) },
        },
        data: { equipped: false },
      }),
      // Equip this one
      this.prisma.userCosmetic.update({
        where: { id: userCos.id },
        data: { equipped: true },
      }),
    ]);

    // Also sync BackpackItem table for consistent state across views
    await this.prisma.backpackItem.updateMany({
      where: {
        userId,
        type: TO_BACKPACK_TYPE[userCos.cosmetic.type] || 'OTHER',
      },
      data: { equipped: false },
    });
    await this.prisma.backpackItem.updateMany({
      where: {
        userId,
        OR: [
          { refId: actualCosId },
          { name: userCos.cosmetic.name },
        ],
      },
      data: { equipped: true },
    });

    await this.profiles.invalidateProfile(userId);

    // Publish equipped event for realtime synchronization
    await this.bus.publish(
      new BackpackItemEquippedEvent({
        userId,
        itemId: actualCosId,
        type: userCos.cosmetic.type as any,
      }),
    );
  }

  async unequipCosmetic(userId: string, cosmeticId: string): Promise<void> {
    let userCos = await this.prisma.userCosmetic.findFirst({
      where: {
        userId,
        OR: [
          { cosmeticId },
          { id: cosmeticId.length === 36 ? cosmeticId : undefined },
          { cosmetic: { name: { equals: cosmeticId, mode: 'insensitive' } } },
        ],
      },
      include: {
        cosmetic: true,
      },
    });

    if (!userCos) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'You do not own this cosmetic.',
        HttpStatus.NOT_FOUND,
      );
    }

    const actualCosId = userCos.cosmeticId;

    await this.prisma.userCosmetic.update({
      where: { id: userCos.id },
      data: { equipped: false },
    });

    // Also sync BackpackItem table
    await this.prisma.backpackItem.updateMany({
      where: {
        userId,
        OR: [
          { refId: actualCosId },
          { name: userCos.cosmetic.name },
        ],
      },
      data: { equipped: false },
    });

    // Publish unequipped event
    await this.bus.publish(
      new BackpackItemUnequippedEvent({
        userId,
        itemId: cosmeticId,
        type: userCos.cosmetic.type as any,
      }),
    );

    // If it's a FRAME, equip the default pink frame automatically
    if (userCos.cosmetic.type === 'FRAME') {
      const defaultCosmeticId = '00000000-0000-0000-0000-000000000001';
      if (cosmeticId !== defaultCosmeticId) {
        await this.prisma.userCosmetic.upsert({
          where: {
            userId_cosmeticId: {
              userId,
              cosmeticId: defaultCosmeticId,
            },
          },
          update: { equipped: true },
          create: {
            userId,
            cosmeticId: defaultCosmeticId,
            equipped: true,
          },
        });

        // Publish equipped event for default pink frame
        await this.bus.publish(
          new BackpackItemEquippedEvent({
            userId,
            itemId: defaultCosmeticId,
            type: 'FRAME' as any,
          }),
        );
      }
    }

    await this.profiles.invalidateProfile(userId);
  }

  async listOwnedCosmetics(userId: string, type?: CosmeticType): Promise<any[]> {
    const now = new Date();
    const rows = await this.prisma.userCosmetic.findMany({
      where: {
        userId,
        cosmetic: type ? { type } : undefined,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: {
        cosmetic: true,
      },
      orderBy: { acquiredAt: 'desc' },
    });

    return Promise.all(
      rows.map(async (uc) => ({
        id: uc.id,
        cosmeticId: uc.cosmeticId,
        refId: uc.cosmeticId,
        name: uc.cosmetic.name,
        type: uc.cosmetic.type,
        source: 'PURCHASE',
        quantity: 1,
        transferable: uc.cosmetic.transferable ?? false,
        mediaUrl: await this.media.resolve(uc.cosmetic.mediaUrl),
        thumbnailUrl: await this.media.resolve(uc.cosmetic.thumbnailUrl),
        equipped: uc.equipped,
        expiresAt: uc.expiresAt ? uc.expiresAt.toISOString() : null,
        acquiredAt: uc.acquiredAt.toISOString(),
        metadata: {
          cosmeticId: uc.cosmeticId,
          rarity: uc.cosmetic.rarity,
          mediaUrl: uc.cosmetic.mediaUrl,
          thumbnailUrl: uc.cosmetic.thumbnailUrl,
        },
      })),
    );
  }
}
