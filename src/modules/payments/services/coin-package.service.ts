import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  CreateCoinPackageDto,
  PackageQueryDto,
  UpdateCoinPackageDto,
} from '../dto/coin-package.dto';
import { PurchaseAuditService } from './purchase-audit.service';

/**
 * Storefront shown to a signed-in user we could not place geographically.
 *
 * India is the launch market and the only one with a priced panel, so an
 * unplaced user is far more likely to be Indian than not. The previous
 * behaviour — GLOBAL only — made the INR catalogue unreachable in practice,
 * because nothing in the signup flow ever sets `countryId`.
 *
 * Server-side constant on purpose: it must never be sourced from the request,
 * or a client could pick its own region's pricing again.
 */
const DEFAULT_STOREFRONT_COUNTRY = (process.env.DEFAULT_STOREFRONT_COUNTRY ?? 'IN').toUpperCase();

@Injectable()
export class CoinPackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: PurchaseAuditService,
  ) {}

  /**
   * Resolves the storefront country for a caller from their normalised location.
   *
   * Server-side on purpose: the country used to come from a query parameter, so
   * a client could ask for any region's pricing simply by changing it. A user
   * with no normalised location sees only GLOBAL packages.
   */
  private async resolveStorefrontCountry(userId?: string): Promise<string | null> {
    if (!userId) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { locationCountry: { select: { code: true } } },
    });
    return user?.locationCountry?.code ?? null;
  }

  /**
   * List purchasable coin packages with filtering.
   *
   * `userId` drives regional pricing. `dto.country` is honoured only when no
   * user is supplied (catalogue management), never for the storefront.
   */
  async listPackages(dto: PackageQueryDto, userId?: string) {
    const { platform, isActive = true } = dto;
    const country = userId ? await this.resolveStorefrontCountry(userId) : dto.country;

    // AND, not repeated `where.OR`: assigning OR twice silently dropped the
    // platform constraint whenever a country was also supplied.
    const and: Array<Record<string, unknown>> = [];

    if (platform && platform !== 'ALL') {
      and.push({ OR: [{ platform: 'ALL' }, { platform: platform.toUpperCase() }] });
    }

    if (country && country !== 'GLOBAL') {
      and.push({ OR: [{ country: 'GLOBAL' }, { country: country.toUpperCase() }] });
    } else if (userId) {
      // An un-normalised user gets GLOBAL plus the default storefront, not the
      // whole catalogue and not GLOBAL alone. See DEFAULT_STOREFRONT_COUNTRY.
      and.push({ OR: [{ country: 'GLOBAL' }, { country: DEFAULT_STOREFRONT_COUNTRY }] });
    }

    const where: Record<string, unknown> = {};
    if (isActive !== undefined) {
      where.isActive = isActive;
    }
    if (and.length > 0) {
      where.AND = and;
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
        googleProductId: dto.googleProductId,
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
        googleProductId: dto.googleProductId,
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
