import { Injectable } from '@nestjs/common';
import { TreasuryService } from './treasury.service';

export interface FinancialHealthResponse {
  reserveRatioPercentage: number;
  healthStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  circulatingSupply: string;
  treasuryBalance: string;
  alerts: string[];
  lastAssessedAt: Date;
}

@Injectable()
export class FinancialHealthService {
  constructor(private readonly treasuryService: TreasuryService) {}

  /**
   * Computes reserve ratio and health indicators
   */
  async getFinancialHealth(): Promise<FinancialHealthResponse> {
    const summary = await this.treasuryService.getTreasurySummary();

    const circulating = Number(summary.circulatingSupply);
    const balance = Number(summary.treasuryBalance);

    let reserveRatioPercentage = 100;
    if (circulating > 0) {
      reserveRatioPercentage = Number(((balance / circulating) * 100).toFixed(2));
    }

    let healthStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
    const alerts: string[] = [];

    if (reserveRatioPercentage < 20) {
      healthStatus = 'CRITICAL';
      alerts.push('CRITICAL: Treasury Reserve Ratio has dropped below 20% threshold!');
    } else if (reserveRatioPercentage < 50) {
      healthStatus = 'WARNING';
      alerts.push('WARNING: Treasury Reserve Ratio is below 50% optimal reserve mark.');
    }

    if (summary.isFrozen) {
      alerts.push('NOTICE: Economy is currently under Emergency Freeze.');
    }

    return {
      reserveRatioPercentage,
      healthStatus,
      circulatingSupply: summary.circulatingSupply,
      treasuryBalance: summary.treasuryBalance,
      alerts,
      lastAssessedAt: new Date(),
    };
  }
}
