import { Injectable } from '@nestjs/common';
import { TreasuryService } from './treasury.service';

@Injectable()
export class CoinEconomyService {
  constructor(private readonly treasuryService: TreasuryService) {}

  /**
   * Returns current Coin Economy governance state and supply breakdown
   */
  async getCoinEconomyState() {
    const summary = await this.treasuryService.getTreasurySummary();

    const maxSupplyBig = BigInt(summary.maxSupply);
    const circulatingBig = BigInt(summary.circulatingSupply);
    const reservedBig = BigInt(summary.reservedSupply);
    const treasuryBalanceBig = BigInt(summary.treasuryBalance);

    const availableMintable = maxSupplyBig - (circulatingBig + reservedBig + treasuryBalanceBig);

    return {
      maxSupply: summary.maxSupply,
      circulatingSupply: summary.circulatingSupply,
      reservedSupply: summary.reservedSupply,
      treasuryBalance: summary.treasuryBalance,
      availableMintable: availableMintable > 0n ? availableMintable.toString() : '0',
      economyStatus: summary.isFrozen ? 'FROZEN' : 'ACTIVE',
      lastUpdated: summary.lastUpdated,
    };
  }

  /**
   * Checks if coin economy is currently frozen
   */
  async isEconomyFrozen(): Promise<boolean> {
    const summary = await this.treasuryService.getTreasurySummary();
    return summary.isFrozen;
  }
}
