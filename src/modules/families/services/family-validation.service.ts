import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class FamilyValidationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates name & tag uniqueness and non-membership before creating a family.
   */
  async validateCreateFamily(founderId: string, name: string, tag: string) {
    const [nameExisting, tagExisting, memberExisting] = await Promise.all([
      this.prisma.family.findUnique({ where: { name } }),
      this.prisma.family.findUnique({ where: { tag } }),
      this.prisma.familyMember.findUnique({ where: { userId: founderId } }),
    ]);

    if (nameExisting) {
      throw new BadRequestException(`Family name '${name}' is already taken`);
    }
    if (tagExisting) {
      throw new BadRequestException(`Family tag '${tag}' is already taken`);
    }
    if (memberExisting) {
      throw new BadRequestException('User is already a member of another family');
    }
  }

  /**
   * Validates member join pre-conditions (family active, not banned, non-member, capacity).
   */
  async validateJoinFamily(familyId: string, userId: string) {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
    });
    if (!family || family.status !== 'ACTIVE') {
      throw new ForbiddenException('Family is not active or does not exist');
    }

    const [existingMember, banRecord] = await Promise.all([
      this.prisma.familyMember.findUnique({ where: { userId } }),
      this.prisma.familyBan.findUnique({
        where: { familyId_userId: { familyId, userId } },
      }),
    ]);

    if (existingMember) {
      throw new BadRequestException('User is already a member of a family');
    }
    if (banRecord) {
      throw new ForbiddenException('User is banned from joining this family');
    }

    if (family.memberCount >= family.maxMembers) {
      throw new BadRequestException('Family has reached maximum member capacity');
    }

    return family;
  }
}
