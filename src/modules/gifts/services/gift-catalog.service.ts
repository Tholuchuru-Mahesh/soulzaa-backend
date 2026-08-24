import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import {
  CreateGiftCategoryDto,
  CreateGiftDto,
  GiftQueryDto,
  UpdateGiftDto,
} from '../dto/gift-catalog.dto';
import { GiftAuditService } from './gift-audit.service';

@Injectable()
export class GiftCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: GiftAuditService,
    private readonly media: MediaUrlResolver,
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

    const gift = await this.prisma.gift.create({
      data: {
        code: dto.code,
        name: dto.name,
        displayName: dto.displayName ?? dto.name,
        description: dto.description,
        category: dto.category,
        type: dto.type,
        coinValue: dto.coinValue,
        thumbnailUrl: dto.thumbnailUrl,
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

    const updated = await this.prisma.gift.update({
      where: { id: gift.id },
      data: {
        name: dto.name,
        category: dto.category,
        type: dto.type,
        description: dto.description,
        displayName: dto.displayName,
        coinValue: dto.coinValue,
        thumbnailUrl: dto.thumbnailUrl,
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
}
