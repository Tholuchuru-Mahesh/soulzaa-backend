import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  Family,
  FamilyJoinRequest,
  FamilyMember,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  CreateFamilyDto,
  ManageRequestDto,
  PromoteMemberDto,
  SendFamilyMessageDto,
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
import { FamilyConfigurationService } from './family-configuration.service';

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
    private readonly configService: FamilyConfigurationService,
    private readonly prisma: PrismaService,
    @Optional() private readonly sockets?: SocketManager,
    @Optional() @Inject(WALLET_SERVICE) private readonly walletService?: IWalletService,
  ) {}

  private emitSystemMessage(familyId: string, content: string): void {
    try {
      if (!this.sockets) return;
      const message = {
        id: `sys_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        familyId,
        senderId: 'system',
        senderName: 'System',
        senderRole: 'MEMBER',
        content,
        avatarUrl: null,
        timestamp: new Date().toISOString(),
        isSystem: true,
      };
      this.sockets.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:message', {
        familyId,
        message,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }
  }

  // ---- IFamiliesService (cross-module interface) ----

  async getMemberFamilyId(userId: string): Promise<string | null> {
    const member = await this.repo.findMemberByUserId(userId);
    return member ? member.familyId : null;
  }

  getOfficerIds(familyId: string): Promise<string[]> {
    return this.repo.listOfficerIds(familyId);
  }

  getMemberIds(familyId: string): Promise<string[]> {
    return this.repo.listMemberIds(familyId);
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
      this.emitSystemMessage(familyId, `🎉 Family leveled up to Level ${newLevel}!`);
    }

    try {
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:updated', {
        familyId,
        exp: Number(newExp),
        level: newLevel,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }
  }

  async incrementMemberContribution(userId: string, points: number): Promise<void> {
    if (points <= 0) return;
    const member = await this.repo.findMemberByUserId(userId);
    if (!member) return;

    const updated = await this.repo.updateMember(member.id, {
      expContribution: {
        increment: points,
      },
      coinContribution: {
        increment: points,
      },
    });

    try {
      this.sockets?.emitToNamespaceRoom(
        '/chat',
        `family_${member.familyId}`,
        'family:member_contribution',
        {
          familyId: member.familyId,
          userId,
          contributionPoints: Number(updated.coinContribution ?? updated.expContribution ?? 0),
          pointsAdded: points,
        },
      );
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }
  }

  private serializeFamily(f: any): any {
    if (!f) return f;
    return {
      ...f,
      logoKey: f.logo ?? f.logoKey ?? null,
      logo: f.logo ?? f.logoKey ?? null,
      leaderId: f.founderId ?? f.leaderId,
      autoAccept: f.privacy === 'PUBLIC' || f.autoAccept === true,
    };
  }

  private calculateLevel(exp: bigint): number {
    let level = 1;
    for (const step of FAMILY_LEVEL_LADDER) {
      if (exp >= step.minExp) {
        level = step.level;
      } else {
        break;
      }
    }
    return level;
  }

  // ---- Standard Domain Logic ----

  async getConfig() {
    return this.configService.getFamilyConfig();
  }

  async create(creatorId: string, dto: CreateFamilyDto): Promise<Family> {
    const existingMember = await this.repo.findMemberByUserId(creatorId);
    if (existingMember) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_IN_FAMILY,
        'You are already a member of another family.',
        HttpStatus.CONFLICT,
      );
    }

    const existingFamily = await this.repo.findByName(dto.name);
    if (existingFamily) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_NAME_EXISTS,
        'Family name is already taken.',
        HttpStatus.CONFLICT,
      );
    }

    const config = await this.configService.getFamilyConfig();

    // Check creation cost if coin economy is enforced
    if (config.creationCost > 0 && this.walletService) {
      try {
        await this.walletService.debit({
          userId: creatorId,
          currency: WalletCurrency.GOLD,
          amount: Number(config.creationCost),
          reason: WalletTxnReason.COSMETIC_PURCHASE,
          idempotencyKey: `family:create:${creatorId}:${Date.now()}`,
          referenceType: 'FAMILY_CREATION',
          metadata: { description: `Creation of Family "${dto.name}"` },
        });
      } catch {
        throw new BusinessException(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          `Insufficient coins to create a family. Required: ${config.creationCost} coins.`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const family = await this.repo.createFamily(
      {
        name: dto.name,
        tag: dto.name.slice(0, 4).toUpperCase(),
        description: dto.description,
        logo: dto.logoKey,
        founderId: creatorId,
        memberCount: 1,
        maxMembers: config.maxMembers || 100,
        privacy: dto.autoAccept === true ? 'PUBLIC' : 'PRIVATE',
      },
      {
        userId: creatorId,
        role: 'FOUNDER',
      },
    );

    await this.bus.publish(
      new FamilyCreatedEvent({
        familyId: family.id,
        name: family.name,
        leaderId: creatorId,
      }),
    );

    return this.serializeFamily(family);
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
    return this.serializeFamily(family);
  }

  async update(userId: string, familyId: string, dto: UpdateFamilyDto): Promise<Family> {
    const family = await this.get(familyId);

    const member = await this.repo.findMemberByUserId(userId);
    const isFounder = family.founderId === userId || (family as any).leaderId === userId;
    const roleUpper = member?.role?.toUpperCase() || '';
    const isAllowedRole = [
      'FOUNDER',
      'CO_FOUNDER',
      'LEADER',
      'CO_LEADER',
      'OWNER',
      'ADMIN',
      'ELDER',
    ].includes(roleUpper);

    if (!isFounder && (!member || member.familyId !== familyId)) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!isFounder && !isAllowedRole) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders and Co-Leaders can edit family details.',
        HttpStatus.FORBIDDEN,
      );
    }

    const updateData: any = {};
    if (dto.name !== undefined && dto.name !== family.name) {
      const config = await this.configService.getFamilyConfig();
      if (config.renameCost > 0 && this.walletService) {
        try {
          await this.walletService.debit({
            userId,
            currency: WalletCurrency.GOLD,
            amount: Number(config.renameCost),
            reason: WalletTxnReason.COSMETIC_PURCHASE,
            idempotencyKey: `family:rename:${familyId}:${Date.now()}`,
            referenceType: 'FAMILY_RENAME',
            metadata: { description: `Rename Family to "${dto.name}"` },
          });
        } catch {
          throw new BusinessException(
            ERROR_CODES.INSUFFICIENT_BALANCE,
            `Insufficient coins to rename family. Required: ${config.renameCost} coins.`,
            HttpStatus.BAD_REQUEST,
          );
        }
      }
      updateData.name = dto.name;
    }
    if (dto.description !== undefined) updateData.description = dto.description;
    const logoVal = dto.logoKey ?? dto.logo;
    if (logoVal !== undefined) updateData.logo = logoVal;
    if (dto.autoAccept !== undefined) updateData.privacy = dto.autoAccept ? 'PUBLIC' : 'PRIVATE';

    const updated = await this.repo.updateFamily(familyId, updateData);
    await this.repo.logAction(familyId, userId, 'EDIT_PROFILE', dto as any);

    const serialized = this.serializeFamily(updated);

    try {
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:updated', {
        familyId,
        family: serialized,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }

    return serialized;
  }

  async join(userId: string, familyId: string): Promise<any> {
    const existingMember = await this.repo.findMemberByUserId(userId);
    if (existingMember) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_IN_FAMILY,
        'You are already a member of a family.',
        HttpStatus.CONFLICT,
      );
    }

    const config = await this.configService.getFamilyConfig();

    // Check join cooldown if user previously left or was removed from any family
    if (config.joinCooldownSeconds > 0) {
      const recentLeave = await this.prisma.familyHistory.findFirst({
        where: {
          userId,
          action: { in: ['LEAVE', 'KICK', 'MEMBER_LEFT', 'MEMBER_KICKED'] },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentLeave) {
        const elapsedSeconds = Math.floor((Date.now() - recentLeave.createdAt.getTime()) / 1000);
        if (elapsedSeconds < config.joinCooldownSeconds) {
          const remainingSeconds = config.joinCooldownSeconds - elapsedSeconds;
          const remainingMinutes = Math.ceil(remainingSeconds / 60);
          throw new BusinessException(
            ERROR_CODES.JOIN_COOLDOWN_ACTIVE,
            `Join cooldown active. Please wait ${remainingMinutes} minute(s) before joining another family.`,
            HttpStatus.FORBIDDEN,
          );
        }
      }
    }

    const family = await this.get(familyId);
    const isAutoAccept =
      family.privacy === 'PUBLIC' ||
      (family as any).autoAccept === true ||
      config.autoApprove === true;
    const defaultRole = config.defaultRole || 'MEMBER';

    if (isAutoAccept) {
      if (family.memberCount >= family.maxMembers) {
        throw new BusinessException(
          ERROR_CODES.FAMILY_LIMIT_REACHED,
          'This family has reached its maximum member limit.',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Prevent kicked/banned users from auto-joining even on PUBLIC families
      const ban = await this.repo.findBan(familyId, userId);
      if (ban) {
        throw new BusinessException(
          ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
          'You are not allowed to join this family.',
          HttpStatus.FORBIDDEN,
        );
      }

      await this.repo.addMember(familyId, userId, defaultRole);
      await this.repo.logAction(familyId, userId, 'JOIN');

      const user = await this.repo.getUserSummary(userId);
      this.emitSystemMessage(familyId, `${user.fullName || user.username} joined the family`);

      await this.bus.publish(
        new FamilyMemberJoinedEvent({
          familyId,
          userId,
        }),
      );

      return { joined: true, family };
    }

    const existingRequest = await this.repo.findRequestByFamilyAndUser(familyId, userId);
    if (existingRequest) {
      throw new BusinessException(
        ERROR_CODES.JOIN_REQUEST_EXISTS,
        'You already have a pending join request for this family.',
        HttpStatus.CONFLICT,
      );
    }

    // Block banned/kicked users from submitting a new request
    const ban = await this.repo.findBan(familyId, userId);
    if (ban) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'You are not allowed to join this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    const request = await this.repo.createRequest({
      familyId,
      userId,
      status: 'PENDING',
    });

    return { joined: false, request };
  }

  async listRequests(
    userId: string,
    familyId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<FamilyJoinRequest>> {
    const member = await this.repo.findMemberByUserId(userId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (member.role === 'MEMBER') {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders, Co-Leaders, and Elders can view join requests.',
        HttpStatus.FORBIDDEN,
      );
    }

    const pageNum = Number(q.page) || 1;
    const limitNum = Number(q.limit) || 20;
    const skipNum = typeof q.skip === 'number' ? q.skip : (pageNum - 1) * limitNum;
    const [rows, total] = await this.repo.listRequests(familyId, 'PENDING', skipNum, limitNum);
    return buildPaginated(rows, total, pageNum, limitNum);
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

    if (request.status !== 'PENDING') {
      throw new BusinessException(
        ERROR_CODES.CONFLICT,
        'This join request has already been processed.',
        HttpStatus.CONFLICT,
      );
    }

    const member = await this.repo.findMemberByUserId(actorId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (member.role === 'MEMBER') {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders, Co-Leaders, and Elders can approve or reject join requests.',
        HttpStatus.FORBIDDEN,
      );
    }

    const family = await this.get(familyId);

    if (dto.status === 'APPROVED') {
      if (family.memberCount >= family.maxMembers) {
        throw new BusinessException(
          ERROR_CODES.FAMILY_LIMIT_REACHED,
          'This family is full and cannot accept new members.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const targetExistingMember = await this.repo.findMemberByUserId(request.userId);
      if (targetExistingMember) {
        await this.repo.rejectRequest(requestId, familyId, request.userId, actorId);
        throw new BusinessException(
          ERROR_CODES.ALREADY_IN_FAMILY,
          'The user has already joined another family.',
          HttpStatus.CONFLICT,
        );
      }

      // Safety: do not approve a request from a currently-banned user
      const ban = await this.repo.findBan(familyId, request.userId);
      if (ban) {
        await this.repo.rejectRequest(requestId, familyId, request.userId, actorId);
        throw new BusinessException(
          ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
          'This user is banned from the family and cannot be approved.',
          HttpStatus.FORBIDDEN,
        );
      }

      const config = await this.configService.getFamilyConfig();
      const newMember = await this.repo.acceptRequest(
        requestId,
        familyId,
        request.userId,
        actorId,
        config.defaultRole || 'MEMBER',
      );

      const target = await this.repo.getUserSummary(request.userId);
      const actor = await this.repo.getUserSummary(actorId);
      this.emitSystemMessage(
        familyId,
        `${target.fullName || target.username} joined the family (approved by ${actor.fullName || actor.username})`,
      );

      try {
        const count = await this.repo.countMembers(familyId);
        this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:member_joined', {
          familyId,
          userId: request.userId,
        });
        this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:updated', {
          familyId,
          memberCount: count,
        });
      } catch {
        // Best-effort broadcast: a dropped socket event must not fail the write.
      }

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

    if (member.role === 'FOUNDER') {
      throw new BusinessException(
        ERROR_CODES.LEADER_CANNOT_LEAVE,
        'Leaders cannot leave without transferring leadership or disbanding the family.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.repo.removeMember(familyId, userId, userId);

    const user = await this.repo.getUserSummary(userId);
    this.emitSystemMessage(familyId, `${user.fullName || user.username} left the family`);

    try {
      const count = await this.repo.countMembers(familyId);
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:member_left', {
        familyId,
        userId,
        kicked: false,
      });
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:updated', {
        familyId,
        memberCount: count,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }

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

    const roleWeight = (r: string) => {
      if (r === 'FOUNDER') return 4;
      if (r === 'CO_FOUNDER') return 3;
      if (r === 'ELDER') return 2;
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

    // Create a ban record so the kicked user cannot immediately re-join
    // (applies to both PUBLIC auto-join and PRIVATE request paths).
    await this.repo.createBan(familyId, kickUserId, actorId, 'Removed by moderator');

    const targetUser = await this.repo.getUserSummary(kickUserId);
    const actorUser = await this.repo.getUserSummary(actorId);
    this.emitSystemMessage(
      familyId,
      `${targetUser.fullName || targetUser.username} was removed from the family by ${actorUser.fullName || actorUser.username}`,
    );

    try {
      const count = await this.repo.countMembers(familyId);
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:member_left', {
        familyId,
        userId: kickUserId,
        kicked: true,
        actorId,
      });
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:updated', {
        familyId,
        memberCount: count,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }

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
    // Existence guard — `get` throws when the family is missing.
    await this.get(familyId);
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

    const actorRole = actor.role.toUpperCase();
    const isActorLeader = ['FOUNDER', 'LEADER'].includes(actorRole);
    const isActorCoLeader = ['CO_FOUNDER', 'CO_LEADER'].includes(actorRole);

    let targetRole = dto.role.toUpperCase();
    if (targetRole === 'CO_LEADER') targetRole = 'CO_FOUNDER';
    if (targetRole === 'LEADER') targetRole = 'FOUNDER';

    const currentTargetRole = target.role.toUpperCase();
    if (['FOUNDER', 'LEADER'].includes(currentTargetRole)) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'You cannot promote or demote the family Leader. Use leadership transfer.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (['CO_FOUNDER', 'CO_LEADER'].includes(targetRole) && !isActorLeader) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only the Leader can promote a member to Co-Leader.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (['CO_FOUNDER', 'CO_LEADER'].includes(currentTargetRole) && !isActorLeader) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only the Leader can demote a Co-Leader.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!isActorLeader && !isActorCoLeader) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only Leaders and Co-Leaders can promote or demote members.',
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.repo.updateMember(target.id, { role: targetRole });

    await this.repo.logAction(familyId, actorId, 'PROMOTE_MEMBER', {
      targetUserId: dto.userId,
      oldRole: target.role,
      newRole: targetRole,
    });

    const targetUser = await this.repo.getUserSummary(dto.userId);
    const actorUser = await this.repo.getUserSummary(actorId);
    const roleName = targetRole.replace(/_/g, ' ');
    this.emitSystemMessage(
      familyId,
      `${targetUser.fullName || targetUser.username} was promoted to ${roleName} by ${actorUser.fullName || actorUser.username}`,
    );

    try {
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:member_updated', {
        familyId,
        userId: dto.userId,
        role: targetRole,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }

    return updated;
  }

  async transferLeadership(
    actorId: string,
    familyId: string,
    dto: TransferLeadershipDto,
  ): Promise<Family> {
    // Existence guard — `get` throws when the family is missing.
    await this.get(familyId);
    const actorMember = await this.repo.findMemberByUserId(actorId);

    const isLeader =
      actorMember != null &&
      ['FOUNDER', 'LEADER'].includes(actorMember.role.toUpperCase()) &&
      actorMember.familyId === familyId;

    if (!isLeader) {
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

    const targetMember = await this.repo.findMemberByUserId(dto.userId);

    if (!actorMember || !targetMember || targetMember.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_FOUND,
        'Target user is not a member of this family.',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.repo.updateMember(targetMember.id, { role: 'FOUNDER' });
    await this.repo.updateMember(actorMember.id, { role: 'CO_FOUNDER' });
    const updatedFamily = await this.repo.updateFamily(familyId, { founderId: dto.userId });

    await this.repo.logAction(familyId, actorId, 'TRANSFER_LEADERSHIP', {
      previousLeaderId: actorId,
      newLeaderId: dto.userId,
    });

    const targetUser = await this.repo.getUserSummary(dto.userId);
    const actorUser = await this.repo.getUserSummary(actorId);
    this.emitSystemMessage(
      familyId,
      `${actorUser.fullName || actorUser.username} transferred family leadership to ${targetUser.fullName || targetUser.username}`,
    );

    try {
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:updated', {
        familyId,
        leaderId: dto.userId,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }

    return this.serializeFamily(updatedFamily);
  }

  async disband(actorId: string, familyId: string): Promise<void> {
    const family = await this.get(familyId);

    if (family.founderId !== actorId) {
      throw new BusinessException(
        ERROR_CODES.FAMILY_ROLE_FORBIDDEN,
        'Only the family Leader can disband the family.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.repo.deleteFamily(familyId, actorId);

    try {
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:disbanded', {
        familyId,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }

    await this.bus.publish(
      new FamilyDeletedEvent({
        familyId,
        leaderId: actorId,
      }),
    );
  }

  async listFamilies(page = 1, limit = 20, search?: string): Promise<Paginated<Family>> {
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;
    const skip = (pageNum - 1) * limitNum;
    const [rows, total] = await this.repo.listFamilies(skip, limitNum, search);
    return buildPaginated(
      rows.map((r) => this.serializeFamily(r)),
      total,
      pageNum,
      limitNum,
    );
  }

  async listMembers(familyId: string, page = 1, limit = 20): Promise<Paginated<FamilyMember>> {
    await this.get(familyId);
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;
    const skip = (pageNum - 1) * limitNum;
    const [rows, total] = await this.repo.listMembers(familyId, skip, limitNum);
    return buildPaginated(rows, total, pageNum, limitNum);
  }

  async listLogs(userId: string, familyId: string, page = 1, limit = 20): Promise<Paginated<any>> {
    const member = await this.repo.findMemberByUserId(userId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;
    const skip = (pageNum - 1) * limitNum;
    const [rows, total] = await this.repo.listLogs(familyId, skip, limitNum);
    return buildPaginated(rows, total, pageNum, limitNum);
  }

  async getMyFamily(userId: string): Promise<any> {
    const member = await this.repo.findMemberByUserId(userId);
    if (!member) return null;
    const family = await this.get(member.familyId);
    return {
      family,
      role: member.role,
      member,
    };
  }

  async listMessages(
    userId: string,
    familyId: string,
    page = 1,
    limit = 50,
  ): Promise<Paginated<any>> {
    const member = await this.repo.findMemberByUserId(userId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 50;
    const skip = (pageNum - 1) * limitNum;
    const [rows, total] = await this.repo.listMessages(familyId, skip, limitNum);
    return buildPaginated(rows, total, pageNum, limitNum);
  }

  async sendMessage(userId: string, familyId: string, dto: SendFamilyMessageDto): Promise<any> {
    const member = await this.repo.findMemberByUserId(userId);
    if (!member || member.familyId !== familyId) {
      throw new BusinessException(
        ERROR_CODES.NOT_IN_FAMILY,
        'You are not a member of this family.',
        HttpStatus.FORBIDDEN,
      );
    }

    const userSummary = await this.repo.getUserSummary(userId);
    const senderName = userSummary.fullName || userSummary.username || 'Member';
    const avatarUrl = userSummary.avatarKey || null;
    const content = dto.content || '';

    const record = await this.repo.createMessage(
      familyId,
      userId,
      content,
      senderName,
      member.role,
      avatarUrl,
      dto.mediaType,
      dto.mediaUrl,
      dto.mediaName,
      dto.mediaSize,
    );

    const message = {
      id: record.id,
      familyId,
      senderId: userId,
      senderName,
      senderRole: member.role,
      content,
      mediaType: dto.mediaType || null,
      mediaUrl: dto.mediaUrl || null,
      mediaName: dto.mediaName || null,
      mediaSize: dto.mediaSize || null,
      avatarUrl,
      timestamp: record.createdAt,
      isSystem: false,
    };

    try {
      this.sockets?.emitToNamespaceRoom('/chat', `family_${familyId}`, 'family:message', {
        familyId,
        message,
      });
    } catch {
      // Best-effort broadcast: a dropped socket event must not fail the write.
    }

    return message;
  }
}
