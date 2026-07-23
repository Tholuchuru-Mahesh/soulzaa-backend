import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class ConfigurationHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a historical audit log entry when a setting value changes
   */
  async recordHistory(
    settingId: string,
    oldValue: string | null,
    newValue: string,
    changeReason?: string,
    changedBy?: string,
  ) {
    return this.prisma.settingHistory.create({
      data: {
        settingId,
        oldValue,
        newValue,
        changeReason,
        changedBy,
      },
    });
  }

  /**
   * Gets change history entries for a given setting key or setting ID
   */
  async getSettingHistory(settingKeyOrId: string) {
    const setting = await this.prisma.platformSetting.findFirst({
      where: {
        OR: [{ id: settingKeyOrId }, { key: settingKeyOrId }],
      },
    });

    if (!setting) {
      throw new NotFoundException(`Setting '${settingKeyOrId}' not found`);
    }

    const histories = await this.prisma.settingHistory.findMany({
      where: { settingId: setting.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      settingId: setting.id,
      key: setting.key,
      category: setting.category,
      histories,
    };
  }
}
