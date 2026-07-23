import { Injectable, Logger } from '@nestjs/common';
import { GiftTxnStatus, WalletCurrency } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';
import { SendGiftDto } from '../dto/send-gift.dto';
import { GiftAuditService } from './gift-audit.service';
import { GiftValidationService } from './gift-validation.service';

@Injectable()
export class GiftTransactionService {
  private readonly logger = new Logger(GiftTransactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: GiftValidationService,
    private readonly walletTxService: WalletTransactionService,
    private readonly auditService: GiftAuditService,
  ) {}

  /**
   * Executes atomic gift send flow:
   * 1. Check idempotencyKey
   * 2. Validate sender, receiver, gift, economy status & wallet balances
   * 3. Delegate coin transfer to WalletTransactionService.transferCoins()
   * 4. Insert immutable GiftTransaction record
   * 5. Emit audit events & return transaction result
   */
  async sendGift(senderId: string, dto: SendGiftDto) {
    // 1. Idempotency replayed request check
    const existingTx = await this.prisma.giftTransaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existingTx) {
      return this.formatGiftTxResponse(existingTx);
    }

    const quantity = dto.quantity ?? 1;

    // 2. Validate all pre-conditions
    const { gift, totalCoinValue } = await this.validationService.validateGiftSend(
      senderId,
      dto.receiverId,
      dto.giftId,
      quantity,
    );

    // 3. Roll Lucky Gift Multiplier (if applicable)
    let luckyMultiplier = 1;
    let isLuckyWin = false;

    if (gift.luckyMultipliers && gift.luckyMultipliers.length > 0 && gift.luckyWinChanceBp > 0) {
      const roll = Math.floor(Math.random() * 10000);
      if (roll < gift.luckyWinChanceBp) {
        isLuckyWin = true;
        const index = Math.floor(Math.random() * gift.luckyMultipliers.length);
        luckyMultiplier = gift.luckyMultipliers[index];
      }
    }

    const totalCoinsNum = Number(totalCoinValue);
    // Creator Earnings ratio calculation (default 50% split to host earnings)
    const creatorEarnings = BigInt(Math.floor(totalCoinsNum * 0.5));

    // 4. Execute atomic wallet transfer via WalletTransactionService (Immutable Double-Entry Ledger Entries)
    const walletTransferResult = await this.walletTxService.transferCoins(
      {
        senderUserId: senderId,
        recipientUserId: dto.receiverId,
        amount: totalCoinsNum,
        currency: WalletCurrency.GOLD,
        idempotencyKey: `GIFT_TX_${dto.idempotencyKey}`,
        referenceType: 'gift_transaction',
        referenceId: gift.id,
        description: `Sent ${quantity}x ${gift.name} (${dto.contextType})`,
      },
      senderId,
    );

    // 5. Create immutable GiftTransaction record
    const giftTx = await this.prisma.giftTransaction.create({
      data: {
        senderId,
        receiverId: dto.receiverId,
        giftId: gift.id,
        giftType: gift.type,
        contextType: dto.contextType,
        contextId: dto.contextId,
        quantity,
        comboTier: dto.comboTier ?? 1,
        unitCoinValue: gift.coinValue,
        totalCoinValue,
        creatorEarnings,
        luckyMultiplier,
        isLuckyWin,
        senderExp: Math.floor(totalCoinsNum * 1.0), // EXP equal to coins sent
        receiverExp: Math.floor(totalCoinsNum * 0.5),
        status: GiftTxnStatus.COMPLETED,
        idempotencyKey: dto.idempotencyKey,
        senderWalletTxnId: walletTransferResult.transactionId,
        receiverWalletTxnId: walletTransferResult.transactionId,
        metadata: dto.metadata ? JSON.parse(JSON.stringify(dto.metadata)) : undefined,
      },
    });

    // 6. Log audit record
    await this.auditService.logAudit(
      gift.id,
      'GIFT_SENT',
      {
        transactionId: giftTx.id,
        senderId,
        receiverId: dto.receiverId,
        totalCoinValue: totalCoinValue.toString(),
        contextType: dto.contextType,
        contextId: dto.contextId,
      },
      senderId,
    );

    return this.formatGiftTxResponse(giftTx);
  }

  private formatGiftTxResponse(tx: any) {
    return {
      ...tx,
      totalCoinValue: tx.totalCoinValue.toString(),
      creatorEarnings: tx.creatorEarnings.toString(),
    };
  }
}
