import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class PurchaseAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Logs a purchase operation or verification audit event
   */
  async logAudit(purchaseOrderId: string | null, action: string, details?: any, actorId?: string) {
    return this.prisma.purchaseAudit.create({
      data: {
        purchaseOrderId,
        action,
        details: details ? JSON.parse(JSON.stringify(details)) : undefined,
        actorId,
      },
    });
  }

  /**
   * Retrieves purchase audit logs
   */
  async getPurchaseAuditHistory(purchaseOrderId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};

    if (purchaseOrderId) {
      where.purchaseOrderId = purchaseOrderId;
    }

    const [total, logs] = await Promise.all([
      this.prisma.purchaseAudit.count({ where }),
      this.prisma.purchaseAudit.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: logs,
    };
  }
}
