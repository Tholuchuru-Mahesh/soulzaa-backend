import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { FamilyAuditService } from './family-audit.service';
import { FamilyConfigurationService } from './family-configuration.service';
import { FamilyPermissionService } from './family-permission.service';
import { FamilyStatisticsService } from './family-statistics.service';
import { FamilyValidationService } from './family-validation.service';

export interface CreateFamilyInput {
  founderId: string;
  name: string;
  tag: string;
  badge?: string;
  logo?: string;
  banner?: string;
  description?: string;
  country?: string;
  language?: string;
  category?: string;
  privacy?: string;
  announcement?: string;
  welcomeMessage?: string;
}

export interface UpdateFamilyInput {
  familyId: string;
  actorUserId: string;
  name?: string;
  tag?: string;
  badge?: string;
  logo?: string;
  banner?: string;
  description?: string;
  privacy?: string;
  announcement?: string;
  welcomeMessage?: string;
}

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly configService: FamilyConfigurationService,
    private readonly validationService: FamilyValidationService,
    private readonly permissionService: FamilyPermissionService,
    private readonly statisticsService: FamilyStatisticsService,
    private readonly auditService: FamilyAuditService,
  ) {}

  /**
   * Creates a new family and assigns founder role under lock.
   */
  async createFamily(input: CreateFamilyInput) {
    const { founderId, name, tag } = input;
    const lockKey = `family:create:${founderId}`;

    return this.locks.withLock(lockKey, async () => {
      // 1. Validate Uniqueness & Membership
      await this.validationService.validateCreateFamily(founderId, name, tag);

      const config = await this.configService.getFamilyConfig();

      // 2. Create Family and Founder Member inside transaction
      const family = await this.prisma.$transaction(async (tx) => {
        const createdFamily = await tx.family.create({
          data: {
            name,
            tag,
            badge: input.badge,
            logo: input.logo,
            banner: input.banner,
            description: input.description,
            country: input.country ?? 'GLOBAL',
            language: input.language ?? 'en',
            category: input.category ?? 'GENERAL',
            founderId,
            status: 'ACTIVE',
            privacy: input.privacy ?? 'PUBLIC',
            announcement: input.announcement,
            welcomeMessage: input.welcomeMessage,
            maxMembers: config.maxMembers,
            memberCount: 1,
          },
        });

        await tx.familyMember.create({
          data: {
            familyId: createdFamily.id,
            userId: founderId,
            role: 'FOUNDER',
          },
        });

        await tx.familyHistory.create({
          data: {
            familyId: createdFamily.id,
            userId: founderId,
            action: 'FAMILY_CREATED',
          },
        });

        return createdFamily;
      });

      // 3. Update Statistics & Audit Log
      await this.statisticsService.updateStatistics(family.id);
      await this.auditService.logAudit(
        'FAMILY_CREATED',
        family.id,
        founderId,
        { name, tag },
        founderId,
      );

      return {
        ...family,
        exp: family.exp.toString(),
        coins: family.coins.toString(),
        score: family.score.toString(),
        reputation: family.reputation.toString(),
      };
    });
  }

  /**
   * Updates family profile parameters.
   */
  async updateFamily(input: UpdateFamilyInput) {
    const { familyId, actorUserId } = input;

    const member = await this.permissionService.getMember(familyId, actorUserId);
    if (!['FOUNDER', 'CO_FOUNDER', 'ELDER'].includes(member.role)) {
      throw new ForbiddenException('You do not have permission to update family profile');
    }

    const updated = await this.prisma.family.update({
      where: { id: familyId },
      data: {
        badge: input.badge,
        logo: input.logo,
        banner: input.banner,
        description: input.description,
        privacy: input.privacy,
        announcement: input.announcement,
        welcomeMessage: input.welcomeMessage,
      },
    });

    await this.auditService.logAudit('FAMILY_UPDATED', familyId, undefined, input, actorUserId);

    return {
      ...updated,
      exp: updated.exp.toString(),
      coins: updated.coins.toString(),
      score: updated.score.toString(),
      reputation: updated.reputation.toString(),
    };
  }

  /**
   * Transfers family ownership to another member (`FOUNDER` -> `CO_FOUNDER`).
   */
  async transferOwnership(familyId: string, currentFounderId: string, newFounderId: string) {
    const lockKey = `family:transfer:${familyId}`;

    return this.locks.withLock(lockKey, async () => {
      const currentFounder = await this.permissionService.getMember(familyId, currentFounderId);
      if (currentFounder.role !== 'FOUNDER') {
        throw new ForbiddenException('Only the current family founder can transfer ownership');
      }

      const newFounder = await this.permissionService.getMember(familyId, newFounderId);

      await this.prisma.$transaction([
        // Update Family founderId
        this.prisma.family.update({
          where: { id: familyId },
          data: { founderId: newFounderId },
        }),
        // Update new founder role to FOUNDER
        this.prisma.familyMember.update({
          where: { id: newFounder.id },
          data: { role: 'FOUNDER' },
        }),
        // Update old founder role to CO_FOUNDER
        this.prisma.familyMember.update({
          where: { id: currentFounder.id },
          data: { role: 'CO_FOUNDER' },
        }),
        this.prisma.familyHistory.create({
          data: {
            familyId,
            userId: newFounderId,
            action: 'OWNER_TRANSFERRED',
            details: { previousFounderId: currentFounderId },
          },
        }),
      ]);

      await this.auditService.logAudit(
        'OWNER_TRANSFERRED',
        familyId,
        newFounderId,
        { previousFounderId: currentFounderId },
        currentFounderId,
      );

      return { status: 'TRANSFERRED', familyId, newFounderId };
    });
  }

  /**
   * Disbands / deletes a family (Founder only).
   */
  async deleteFamily(familyId: string, founderId: string) {
    const member = await this.permissionService.getMember(familyId, founderId);
    if (member.role !== 'FOUNDER') {
      throw new ForbiddenException('Only the founder can delete or disband the family');
    }

    await this.prisma.$transaction([
      this.prisma.familyMember.deleteMany({ where: { familyId } }),
      this.prisma.family.update({
        where: { id: familyId },
        data: { status: 'DELETED' },
      }),
    ]);

    await this.auditService.logAudit(
      'FAMILY_UPDATED',
      familyId,
      undefined,
      { status: 'DELETED' },
      founderId,
    );

    return { status: 'DELETED', familyId };
  }
}
