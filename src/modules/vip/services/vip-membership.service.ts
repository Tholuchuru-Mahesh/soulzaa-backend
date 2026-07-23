import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { VipAuditService } from './vip-audit.service';

@Injectable()
export class VipMembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: VipAuditService,
  ) {}

  /**
   * Suspends an active VIP membership (Admin operation).
   */
  async suspendMembership(userId: string, actorId: string, reason?: string) {
    const membership = await this.prisma.vipMembership.findUnique({
      where: { userId },
    });
    if (!membership) {
      throw new BadRequestException('VIP membership not found for user');
    }

    const updated = await this.prisma.vipMembership.update({
      where: { id: membership.id },
      data: { status: 'SUSPENDED' },
    });

    await this.prisma.vipHistory.create({
      data: {
        userId,
        action: 'VIP_SUSPENDED',
        details: { reason, actorId },
      },
    });

    await this.auditService.logAudit('VIP_SUSPENDED', userId, { reason }, actorId);

    return updated;
  }

  /**
   * Restores a suspended VIP membership (Admin operation).
   */
  async restoreMembership(userId: string, actorId: string) {
    const membership = await this.prisma.vipMembership.findUnique({
      where: { userId },
    });
    if (!membership) {
      throw new BadRequestException('VIP membership not found for user');
    }

    const updated = await this.prisma.vipMembership.update({
      where: { id: membership.id },
      data: { status: 'ACTIVE' },
    });

    await this.prisma.vipHistory.create({
      data: {
        userId,
        action: 'VIP_RESTORED',
        details: { actorId },
      },
    });

    await this.auditService.logAudit('VIP_RESTORED', userId, {}, actorId);

    return updated;
  }

  /**
   * Checks and marks expired memberships as EXPIRED.
   */
  async processExpirations() {
    const expired = await this.prisma.vipMembership.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lt: new Date() },
      },
    });

    for (const m of expired) {
      await this.prisma.vipMembership.update({
        where: { id: m.id },
        data: { status: 'EXPIRED' },
      });

      await this.auditService.logAudit('VIP_EXPIRED', m.userId, { membershipId: m.id });
    }

    return { processedCount: expired.length };
  }
}
