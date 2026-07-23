import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { FamilyAuditService } from './family-audit.service';
import { FamilyPermissionService } from './family-permission.service';
import { FamilyValidationService } from './family-validation.service';

@Injectable()
export class FamilyRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: FamilyPermissionService,
    private readonly validationService: FamilyValidationService,
    private readonly auditService: FamilyAuditService,
  ) {}

  /**
   * Submits a join request to a family (or auto-approves if family setting is PUBLIC/autoAccept).
   */
  async submitJoinRequest(familyId: string, userId: string) {
    const family = await this.validationService.validateJoinFamily(familyId, userId);

    const existingReq = await this.prisma.familyJoinRequest.findFirst({
      where: { familyId, userId, status: 'PENDING' },
    });
    if (existingReq) {
      throw new BadRequestException('You already have a pending join request for this family');
    }

    if (family.privacy === 'PUBLIC') {
      // Auto-join public family
      await this.prisma.$transaction([
        this.prisma.familyMember.create({
          data: { familyId, userId, role: 'MEMBER' },
        }),
        this.prisma.family.update({
          where: { id: familyId },
          data: { memberCount: { increment: 1 } },
        }),
        this.prisma.familyHistory.create({
          data: { familyId, userId, action: 'MEMBER_JOINED', details: { via: 'PUBLIC_AUTO_JOIN' } },
        }),
      ]);

      await this.auditService.logAudit('MEMBER_JOINED', familyId, userId, {
        via: 'PUBLIC_AUTO_JOIN',
      });
      return { status: 'JOINED', familyId, userId };
    }

    return this.prisma.familyJoinRequest.create({
      data: {
        familyId,
        userId,
        status: 'PENDING',
      },
    });
  }

  /**
   * Approves a pending family join request.
   */
  async approveJoinRequest(requestId: string, reviewerId: string) {
    const req = await this.prisma.familyJoinRequest.findUnique({
      where: { id: requestId },
    });
    if (!req || req.status !== 'PENDING') {
      throw new BadRequestException('Join request not found or not pending');
    }

    const reviewer = await this.permissionService.getMember(req.familyId, reviewerId);
    if (!['FOUNDER', 'CO_FOUNDER', 'ELDER', 'MODERATOR'].includes(reviewer.role)) {
      throw new ForbiddenException('You do not have permission to approve join requests');
    }

    await this.validationService.validateJoinFamily(req.familyId, req.userId);

    await this.prisma.$transaction([
      this.prisma.familyJoinRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED', reviewerId },
      }),
      this.prisma.familyMember.create({
        data: { familyId: req.familyId, userId: req.userId, role: 'MEMBER' },
      }),
      this.prisma.family.update({
        where: { id: req.familyId },
        data: { memberCount: { increment: 1 } },
      }),
      this.prisma.familyHistory.create({
        data: {
          familyId: req.familyId,
          userId: req.userId,
          action: 'MEMBER_JOINED',
          details: { via: 'APPROVED_REQUEST', reviewerId },
        },
      }),
    ]);

    await this.auditService.logAudit('MEMBER_JOINED', req.familyId, req.userId, { reviewerId });

    return { status: 'APPROVED', requestId, userId: req.userId };
  }

  /**
   * Rejects a pending family join request.
   */
  async rejectJoinRequest(requestId: string, reviewerId: string) {
    const req = await this.prisma.familyJoinRequest.findUnique({
      where: { id: requestId },
    });
    if (!req || req.status !== 'PENDING') {
      throw new BadRequestException('Join request not found or not pending');
    }

    const reviewer = await this.permissionService.getMember(req.familyId, reviewerId);
    if (!['FOUNDER', 'CO_FOUNDER', 'ELDER', 'MODERATOR'].includes(reviewer.role)) {
      throw new ForbiddenException('You do not have permission to reject join requests');
    }

    return this.prisma.familyJoinRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', reviewerId },
    });
  }
}
