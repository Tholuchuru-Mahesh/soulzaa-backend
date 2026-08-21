import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export const ROLE_RANKS: Record<string, number> = {
  FOUNDER: 1,
  CO_FOUNDER: 2,
  ELDER: 3,
  MODERATOR: 4,
  MEMBER: 5,
  GUEST: 6,
};

@Injectable()
export class FamilyPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns numeric rank of a family role (lower number = higher authority).
   */
  getRoleRank(role: string): number {
    return ROLE_RANKS[role.toUpperCase()] ?? 99;
  }

  /**
   * Asserts that acting member has higher authority (strictly lower rank) than target member.
   */
  assertHigherRank(actorRole: string, targetRole: string) {
    const actorRank = this.getRoleRank(actorRole);
    const targetRank = this.getRoleRank(targetRole);

    if (actorRank >= targetRank) {
      throw new ForbiddenException(
        `Action denied: your role (${actorRole}) cannot manage target role (${targetRole})`,
      );
    }
  }

  /**
   * Checks if a user is a platform SUPER_ADMIN or ADMIN.
   */
  async isSystemAdmin(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
      const userRoles = await this.prisma.userRole.findMany({
        where: { userId, suspendedAt: null },
        include: { role: true },
      });
      return userRoles.some((ur) =>
        ['SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'OFFICIAL'].includes(ur.role.name),
      );
    } catch {
      return false;
    }
  }

  /**
   * Verifies member role in family and returns membership object.
   * If the user is a platform admin (Super Admin), returns virtual root authority.
   */
  async getMember(familyId: string, userId: string) {
    const member = await this.prisma.familyMember.findFirst({
      where: { familyId, userId },
    });
    if (!member) {
      const isAdmin = await this.isSystemAdmin(userId);
      if (isAdmin) {
        return {
          id: `admin_${userId}`,
          familyId,
          userId,
          role: 'FOUNDER',
          points: BigInt(0),
          expContribution: BigInt(0),
          coinContribution: BigInt(0),
          joinedAt: new Date(),
        };
      }
      throw new ForbiddenException('User is not a member of this family');
    }
    return member;
  }
}
