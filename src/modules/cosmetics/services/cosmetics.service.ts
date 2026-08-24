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
      cosmetics.map(async (c) => ({
        ...c,
        mediaUrl: await this.media.resolve(c.mediaUrl),
        thumbnailUrl: await this.media.resolve(c.thumbnailUrl),
      })),
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
        let newExpiresAt = input.expiresAt;
        if (existing.expiresAt && input.expiresAt) {
          const now = new Date();
          const base = existing.expiresAt > now ? existing.expiresAt : now;
          const additionalMs = input.expiresAt.getTime() - now.getTime();
          newExpiresAt = new Date(base.getTime() + (additionalMs > 0 ? additionalMs : 0));
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
    if (!cosmetic || !cosmetic.enabled) return null;

    let computedExpiresAt: Date | null = input.expiresAt ?? null;
    const durDays =
      input.durationDays ??
      (cosmetic.metadata as any)?.durationDays ??
      (cosmetic.metadata as any)?.ttlDays ??
      undefined;

    if (!computedExpiresAt && durDays && durDays > 0) {
      computedExpiresAt = new Date(Date.now() + durDays * 24 * 60 * 60 * 1000);
    }

    if (
      cosmetic.type === 'FRAME' ||
      cosmetic.type === 'THEME' ||
      cosmetic.type === 'ENTRANCE_EFFECT'
    ) {
      const res = await this.grantCosmeticToUser({
        userId: input.userId,
        cosmeticId: cosmetic.id,
        expiresAt: computedExpiresAt,
      });
      return { cosmeticId: cosmetic.id, backpackItemId: res.id, duplicate: res.duplicate };
    }

    const res = await this.backpack.grant({
      userId: input.userId,
      type: TO_BACKPACK_TYPE[cosmetic.type],
      name: cosmetic.name,
      source: input.source,
      refId: cosmetic.id,
      transferable: cosmetic.transferable,
      grantKey: input.grantKey,
      expiresAt: computedExpiresAt ?? undefined,
      metadata: { cosmeticId: cosmetic.id, rarity: cosmetic.rarity, mediaUrl: cosmetic.mediaUrl },
    });
    return { cosmeticId: cosmetic.id, backpackItemId: res.itemId, duplicate: res.duplicate };
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
      rows.map(async (c) => ({
        ...c,
        mediaUrl: await this.media.resolve(c.mediaUrl),
        thumbnailUrl: await this.media.resolve(c.thumbnailUrl),
      })),
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

    const finalMetadata =
      dto.metadata !== undefined
        ? dto.metadata
        : dto.durationDays !== undefined
          ? { durationDays: dto.durationDays }
          : undefined;

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
        ...(finalMetadata !== undefined ? { metadata: finalMetadata as Prisma.InputJsonValue } : {}),
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
      dto.metadata !== undefined
        ? dto.metadata
        : dto.durationDays !== undefined
          ? { ...(existing.metadata as Record<string, any> || {}), durationDays: dto.durationDays }
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
      ...(updatedMetadata !== undefined ? { metadata: updatedMetadata as Prisma.InputJsonValue } : {}),
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

  private async processFrameMedia(
    mediaUrl: string,
    thumbnailUrl?: string | null,
  ): Promise<{ mediaUrl: string; thumbnailUrl?: string | null }> {
    try {
      const key = mediaUrl
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/^\/api\/storage\/download\//, '');
      const head = await this.s3.headObject(key);
      if (!head.exists) return { mediaUrl, thumbnailUrl };

      const buffer = await this.s3.getObjectBuffer(key);
      if (!buffer || buffer.length === 0) return { mediaUrl, thumbnailUrl };

      const result = await this.frameProcessor.processFrame(
        buffer,
        head.contentType ?? 'image/png',
      );
      if (!result.isProcessed) return { mediaUrl, thumbnailUrl };

      const ext = result.mimeType.includes('svg') ? 'svg' : 'png';
      const processedKey = `${key.replace(/\.[^/.]+$/, '')}_transparent.${ext}`;

      await this.s3.putObject(processedKey, result.buffer, result.mimeType);

      return {
        mediaUrl: processedKey,
        thumbnailUrl: thumbnailUrl ?? processedKey,
      };
    } catch (err: any) {
      this.logger.error(`Failed to process frame background: ${err?.message ?? err}`);
      return { mediaUrl, thumbnailUrl };
    }
  }

  async equipCosmetic(userId: string, cosmeticId: string): Promise<void> {
    let userCos = await this.prisma.userCosmetic.findUnique({
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

    await this.profiles.invalidateProfile(userId);

    // Publish equipped event for realtime synchronization
    await this.bus.publish(
      new BackpackItemEquippedEvent({
        userId,
        itemId: cosmeticId,
        type: userCos.cosmetic.type as any,
      }),
    );
  }

  async unequipCosmetic(userId: string, cosmeticId: string): Promise<void> {
    const userCos = await this.prisma.userCosmetic.findUnique({
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

    if (!userCos) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'You do not own this cosmetic.',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.userCosmetic.update({
      where: { id: userCos.id },
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
        mediaUrl: await this.media.resolve(uc.cosmetic.mediaUrl),
        thumbnailUrl: await this.media.resolve(uc.cosmetic.thumbnailUrl),
        equipped: uc.equipped,
        expiresAt: uc.expiresAt,
        acquiredAt: uc.acquiredAt.toISOString(),
      })),
    );
  }
}
