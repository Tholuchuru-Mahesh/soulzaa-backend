import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SettingSearchFilterDto } from '../dto/setting-query.dto';

@Injectable()
export class SettingsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search and filter platform settings with pagination
   */
  async searchSettings(dto: SettingSearchFilterDto) {
    const {
      query,
      category,
      isFeatureFlag,
      page = 1,
      limit = 50,
      sortBy = 'category',
      sortOrder = 'asc',
    } = dto;

    const skip = (page - 1) * limit;
    const where: any = {};

    if (query?.trim()) {
      const q = query.trim();
      where.OR = [
        { key: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
      ];
    }

    if (category) {
      where.category = category.toUpperCase();
    }

    if (isFeatureFlag !== undefined) {
      where.isFeatureFlag = isFeatureFlag;
    }

    const [total, settings] = await Promise.all([
      this.prisma.platformSetting.count({ where }),
      this.prisma.platformSetting.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
    ]);

    // Mask secret setting values
    const sanitizedItems = settings.map((s) => ({
      ...s,
      value: s.isSecret ? '********' : s.value,
      defaultValue: s.isSecret && s.defaultValue ? '********' : s.defaultValue,
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: sanitizedItems,
    };
  }

  /**
   * Get single setting details by key
   */
  async getSettingByKey(key: string) {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key },
    });

    if (!setting) {
      throw new NotFoundException(`Setting with key '${key}' not found`);
    }

    return {
      ...setting,
      value: setting.isSecret ? '********' : setting.value,
      defaultValue: setting.isSecret && setting.defaultValue ? '********' : setting.defaultValue,
    };
  }

  /**
   * List distinct setting categories
   */
  async listCategories() {
    const categories = await this.prisma.platformSetting.groupBy({
      by: ['category'],
      _count: { key: true },
    });

    return categories.map((c) => ({
      category: c.category,
      count: c._count.key,
    }));
  }
}
