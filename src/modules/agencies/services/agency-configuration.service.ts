import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface AgencyCommissionConfig {
  commissionPercentage: number;
  subAgencyPercentage: number;
  bdPercentage: number;
  minimumCommission: number;
}

@Injectable()
export class AgencyConfigurationService {
  private readonly logger = new Logger(AgencyConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: ConfigurationEngineService,
  ) {}

  /**
   * Retrieves active agency commission config from Platform Configuration.
   * Defaults to 10.0% if unconfigured.
   */
  async getCommissionConfig(): Promise<AgencyCommissionConfig> {
    try {
      const commissionPct =
        (await this.platformConfig.get<number>('agency.commission_percentage')) ?? 10.0;
      const subAgencyPct =
        (await this.platformConfig.get<number>('future.subagency_percentage')) ?? 0.0;
      const bdPct =
        (await this.platformConfig.get<number>('future.business_development_percentage')) ?? 0.0;
      const minComm = (await this.platformConfig.get<number>('agency.minimum_commission')) ?? 1;

      return {
        commissionPercentage: commissionPct,
        subAgencyPercentage: subAgencyPct,
        bdPercentage: bdPct,
        minimumCommission: minComm,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch dynamic agency config, using 10% fallback: ${(err as Error).message}`,
      );
      return {
        commissionPercentage: 10.0,
        subAgencyPercentage: 0.0,
        bdPercentage: 0.0,
        minimumCommission: 1,
      };
    }
  }

  /**
   * Upsert agency configuration parameter (Admin path).
   */
  async updateConfigParameter(key: string, value: any) {
    return this.prisma.agencyConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}
