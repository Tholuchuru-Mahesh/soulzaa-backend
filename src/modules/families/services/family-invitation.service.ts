import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { FamilyAuditService } from './family-audit.service';
import { FamilyPermissionService } from './family-permission.service';
import { FamilyValidationService } from './family-validation.service';

export interface SendInvitationInput {
  familyId: string;
  inviterId: string;
  inviteeId: string;
}

@Injectable()
export class FamilyInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: FamilyPermissionService,
    private readonly validationService: FamilyValidationService,
    private readonly auditService: FamilyAuditService,
  ) {}

  /**
   * Sends an invitation to a user to join a family.
   */
  async sendInvitation(input: SendInvitationInput) {
    const { familyId, inviterId, inviteeId } = input;

    // 1. Verify inviter permission
    const inviter = await this.permissionService.getMember(familyId, inviterId);
    if (!['FOUNDER', 'CO_FOUNDER', 'ELDER', 'MODERATOR'].includes(inviter.role)) {
      throw new ForbiddenException('You do not have permission to invite members');
    }

    // 2. Validate invitee eligibility
    await this.validationService.validateJoinFamily(familyId, inviteeId);

    // 3. Create or update invitation with 7-day expiration
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await this.prisma.familyInvitation.create({
      data: {
        familyId,
        inviterId,
        inviteeId,
        expiresAt,
        status: 'PENDING',
      },
    });

    return invitation;
  }

  /**
   * Accepts a family invitation.
   */
  async acceptInvitation(invitationId: string, userId: string) {
    const invitation = await this.prisma.familyInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation || invitation.inviteeId !== userId) {
      throw new BadRequestException('Invitation not found or unauthorized');
    }

    if (invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation is expired or no longer active');
    }

    const family = await this.validationService.validateJoinFamily(invitation.familyId, userId);

    await this.prisma.$transaction([
      this.prisma.familyInvitation.update({
        where: { id: invitationId },
        data: { status: 'ACCEPTED' },
      }),
      this.prisma.familyMember.create({
        data: {
          familyId: invitation.familyId,
          userId,
          role: 'MEMBER',
        },
      }),
      this.prisma.family.update({
        where: { id: invitation.familyId },
        data: { memberCount: { increment: 1 } },
      }),
      this.prisma.familyHistory.create({
        data: {
          familyId: invitation.familyId,
          userId,
          action: 'MEMBER_JOINED',
          details: { via: 'INVITATION', inviterId: invitation.inviterId },
        },
      }),
    ]);

    await this.auditService.logAudit('MEMBER_JOINED', invitation.familyId, userId, {
      via: 'INVITATION',
    });

    return { status: 'ACCEPTED', familyId: invitation.familyId, userId };
  }

  /**
   * Rejects a family invitation.
   */
  async rejectInvitation(invitationId: string, userId: string) {
    const invitation = await this.prisma.familyInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation || invitation.inviteeId !== userId) {
      throw new BadRequestException('Invitation not found or unauthorized');
    }

    return this.prisma.familyInvitation.update({
      where: { id: invitationId },
      data: { status: 'REJECTED' },
    });
  }
}
