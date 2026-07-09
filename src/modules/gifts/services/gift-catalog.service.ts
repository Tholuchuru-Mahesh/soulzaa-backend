import { HttpStatus, Injectable } from '@nestjs/common';
import { Gift, Prisma } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type {
  CreateGiftDto,
  ListGiftsAdminDto,
  ListGiftsDto,
  UpdateGiftDto,
} from '../dto/gift.dto';
import type { IGiftsService } from '../interfaces/gifts.service.interface';
import { GiftRepository } from '../repositories/gift.repository';

/**
 * The gift catalog: the public read seam (IGiftsService) other modules resolve,
 * plus platform-admin CRUD. The send pipeline reads gifts through this service.
 */
@Injectable()
export class GiftCatalogService implements IGiftsService {
  constructor(private readonly repo: GiftRepository) {}

  // ---- IGiftsService (cross-module read seam) ----

  getGift(giftId: string): Promise<Gift | null> {
    return this.repo.getGift(giftId);
  }

  async isGiftEnabled(giftId: string): Promise<boolean> {
    const gift = await this.repo.getGift(giftId);
    return !!gift?.enabled;
  }

  listActiveGifts(): Promise<Gift[]> {
    return this.repo.listActiveGifts();
  }

  // ---- Public catalog ----

  listCatalog(filter: ListGiftsDto): Promise<Gift[]> {
    return this.repo.listActiveGifts({ category: filter.category, type: filter.type });
  }

  // ---- Admin CRUD ----

  async list(q: ListGiftsAdminDto): Promise<Paginated<Gift>> {
    const [rows, total] = await this.repo.listGifts(q.skip, q.limit, {
      category: q.category,
      enabled: q.enabled,
    });
    return buildPaginated(rows, total, q.page, q.limit);
  }

  create(actorId: string, dto: CreateGiftDto): Promise<Gift> {
    return this.repo.createGift(
      {
        name: dto.name,
        category: dto.category,
        type: dto.type,
        coinValue: dto.coinValue,
        thumbnailUrl: dto.thumbnailUrl ?? null,
        animationUrl: dto.animationUrl ?? null,
        soundUrl: dto.soundUrl ?? null,
        minVipLevel: dto.minVipLevel ?? 0,
        comboEnabled: dto.comboEnabled ?? false,
        comboWindowSeconds: dto.comboWindowSeconds ?? 10,
        luckyMultipliers: dto.luckyMultipliers ?? [],
        luckyWinChanceBp: dto.luckyWinChanceBp ?? 0,
        festivalTag: dto.festivalTag ?? null,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
      actorId,
    );
  }

  async update(actorId: string, id: string, dto: UpdateGiftDto): Promise<Gift> {
    if (!(await this.repo.getGift(id))) {
      throw new BusinessException(
        ERROR_CODES.GIFT_NOT_FOUND,
        'Gift not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const data: Prisma.GiftUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.coinValue !== undefined ? { coinValue: dto.coinValue } : {}),
      ...(dto.thumbnailUrl !== undefined ? { thumbnailUrl: dto.thumbnailUrl } : {}),
      ...(dto.animationUrl !== undefined ? { animationUrl: dto.animationUrl } : {}),
      ...(dto.soundUrl !== undefined ? { soundUrl: dto.soundUrl } : {}),
      ...(dto.minVipLevel !== undefined ? { minVipLevel: dto.minVipLevel } : {}),
      ...(dto.comboEnabled !== undefined ? { comboEnabled: dto.comboEnabled } : {}),
      ...(dto.comboWindowSeconds !== undefined
        ? { comboWindowSeconds: dto.comboWindowSeconds }
        : {}),
      ...(dto.luckyMultipliers !== undefined ? { luckyMultipliers: dto.luckyMultipliers } : {}),
      ...(dto.luckyWinChanceBp !== undefined ? { luckyWinChanceBp: dto.luckyWinChanceBp } : {}),
      ...(dto.festivalTag !== undefined ? { festivalTag: dto.festivalTag } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };
    return this.repo.updateGift(id, data, actorId);
  }
}
