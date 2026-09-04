import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { FrameProcessorService } from 'src/infra/storage/frame-processor.service';
import { S3Service } from 'src/infra/storage/s3.service';
import {
  CreateGiftCategoryDto,
  CreateGiftDto,
  GiftQueryDto,
  UpdateGiftDto,
} from '../dto/gift-catalog.dto';
import { GiftAuditService } from './gift-audit.service';

@Injectable()
export class GiftCatalogService {
  private readonly logger = new Logger(GiftCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: GiftAuditService,
    private readonly media: MediaUrlResolver,
    private readonly frameProcessor: FrameProcessorService,
    private readonly s3: S3Service,
  ) {}

  /**
   * List all active gift categories
   */
  async listCategories() {
    return this.prisma.giftCategoryEntity.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * Create a new gift category
   */
  async createCategory(dto: CreateGiftCategoryDto) {
    const existing = await this.prisma.giftCategoryEntity.findUnique({
      where: { code: dto.code },
    });
    if (existing) {
      throw new BadRequestException(`Gift category '${dto.code}' already exists`);
    }

    return this.prisma.giftCategoryEntity.create({
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        iconUrl: dto.iconUrl,
        sortOrder: dto.sortOrder ?? 0,
        isActive: true,
      },
    });
  }

  async listGifts(dto: GiftQueryDto) {
    const { category, type, enabled } = dto;
    const where: any = {};

    // Only filter by enabled state when explicitly requested.
    // Omitting the param returns ALL gifts (active + disabled) — the admin
    // catalog view must show everything so operators can manage disabled gifts.
    if (enabled !== undefined) {
      where.enabled = enabled;
    }

    if (category) {
      where.category = category.toUpperCase();
    }

    if (type) {
      where.type = type.toUpperCase();
    }

    const gifts = await this.prisma.gift.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { priority: 'desc' }, { coinValue: 'asc' }],
    });

    return Promise.all(
      gifts.map(async (gift) => ({
        ...gift,
        thumbnailUrl: await this.media.resolve(gift.thumbnailUrl),
        animationUrl: await this.media.resolve(gift.animationUrl),
      })),
    );
  }

  /**
   * Get single gift by ID or code
   */
  async getGiftById(id: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const gift = await this.prisma.gift.findFirst({
      where: isUuid ? { OR: [{ id }, { code: id }] } : { code: id },
    });

    if (!gift) {
      throw new NotFoundException(`Gift '${id}' not found`);
    }

    return {
      ...gift,
      thumbnailUrl: await this.media.resolve(gift.thumbnailUrl),
      animationUrl: await this.media.resolve(gift.animationUrl),
    };
  }

  /**
   * Alias for getGiftById (backward compatibility)
   */
  async getGift(id: string) {
    return this.getGiftById(id);
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
  ): Promise<string> {
    try {
      if (!mediaUrl) return mediaUrl;

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
          this.logger.warn(`Could not fetch gift frame media via HTTP fallback: ${fetchErr?.message}`);
        }
      }

      if (!buffer || buffer.length === 0) {
        return mediaUrl;
      }

      const result = await this.frameProcessor.processFrame(buffer, contentType);
      if (!result.isProcessed) {
        return mediaUrl;
      }

      const ext = result.mimeType.includes('svg') ? 'svg' : 'png';
      const targetBaseKey =
        cleanKey && !cleanKey.includes('://')
          ? cleanKey
          : `gift-assets/frame_${Date.now()}`;
      const processedKey = `${targetBaseKey.replace(/\.[^/.]+$/, '')}_transparent.${ext}`;

      await this.s3.putObject(processedKey, result.buffer, result.mimeType);
      this.logger.log(`Successfully processed transparent gift frame to ${processedKey}`);

      return processedKey;
    } catch (err: any) {
      this.logger.error(`Failed to process gift frame background: ${err?.message ?? err}`);
      return mediaUrl;
    }
  }

  /**
   * Create a new catalog gift
   */
  async createGift(dto: CreateGiftDto, actorId?: string) {
    const existing = await this.prisma.gift.findUnique({
      where: { code: dto.code },
    });
    if (existing) {
      throw new BadRequestException(`Gift code '${dto.code}' already exists`);
    }

    let finalThumbnail = dto.thumbnailUrl;
    if (dto.type === 'PROFILE_FRAME' && finalThumbnail) {
      finalThumbnail = await this.processFrameMedia(finalThumbnail);
    }

    const gift = await this.prisma.gift.create({
      data: {
        code: dto.code,
        name: dto.name,
        displayName: dto.displayName ?? dto.name,
        description: dto.description,
        category: dto.category,
        type: dto.type,
        coinValue: dto.coinValue,
        thumbnailUrl: finalThumbnail,
        animationUrl: dto.animationUrl,
        lottieUrl: dto.lottieUrl,
        svgaUrl: dto.svgaUrl,
        mp4Url: dto.mp4Url,
        soundUrl: dto.soundUrl,
        priority: dto.priority ?? 0,
        tags: dto.tags ?? [],
        minVipLevel: dto.minVipLevel ?? 0,
        comboEnabled: dto.comboEnabled ?? false,
        enabled: dto.enabled ?? true,
        ttlValue: dto.ttlValue,
        ttlUnit: dto.ttlUnit,
        createdBy: actorId,
      },
    });

    await this.auditService.logAudit(
      gift.id,
      'GIFT_CREATED',
      { code: gift.code, coinValue: gift.coinValue },
      actorId,
    );

    return gift;
  }

  /**
   * Update an existing gift
   */
  async updateGift(id: string, dto: UpdateGiftDto, actorId?: string) {
    const gift = await this.getGiftById(id);

    let finalThumbnail = dto.thumbnailUrl;
    const isFrame = dto.type === 'PROFILE_FRAME' || gift.type === 'PROFILE_FRAME';

    if (isFrame && finalThumbnail) {
      finalThumbnail = await this.processFrameMedia(finalThumbnail);
    }

    const updated = await this.prisma.gift.update({
      where: { id: gift.id },
      data: {
        name: dto.name,
        category: dto.category,
        type: dto.type,
        description: dto.description,
        displayName: dto.displayName,
        coinValue: dto.coinValue,
        thumbnailUrl: finalThumbnail !== undefined ? finalThumbnail : gift.thumbnailUrl,
        animationUrl: dto.animationUrl,
        lottieUrl: dto.lottieUrl,
        svgaUrl: dto.svgaUrl,
        mp4Url: dto.mp4Url,
        enabled: dto.enabled,
        ttlValue: dto.ttlValue,
        ttlUnit: dto.ttlUnit,
        updatedBy: actorId,
      },
    });

    await this.auditService.logAudit(
      gift.id,
      'GIFT_UPDATED',
      { enabled: updated.enabled },
      actorId,
    );

    return updated;
  }

  /**
   * Delete a catalog gift
   */
  async deleteGift(id: string, actorId?: string) {
    const gift = await this.getGiftById(id);

    await this.prisma.gift.delete({
      where: { id: gift.id },
    });

    await this.auditService.logAudit(
      gift.id,
      'GIFT_DELETED',
      { code: gift.code, name: gift.name },
      actorId,
    );

    return { deleted: true, id: gift.id };
  }
}
