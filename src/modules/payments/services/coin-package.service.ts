import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  CreateCoinPackageDto,
  PackageQueryDto,
  UpdateCoinPackageDto,
} from '../dto/coin-package.dto';
import { PurchaseAuditService } from './purchase-audit.service';

@Injectable()
export class CoinPackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: PurchaseAuditService,
  ) {}

  /**
   * List purchasable coin packages with filtering
   */
  async listPackages(dto: PackageQueryDto) {
    const { platform, country, isActive = true } = dto;
    const where: any = {};

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (platform && platform !== 'ALL') {
      where.OR = [{ platform: 'ALL' }, { platform: platform.toUpperCase() }];
    }

    if (country && country !== 'GLOBAL') {
      where.OR = [{ country: 'GLOBAL' }, { country: country.toUpperCase() }];
    }

    const packages = await this.prisma.coinPackage.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { coins: 'asc' }],
    });

    return packages.map((p) => ({
      ...p,
      coins: p.coins.toString(),
      bonusCoins: p.bonusCoins.toString(),
      priceAmount: Number(p.priceAmount),
    }));
  }

  /**
   * Get single package by ID
   */
  async getPackageById(id: string) {
    const pkg = await this.prisma.coinPackage.findFirst({
      where: {
        OR: [{ id }, { code: id }],
      },
    });

    if (!pkg) {
      throw new NotFoundException(`Coin package '${id}' not found`);
    }

    return {
      ...pkg,
      coins: pkg.coins.toString(),
      bonusCoins: pkg.bonusCoins.toString(),
      priceAmount: Number(pkg.priceAmount),
    };
  }

  /**
   * Create a new coin package
   */
  async createPackage(dto: CreateCoinPackageDto, actorId?: string) {
    const existing = await this.prisma.coinPackage.findUnique({
      where: { code: dto.code },
    });
    if (existing) {
      throw new BadRequestException(`Coin package with code '${dto.code}' already exists`);
    }

    const pkg = await this.prisma.coinPackage.create({
      data: {
        code: dto.code,
        name: dto.name,
        coins: BigInt(dto.coins),
        bonusCoins: BigInt(dto.bonusCoins ?? 0),
        priceAmount: dto.priceAmount,
        currency: dto.currency ?? 'USD',
        country: dto.country ?? 'GLOBAL',
        platform: dto.platform ?? 'ALL',
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
        createdBy: actorId,
      },
    });

    await this.auditService.logAudit(
      null,
      'PACKAGE_CREATED',
      { packageId: pkg.id, code: pkg.code },
      actorId,
    );

    return {
      ...pkg,
      coins: pkg.coins.toString(),
      bonusCoins: pkg.bonusCoins.toString(),
      priceAmount: Number(pkg.priceAmount),
    };
  }

  /**
   * Update an existing coin package
   */
  async updatePackage(id: string, dto: UpdateCoinPackageDto, actorId?: string) {
    const pkg = await this.getPackageById(id);

    const updated = await this.prisma.coinPackage.update({
      where: { id: pkg.id },
      data: {
        name: dto.name,
        coins: dto.coins ? BigInt(dto.coins) : undefined,
        bonusCoins: dto.bonusCoins !== undefined ? BigInt(dto.bonusCoins) : undefined,
        priceAmount: dto.priceAmount,
        isActive: dto.isActive,
        sortOrder: dto.sortOrder,
      },
    });

    await this.auditService.logAudit(null, 'PACKAGE_UPDATED', { packageId: pkg.id }, actorId);

    return {
      ...updated,
      coins: updated.coins.toString(),
      bonusCoins: updated.bonusCoins.toString(),
      priceAmount: Number(updated.priceAmount),
    };
  }
}
