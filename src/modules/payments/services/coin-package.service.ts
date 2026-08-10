import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PLATFORM_CONFIG,
  type IPlatformConfiguration,
} from 'src/modules/platform-configuration/interfaces/platform-configuration.interface';
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
    @Inject(PLATFORM_CONFIG) private readonly platformConfig: IPlatformConfiguration,
  ) {}

  /**
   * Tax percentage applied to a storefront, from Super Admin configuration.
   *
   * Server-side because tax is an economy value (PRD §12, §36) and a rate baked
   * into a shipped app cannot be corrected without a release — which is exactly
   * where it used to live, as a `const _gstRate = 0.18` in the Flutter buy
   * screen alongside a hardcoded "GST only applies to INR" rule.
   *
   * Resolution order is country-specific, then platform-wide, then none. The
   * fallback is 0, not a guessed 18: showing a tax the platform never
   * configured overstates what the user is about to be charged, and a wrong
   * total on the payment screen reads as a bait-and-switch.
   */
  private async resolveTaxRatePercent(country?: string | null): Promise<number> {
    const keys = country ? [`payments.tax_rate_percent.${country.toUpperCase()}`] : [];
    keys.push('payments.tax_rate_percent');

    for (const key of keys) {
      const value = await this.platformConfig.get<unknown>(key);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  }

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

    // Resolved once per distinct storefront rather than per row: the catalogue
    // is small, but every lookup is a cache/DB round trip.
    const taxByCountry = new Map<string, number>();
    for (const p of packages) {
      const key = (p.country ?? '').toUpperCase();
      if (!taxByCountry.has(key)) {
        taxByCountry.set(key, await this.resolveTaxRatePercent(p.country));
      }
    }

    return packages.map((p) => ({
      ...p,
      coins: p.coins.toString(),
      bonusCoins: p.bonusCoins.toString(),
      priceAmount: Number(p.priceAmount),
      /// Percentage (e.g. 18 for 18%), not a fraction. The client renders this
      /// as-is and must not apply a rate of its own.
      taxRatePercent: taxByCountry.get((p.country ?? '').toUpperCase()) ?? 0,
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
