import { Injectable, Logger } from '@nestjs/common';
import { PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class PurchaseReconciliationService {
  private readonly logger = new Logger(PurchaseReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Identifies expired purchase orders past their expiration timestamp and marks them as EXPIRED
   */
  async reconcileExpiredOrders() {
    const now = new Date();
    const expiredCount = await this.prisma.purchaseOrder.updateMany({
      where: {
        status: { in: [PurchaseOrderStatus.CREATED, PurchaseOrderStatus.PENDING_PAYMENT] },
        expiresAt: { lt: now },
      },
      data: {
        status: PurchaseOrderStatus.EXPIRED,
      },
    });

    if (expiredCount.count > 0) {
      this.logger.log(`Reconciled and marked ${expiredCount.count} purchase orders as EXPIRED`);
    }

    return { expiredCount: expiredCount.count, timestamp: now };
  }
}
