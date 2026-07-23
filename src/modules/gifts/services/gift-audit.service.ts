import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class GiftAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Logs a gift management or transaction audit event
   */
  async logAudit(giftId: string | null, action: string, details?: any, actorId?: string) {
    return this.prisma.giftAudit.create({
      data: {
        giftId,
        action,
        details: details ? JSON.parse(JSON.stringify(details)) : undefined,
        actorId,
      },
    });
  }

  /**
   * Retrieves gift audit history
   */
  async getGiftAuditHistory(giftId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};

    if (giftId) {
      where.giftId = giftId;
    }

    const [total, logs] = await Promise.all([
      this.prisma.giftAudit.count({ where }),
      this.prisma.giftAudit.findMany({
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
