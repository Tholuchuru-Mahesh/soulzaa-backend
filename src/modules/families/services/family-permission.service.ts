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
   * Verifies member role in family and returns membership object.
   */
  async getMember(familyId: string, userId: string) {
    const member = await this.prisma.familyMember.findFirst({
      where: { familyId, userId },
    });
    if (!member) {
      throw new ForbiddenException('User is not a member of this family');
    }
    return member;
  }
}
