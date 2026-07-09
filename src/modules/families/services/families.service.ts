import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  Family,
  FamilyJoinRequest,
  FamilyLog,
  FamilyMember,
  FamilyRequestStatus,
  FamilyRole,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  CreateFamilyDto,
  ManageRequestDto,
  PromoteMemberDto,
  TransferLeadershipDto,
  UpdateFamilyDto,
} from '../dto/families.dto';
import {
  FamilyCreatedEvent,
  FamilyDeletedEvent,
  FamilyMemberJoinedEvent,
  FamilyMemberLeftEvent,
} from '../events/families.events';
import type { IFamiliesService } from '../interfaces/families.service.interface';
import { FamiliesRepository } from '../repositories/families.repository';

// Family experience ladder:
// Level 1: 0 exp
// Level 2: 10,000 exp
// Level 3: 50,000 exp
// Level 4: 100,000 exp
// Level 5: 250,000 exp
// Level 6: 500,000 exp
// Level 7: 1,000,000 exp
// Level 8: 2,500,000 exp
// Level 9: 5,000,000 exp
// Level 10: 10,000,000 exp
const FAMILY_LEVEL_LADDER: { level: number; minExp: bigint }[] = [
  { level: 1, minExp: 0n },
  { level: 2, minExp: 10_000n },
  { level: 3, minExp: 50_000n },
  { level: 4, minExp: 100_000n },
  { level: 5, minExp: 250_000n },
  { level: 6, minExp: 500_000n },
  { level: 7, minExp: 1_000_000n },
  { level: 8, minExp: 2_500_000n },
  { level: 9, minExp: 5_000_000n },
  { level: 10, minExp: 10_000_000n },
];

@Injectable()
export class FamiliesService implements IFamiliesService {
  private readonly logger = new Logger(FamiliesService.name);

  constructor(
    private readonly repo: FamiliesRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  // ---- IFamiliesService (cross-module interface) ----

  async getMemberFamilyId(userId: string): Promise<string | null> {
    const member = await this.repo.findMemberByUserId(userId);
    return member ? member.familyId : null;
  }

  async addFamilyExp(familyId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const family = await this.repo.findById(familyId);
    if (!family) return;

    const newExp = family.exp + BigInt(amount);
    const newLevel = this.calculateLevel(newExp);

    await this.repo.updateFamily(familyId, {
      exp: newExp,
      level: newLevel,
    });

    if (newLevel > family.level) {
      this.logger.log(`Family ${family.name} (${familyId}) leveled up to Level ${newLevel}`);
      // Future hook: Emit family level up event if needed
    }
  }

  async incrementMemberContribution(userId: string, points: number): Promise<void> {
    if (points <= 0) return;
    const member = await this.repo.findMemberByUserId(userId);
    if (!member) return;

    await this.repo.updateMember(member.id, {
      contributionPoints: {
        increment: points,
      },
    });
  }

  // ---- REST API business methods ----

  async create(creatorId: string, dto: CreateFamilyDto): Promise<Family> {
    // 1. Ensure creator is not already in a family
    const existingMember = await this.repo.findMemberByUserId(creatorId);
    if (existingMember) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_IN_FAMILY,
        'You are already a member of a family.',
        HttpStatus.CONFLICT,
      );
    }

    // 2. Ensure name is unique
    const existingFamily = await this.repo.findByName(dto.name);
    if (existingFamily) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_NAME_EXISTS,
        'Family name is already taken.',
        HttpStatus.CONFLICT,
      );
    }

    // 3. Create family
    const family = await this.repo.createFamily(
      {
        name: dto.name,
        description: dto.description,
        logoKey: dto.logoKey,
        leaderId: creatorId,
        memberCount: 1,
        maxMembers: 100, // Default limit
      },
      {
        userId: creatorId,
        role: FamilyRole.LEADER,
      },
    );

    // 4. Publish Event
    await this.bus.publish(
      new FamilyCreatedEvent({
        familyId: family.id,
        name: family.name,
        leaderId: creatorId,
      }),
    );

    return family;
  }

  async get(id: string): Promise<Family> {
    const family = await this.repo.findById(id);
    if (!family) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_NOT_FOUND,
        'Family not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return family;
  }

  async update(userId: string, familyId: string, dto: UpdateFamilyDto): Promise<Family> {
    await this.get(familyId); // Enforces existence

    // Validate authority: Leader or Co-Leader
    const member = await this.repo.findMemberByUserId(userId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (member.role !== FamilyRole.LEADER && member.role !== FamilyRole.CO_LEADER) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders and Co-Leaders can edit family details.',
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.repo.updateFamily(familyId, dto);

    await this.repo.logAction(familyId, userId, 'EDIT_PROFILE', dto as any);

    return updated;
  }

  async join(userId: string, familyId: string): Promise<any> {
    // 1. Ensure user is not already in a family
    const existingMember = await this.repo.findMemberByUserId(userId);
    if (existingMember) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_IN_FAMILY,
        'You are already a member of a family.',
        HttpStatus.CONFLICT,
      );
    }

    // 2. Enforce family existence
    const family = await this.get(familyId);

    // 3. Auto accept logic
    if (family.autoAccept) {
      if (family.memberCount >= family.maxMembers) {
        throw new BusinessException(
          ERROR_CODES.FAMILY_LIMIT_REACHED,
          'This family has reached its maximum member limit.',
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.repo.addMember(familyId, userId, FamilyRole.MEMBER);
      await this.repo.logAction(familyId, userId, 'JOIN');

      await this.bus.publish(
        new FamilyMemberJoinedEvent({
          familyId,
          userId,
        }),
      );

      return { joined: true, family };
    }

    // 4. Pending request logic
    const existingRequest = await this.repo.findRequestByFamilyAndUser(familyId, userId);
    if (existingRequest) {
      throw new BusinessException(
        ERROR_CODES.JOIN_REQUEST_EXISTS,
        'You already have a pending join request for this family.',
        HttpStatus.CONFLICT,
      );
    }

    const request = await this.repo.createRequest({
      familyId,
      userId,
      status: FamilyRequestStatus.PENDING,
    });

    return { joined: false, request };
  }

  async listRequests(
    userId: string,
    familyId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<FamilyJoinRequest>> {
    // Validate authority: Leaders, Co-leaders, or Elders
    const member = await this.repo.findMemberByUserId(userId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (member.role === FamilyRole.MEMBER) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders, Co-Leaders, and Elders can view join requests.',
        HttpStatus.FORBIDDEN,
      );
    }

    const [rows, total] = await this.repo.listRequests(
      familyId,
      FamilyRequestStatus.PENDING,
      q.skip,
      q.limit,
    );
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async handleRequest(
    actorId: string,
    familyId: string,
    requestId: string,
    dto: ManageRequestDto,
  ): Promise<any> {
    const request = await this.repo.findRequestById(requestId);
    if (!request || request.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.JOIN_REQUEST_NOT_FOUND,
        'Join request not found for this family.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (request.status !== FamilyRequestStatus.PENDING) {
      throw new BusinessException(
        ERROR_CODES.CONFLICT,
        'This join request has already been processed.',
        HttpStatus.CONFLICT,
      );
    }

    // Validate authority: Leaders, Co-leaders, or Elders
    const member = await this.repo.findMemberByUserId(actorId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (member.role === FamilyRole.MEMBER) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders, Co-Leaders, and Elders can approve or reject join requests.',
        HttpStatus.FORBIDDEN,
      );
    }

    const family = await this.get(familyId);

    if (dto.status === FamilyRequestStatus.APPROVED) {
      if (family.memberCount >= family.maxMembers) {
        throw new BusinessException(
          ERROR_CODES.FAMILY_LIMIT_REACHED,
          'This family is full and cannot accept new members.',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Check if target user is already in a family
      const targetExistingMember = await this.repo.findMemberByUserId(request.userId);
      if (targetExistingMember) {
        // Automatically reject since they joined another family in the meantime
        await this.repo.rejectRequest(requestId, familyId, request.userId, actorId);
        throw new BusinessException(
          ERROR_CODES.ALREADY_IN_FAMILY,
          'The user has already joined another family.',
          HttpStatus.CONFLICT,
        );
      }

      const newMember = await this.repo.acceptRequest(requestId, familyId, request.userId, actorId);

      await this.bus.publish(
        new FamilyMemberJoinedEvent({
          familyId,
          userId: request.userId,
        }),
      );

      return { approved: true, member: newMember };
    } else {
      await this.repo.rejectRequest(requestId, familyId, request.userId, actorId);
      return { approved: false };
    }
  }

  async leave(userId: string, familyId: string): Promise<void> {
    const member = await this.repo.findMemberByUserId(userId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (member.role === FamilyRole.LEADER) {
      throw new BusinessException(
        ERROR_CODES.LEADER_CANNOT_LEAVE,
        'Leaders cannot leave without transferring leadership or disbanding the family.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.repo.removeMember(familyId, userId, userId);

    await this.bus.publish(
      new FamilyMemberLeftEvent({
        familyId,
        userId,
        kicked: false,
        actorId: userId,
      }),
    );
  }

  async kick(actorId: string, familyId: string, kickUserId: string): Promise<void> {
    if (actorId === kickUserId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_MODERATE_SELF,
        'You cannot kick yourself. Use leave instead.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const actor = await this.repo.findMemberByUserId(actorId);
    if (!actor || actor.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    const target = await this.repo.findMemberByUserId(kickUserId);
    if (!target || target.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'Target user is not a member of this family.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Role Hierarchy Checks:
    // Leader can kick Co-Leader, Elder, Member
    // Co-Leader can kick Elder, Member
    // Elder/Member cannot kick anyone
    const roleWeight = (r: FamilyRole) => {
      if (r === FamilyRole.LEADER) return 4;
      if (r === FamilyRole.CO_LEADER) return 3;
      if (r === FamilyRole.ELDER) return 2;
      return 1;
    };

    if (roleWeight(actor.role) <= roleWeight(target.role)) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'You do not have permission to kick this member.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.repo.removeMember(familyId, kickUserId, actorId);

    await this.bus.publish(
      new FamilyMemberLeftEvent({
        familyId,
        userId: kickUserId,
        kicked: true,
        actorId,
      }),
    );
  }

  async promote(actorId: string, familyId: string, dto: PromoteMemberDto): Promise<FamilyMember> {
    const actor = await this.repo.findMemberByUserId(actorId);
    if (!actor || actor.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    const target = await this.repo.findMemberByUserId(dto.userId);
    if (!target || target.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'Target user is not a member of this family.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (target.role === FamilyRole.LEADER) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'You cannot promote or demote the family Leader. Use leadership transfer.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Role promotions/demotions restrictions:
    // 1. Only Leader can promote to Co-Leader or demote Co-Leader.
    // 2. Leader and Co-Leader can promote to Elder or demote Elder.
    // 3. Actors cannot promote someone to their own level or above.
    if (dto.role === FamilyRole.CO_LEADER && actor.role !== FamilyRole.LEADER) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only the Leader can promote a member to Co-Leader.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (target.role === FamilyRole.CO_LEADER && actor.role !== FamilyRole.LEADER) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only the Leader can demote a Co-Leader.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (actor.role !== FamilyRole.LEADER && actor.role !== FamilyRole.CO_LEADER) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders and Co-Leaders can promote or demote members.',
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.repo.updateMember(target.id, { role: dto.role });

    await this.repo.logAction(familyId, actorId, 'PROMOTE_MEMBER', {
      targetUserId: dto.userId,
      oldRole: target.role,
      newRole: dto.role,
    });

    return updated;
  }

  async transferLeadership(
    actorId: string,
    familyId: string,
    dto: TransferLeadershipDto,
  ): Promise<Family> {
    const family = await this.get(familyId);

    if (family.leaderId !== actorId) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only the family Leader can transfer leadership.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (actorId === dto.userId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_MODERATE_SELF,
        'You cannot transfer leadership to yourself.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const actorMember = await this.repo.findMemberByUserId(actorId);
    const targetMember = await this.repo.findMemberByUserId(dto.userId);

    if (!actorMember || !targetMember || targetMember.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'Target user is not a member of this family.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Process Transfer:
    // Update target member to LEADER, actor member to MEMBER (or CO_LEADER, standard is MEMBER/CO_LEADER, we use CO_LEADER so the founder remains admin, or MEMBER. Let's make actor MEMBER).
    await this.repo.updateMember(targetMember.id, { role: FamilyRole.LEADER });
    await this.repo.updateMember(actorMember.id, { role: FamilyRole.MEMBER });
    const updatedFamily = await this.repo.updateFamily(familyId, { leaderId: dto.userId });

    await this.repo.logAction(familyId, actorId, 'TRANSFER_LEADERSHIP', {
      previousLeaderId: actorId,
      newLeaderId: dto.userId,
    });

    return updatedFamily;
  }

  async disband(actorId: string, familyId: string): Promise<void> {
    const family = await this.get(familyId);

    if (family.leaderId !== actorId) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only the family Leader can disband the family.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.repo.deleteFamily(familyId, actorId);

    await this.bus.publish(
      new FamilyDeletedEvent({
        familyId,
        leaderId: actorId,
      }),
    );
  }

  async list(q: {
    skip: number;
    limit: number;
    page: number;
    search?: string;
  }): Promise<Paginated<Family>> {
    const [rows, total] = await this.repo.listFamilies(q.skip, q.limit, q.search);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async getMembers(
    familyId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<FamilyMember>> {
    await this.get(familyId); // Enforces existence
    const [rows, total] = await this.repo.listMembers(familyId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async getLogs(
    actorId: string,
    familyId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<FamilyLog>> {
    const actor = await this.repo.findMemberByUserId(actorId);
    if (!actor || actor.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    const [rows, total] = await this.repo.listLogs(familyId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  // ---- Internal helper methods ----

  private calculateLevel(exp: bigint): number {
    let level = 1;
    for (const entry of FAMILY_LEVEL_LADDER) {
      if (exp >= entry.minExp) {
        level = Math.max(level, entry.level);
      }
    }
    return level;
  }
}
