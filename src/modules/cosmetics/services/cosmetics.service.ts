import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BackpackItemType, Cosmetic, CosmeticType, Prisma } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
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
 * (idempotent), keeping backpack coupling out of the EXP/VIP/treasure modules.
 */
@Injectable()
export class CosmeticsService implements ICosmeticsService {
  constructor(
    private readonly repo: CosmeticsRepository,
    @Inject(BACKPACK_SERVICE) private readonly backpack: IBackpackService,
  ) {}

  // ---- ICosmeticsService ----

  getCosmetic(cosmeticId: string): Promise<Cosmetic | null> {
    return this.repo.getById(cosmeticId);
  }

  listActive(type?: CosmeticType): Promise<Cosmetic[]> {
    return this.repo.listActive(type);
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
    const created = await this.repo.create(
      {
        type: input.type,
        name: input.name,
        rarity: input.rarity,
        mediaUrl: input.mediaUrl ?? null,
        transferable: input.transferable ?? false,
        enabled: true,
      },
      // System-seeded cosmetics have no human author.
      '00000000-0000-0000-0000-000000000000',
    );
    return created.id;
  }

  async grantToUser(input: {
    userId: string;
    cosmeticId: string;
    source: import('@prisma/client').BackpackItemSource;
    grantKey: string;
  }): Promise<CosmeticGrantResult | null> {
    const cosmetic = await this.repo.getById(input.cosmeticId);
    if (!cosmetic || !cosmetic.enabled) return null;
    const res = await this.backpack.grant({
      userId: input.userId,
      type: TO_BACKPACK_TYPE[cosmetic.type],
      name: cosmetic.name,
      source: input.source,
      refId: cosmetic.id,
      transferable: cosmetic.transferable,
      grantKey: input.grantKey,
      metadata: { cosmeticId: cosmetic.id, rarity: cosmetic.rarity },
    });
    return { cosmeticId: cosmetic.id, backpackItemId: res.itemId, duplicate: res.duplicate };
  }

  // ---- Public catalog ----

  listCatalog(type?: CosmeticType): Promise<Cosmetic[]> {
    return this.repo.listActive(type);
  }

  // ---- Admin CRUD ----

  async list(q: ListCosmeticsDto): Promise<Paginated<Cosmetic>> {
    const [rows, total] = await this.repo.list(q.skip, q.limit, {
      type: q.type,
      enabled: q.enabled,
    });
    return buildPaginated(rows, total, q.page, q.limit);
  }

  create(actorId: string, dto: CosmeticDto): Promise<Cosmetic> {
    return this.repo.create(
      {
        type: dto.type,
        name: dto.name,
        mediaUrl: dto.mediaUrl ?? null,
        thumbnailUrl: dto.thumbnailUrl ?? null,
        rarity: dto.rarity,
        price: dto.price ?? 0,
        isPremium: dto.isPremium ?? false,
        transferable: dto.transferable ?? false,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
      actorId,
    );
  }

  async update(actorId: string, id: string, dto: UpdateCosmeticDto): Promise<Cosmetic> {
    if (!(await this.repo.getById(id))) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_FOUND,
        'Cosmetic not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const data: Prisma.CosmeticUpdateInput = {
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.mediaUrl !== undefined ? { mediaUrl: dto.mediaUrl } : {}),
      ...(dto.thumbnailUrl !== undefined ? { thumbnailUrl: dto.thumbnailUrl } : {}),
      ...(dto.rarity !== undefined ? { rarity: dto.rarity } : {}),
      ...(dto.price !== undefined ? { price: dto.price } : {}),
      ...(dto.isPremium !== undefined ? { isPremium: dto.isPremium } : {}),
      ...(dto.transferable !== undefined ? { transferable: dto.transferable } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };
    return this.repo.update(id, data, actorId);
  }
}
