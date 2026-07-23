import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { FinancialPolicyService } from 'src/modules/treasury/services/financial-policy.service';
import { WalletService } from 'src/modules/wallet/services/wallet.service';
import { GiftCatalogService } from './gift-catalog.service';

@Injectable()
export class GiftValidationService {
  constructor(
    private readonly coinEconomyService: CoinEconomyService,
    private readonly financialPolicyService: FinancialPolicyService,
    private readonly walletService: WalletService,
    private readonly catalogService: GiftCatalogService,
  ) {}

  /**
   * Validates all pre-conditions before executing a gift transaction
   */
  async validateGiftSend(senderId: string, receiverId: string, giftId: string, quantity: number) {
    // 1. Prevent self-gifting
    if (senderId === receiverId) {
      throw new BadRequestException('Sending gifts to yourself is not allowed');
    }

    // 2. Check Treasury Economy Freeze
    const isFrozen = await this.coinEconomyService.isEconomyFrozen();
    if (isFrozen) {
      throw new ForbiddenException(
        'Gift sending is temporarily suspended due to Emergency Economy Freeze',
      );
    }

    // 3. Fetch & Validate Gift catalog entity
    const gift = await this.catalogService.getGiftById(giftId);
    if (!gift.enabled) {
      throw new BadRequestException(`Gift '${gift.name}' is currently disabled`);
    }

    // 4. Validate Total Coin Value calculation
    const totalCoinValue = BigInt(gift.coinValue) * BigInt(quantity);

    // 5. Validate Financial Policy Cap for single gift transaction
    const isWithinLimit = await this.financialPolicyService.validatePolicyLimit(
      'max_single_gift_amount',
      Number(totalCoinValue),
    );
    if (!isWithinLimit) {
      throw new BadRequestException(
        `Gift total value exceeds platform single gift transaction limit`,
      );
    }

    // 6. Validate Sender Wallet Balance
    const senderWallet = await this.walletService.getOrCreateWallet(senderId);
    if (senderWallet.status !== 'ACTIVE') {
      throw new ForbiddenException(`Sender wallet status is '${senderWallet.status}'`);
    }

    if (senderWallet.availableBalance < totalCoinValue) {
      throw new BadRequestException(
        `Insufficient available wallet balance (${senderWallet.availableBalance.toString()}) to send gift (cost: ${totalCoinValue.toString()})`,
      );
    }

    // 7. Validate Receiver Wallet Status
    const receiverWallet = await this.walletService.getOrCreateWallet(receiverId);
    if (receiverWallet.status !== 'ACTIVE') {
      throw new ForbiddenException(`Receiver wallet status is '${receiverWallet.status}'`);
    }

    return {
      gift,
      totalCoinValue,
      senderWallet,
      receiverWallet,
    };
  }
}
