import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { FamilyAuditService } from './family-audit.service';
import { FamilyPermissionService } from './family-permission.service';

export interface ChangeRoleInput {
  familyId: string;
  actorUserId: string;
  targetUserId: string;
  newRole: 'FOUNDER' | 'CO_FOUNDER' | 'ELDER' | 'MODERATOR' | 'MEMBER' | 'GUEST';
}

@Injectable()
export class FamilyRoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: FamilyPermissionService,
    private readonly auditService: FamilyAuditService,
  ) {}

  /**
   * Promotes or demotes a family member while checking rank authority.
   */
  async changeMemberRole(input: ChangeRoleInput) {
    const { familyId, actorUserId, targetUserId, newRole } = input;

    // 1. Check if actor is system admin or in-game leader
    const isActorAdmin = await this.permissionService.isSystemAdmin(actorUserId);
    const target = await this.permissionService.getMember(familyId, targetUserId);

    if (newRole === 'FOUNDER') {
      const family = await this.prisma.family.findUnique({ where: { id: familyId } });
      const currentFounderMember = await this.prisma.familyMember.findFirst({
        where: { familyId, role: 'FOUNDER' },
      });

      await this.prisma.$transaction([
        this.prisma.family.update({
          where: { id: familyId },
          data: { founderId: targetUserId },
        }),
        this.prisma.familyMember.update({
          where: { id: target.id },
          data: { role: 'FOUNDER' },
        }),
        ...(currentFounderMember && currentFounderMember.id !== target.id
          ? [
              this.prisma.familyMember.update({
                where: { id: currentFounderMember.id },
                data: { role: 'CO_FOUNDER' },
              }),
            ]
          : []),
        this.prisma.familyHistory.create({
          data: {
            familyId,
            userId: targetUserId,
            action: 'OWNER_TRANSFERRED',
            details: {
              previousFounderId: family?.founderId,
              newFounderUserId: targetUserId,
              actorId: actorUserId,
            },
          },
        }),
      ]);

      await this.auditService.logAudit(
        'OWNER_TRANSFERRED',
        familyId,
        targetUserId,
        { previousFounderId: family?.founderId },
        actorUserId,
      );

      return { status: 'TRANSFERRED', familyId, targetUserId, newRole: 'FOUNDER' };
    }

    if (!isActorAdmin) {
      const actor = await this.permissionService.getMember(familyId, actorUserId);
      if (target.role === 'FOUNDER') {
        throw new BadRequestException(
          'Founder role cannot be changed via role assignment. Use ownership transfer.',
        );
      }
      this.permissionService.assertHigherRank(actor.role, target.role);
      this.permissionService.assertHigherRank(actor.role, newRole);
    }

    const oldRole = target.role;

    // 3. Update member role
    const updated = await this.prisma.familyMember.update({
      where: { id: target.id },
      data: { role: newRole },
    });

    // 4. Record history and audit
    await this.prisma.familyHistory.create({
      data: {
        familyId,
        userId: targetUserId,
        action: 'ROLE_CHANGED',
        details: { fromRole: oldRole, toRole: newRole, actorId: actorUserId },
      },
    });

    await this.auditService.logAudit(
      'ROLE_CHANGED',
      familyId,
      targetUserId,
      {
        fromRole: oldRole,
        toRole: newRole,
      },
      actorUserId,
    );

    return updated;
  }
}
