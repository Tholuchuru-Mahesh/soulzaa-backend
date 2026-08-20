import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { FamilyAuditService } from './family-audit.service';
import { FamilyPermissionService } from './family-permission.service';

export interface KickMemberInput {
  familyId: string;
  actorUserId: string;
  targetUserId: string;
  reason?: string;
}

export interface BanMemberInput {
  familyId: string;
  actorUserId: string;
  targetUserId: string;
  reason?: string;
}

@Injectable()
export class FamilyMemberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly permissionService: FamilyPermissionService,
    private readonly auditService: FamilyAuditService,
  ) {}

  /**
   * Leaves a family (non-founder only).
   */
  async leaveFamily(familyId: string, userId: string) {
    const lockKey = `family:member:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      const member = await this.permissionService.getMember(familyId, userId);

      if (member.role === 'FOUNDER') {
        throw new BadRequestException(
          'Founder cannot leave the family. Transfer ownership or delete the family.',
        );
      }

      await this.prisma.$transaction([
        this.prisma.familyMember.delete({ where: { id: member.id } }),
        this.prisma.family.update({
          where: { id: familyId },
          data: { memberCount: { decrement: 1 } },
        }),
        this.prisma.familyHistory.create({
          data: {
            familyId,
            userId,
            action: 'MEMBER_LEFT',
          },
        }),
      ]);

      await this.auditService.logAudit('MEMBER_LEFT', familyId, userId, {}, userId);

      return { status: 'LEFT', familyId, userId };
    });
  }

  /**
   * Kicks a member from the family while asserting higher rank.
   */
  async kickMember(input: KickMemberInput) {
    const { familyId, actorUserId, targetUserId, reason } = input;
    const lockKey = `family:member:${targetUserId}`;

    return this.locks.withLock(lockKey, async () => {
      const isActorAdmin = await this.permissionService.isSystemAdmin(actorUserId);
      const target = await this.permissionService.getMember(familyId, targetUserId);

      if (!isActorAdmin) {
        const actor = await this.permissionService.getMember(familyId, actorUserId);
        if (target.role === 'FOUNDER') {
          throw new BadRequestException('Cannot kick the family founder.');
        }
        this.permissionService.assertHigherRank(actor.role, target.role);
      }

      await this.prisma.$transaction([
        this.prisma.familyMember.delete({ where: { id: target.id } }),
        this.prisma.family.update({
          where: { id: familyId },
          data: { memberCount: { decrement: 1 } },
        }),
        this.prisma.familyHistory.create({
          data: {
            familyId,
            userId: targetUserId,
            action: 'MEMBER_KICKED',
            details: { reason, actorId: actorUserId },
          },
        }),
      ]);

      await this.auditService.logAudit(
        'MEMBER_KICKED',
        familyId,
        targetUserId,
        { reason },
        actorUserId,
      );

      return { status: 'KICKED', familyId, targetUserId };
    });
  }

  /**
   * Bans a member from the family (kicks if member, inserts FamilyBan).
   */
  async banMember(input: BanMemberInput) {
    const { familyId, actorUserId, targetUserId, reason } = input;

    const isActorAdmin = await this.permissionService.isSystemAdmin(actorUserId);
    const target = await this.prisma.familyMember.findFirst({
      where: { familyId, userId: targetUserId },
    });

    if (!isActorAdmin) {
      const actor = await this.permissionService.getMember(familyId, actorUserId);
      if (target) {
        if (target.role === 'FOUNDER') {
          throw new BadRequestException('Cannot ban the family founder.');
        }
        this.permissionService.assertHigherRank(actor.role, target.role);
      }
    }

    await this.prisma.$transaction([
      ...(target ? [this.prisma.familyMember.delete({ where: { id: target.id } })] : []),
      ...(target
        ? [
            this.prisma.family.update({
              where: { id: familyId },
              data: { memberCount: { decrement: 1 } },
            }),
          ]
        : []),
      this.prisma.familyBan.upsert({
        where: { familyId_userId: { familyId, userId: targetUserId } },
        update: { reason, bannedById: actorUserId },
        create: { familyId, userId: targetUserId, bannedById: actorUserId, reason },
      }),
      this.prisma.familyHistory.create({
        data: {
          familyId,
          userId: targetUserId,
          action: 'MEMBER_BANNED',
          details: { reason, actorId: actorUserId },
        },
      }),
    ]);

    await this.auditService.logAudit(
      'MEMBER_BANNED',
      familyId,
      targetUserId,
      { reason },
      actorUserId,
    );

    return { status: 'BANNED', familyId, targetUserId };
  }

  /**
   * Unbans a user from the family.
   */
  async unbanMember(familyId: string, actorUserId: string, targetUserId: string) {
    await this.permissionService.getMember(familyId, actorUserId);

    await this.prisma.familyBan.deleteMany({
      where: { familyId, userId: targetUserId },
    });

    return { status: 'UNBANNED', familyId, targetUserId };
  }
}
