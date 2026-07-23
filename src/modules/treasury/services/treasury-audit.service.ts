import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TreasuryAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Logs a treasury operational event
   */
  async logOperation(
    operation: string,
    amount?: bigint | number | null,
    oldValue?: string,
    newValue?: string,
    reason?: string,
    actorId?: string,
  ) {
    return this.prisma.treasuryLog.create({
      data: {
        operation,
        amount: amount !== undefined && amount !== null ? BigInt(amount) : null,
        previousValue: oldValue,
        newValue,
        reason,
        actorId,
      },
    });
  }

  /**
   * Retrieves treasury log audit history
   */
  async getAuditHistory(operation?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};

    if (operation?.trim()) {
      where.operation = operation.trim().toUpperCase();
    }

    const [total, logs] = await Promise.all([
      this.prisma.treasuryLog.count({ where }),
      this.prisma.treasuryLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const items = logs.map((l) => ({
      ...l,
      amount: l.amount !== null ? l.amount.toString() : null,
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }
}
