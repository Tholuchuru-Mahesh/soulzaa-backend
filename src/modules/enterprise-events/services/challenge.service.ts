import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { EventAuditService } from './event-audit.service';
import { CreateChallengeDto, UpdateChallengeDto } from '../dto/challenge.dto';

@Injectable()
export class ChallengeService {
  private readonly logger = new Logger(ChallengeService.name);
  private static readonly CATEGORY = 'AGENCY_CHALLENGE';

  constructor(
    private readonly prisma: PrismaService,
    private readonly sockets: SocketManager,
    private readonly audit: EventAuditService,
  ) {}

  async createDraft(dto: CreateChallengeDto, userId: string) {
    const code = this.generateCode(dto.name || 'agency-challenge');
    const now = new Date();
    const startTime = dto.startTime ? new Date(dto.startTime) : now;
    const endTime = dto.endTime
      ? new Date(dto.endTime)
      : new Date(now.getTime() + (dto.targetValue ?? 10) * 86400000);

    const participationRules = {
      shortDescription: dto.shortDescription,
      challengeType: dto.challengeType,
      targetValue: dto.targetValue,
      targetUnit: dto.targetUnit,
      isMultiTask: dto.isMultiTask,
      allTasksRequired: dto.allTasksRequired,
      tasks: dto.tasks ?? [],
      isRecurring: dto.isRecurring,
      recurrenceConfig: dto.recurrenceConfig ?? {},
      rules: dto.rules ?? [],
      antiCheat: dto.antiCheat ?? {},
    };

    const row = await this.prisma.eventDefinition.create({
      data: {
        code,
        name: dto.name,
        description: dto.description || dto.shortDescription || '',
        category: ChallengeService.CATEGORY,
        banner: dto.coverImage,
        thumbnail: dto.coverImage,
        startTime,
        endTime,
        regStartTime: dto.regStartTime ? new Date(dto.regStartTime) : now,
        regEndTime: dto.regEndTime ? new Date(dto.regEndTime) : endTime,
        maxParticipants: dto.maxParticipants ?? 10000,
        status: 'DRAFT',
        createdBy: userId,
        agencyId: userId,
        participationRules: participationRules as any,
        eligibilityRules: (dto.eligibilityRules ?? {}) as any,
        rewardDefinition: (dto.rewardDefinition ?? {}) as any,
      },
    });

    await this.audit.logAudit('EVENT_CREATED', row.id, userId, { name: row.name });
    return this.mapToChallengeWire(row);
  }

  async updateDraft(id: string, dto: UpdateChallengeDto, userId: string) {
    const def = await this.requireOwned(id, userId);
    if (def.status !== 'DRAFT' && def.status !== 'REJECTED') {
      throw new BadRequestException(`Cannot edit challenge in status ${def.status}`);
    }

    const currentRules = (def.participationRules as Record<string, any>) || {};
    const participationRules = {
      ...currentRules,
      shortDescription: dto.shortDescription ?? currentRules.shortDescription,
      challengeType: dto.challengeType ?? currentRules.challengeType,
      targetValue: dto.targetValue ?? currentRules.targetValue,
      targetUnit: dto.targetUnit ?? currentRules.targetUnit,
      isMultiTask: dto.isMultiTask ?? currentRules.isMultiTask,
      allTasksRequired: dto.allTasksRequired ?? currentRules.allTasksRequired,
      tasks: dto.tasks ?? currentRules.tasks ?? [],
      isRecurring: dto.isRecurring ?? currentRules.isRecurring,
      recurrenceConfig: dto.recurrenceConfig ?? currentRules.recurrenceConfig ?? {},
      rules: dto.rules ?? currentRules.rules ?? [],
      antiCheat: dto.antiCheat ?? currentRules.antiCheat ?? {},
    };

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: {
        name: dto.name ?? def.name,
        description: dto.description ?? dto.shortDescription ?? def.description,
        banner: dto.coverImage ?? def.banner,
        thumbnail: dto.coverImage ?? def.thumbnail,
        startTime: dto.startTime ? new Date(dto.startTime) : def.startTime,
        endTime: dto.endTime ? new Date(dto.endTime) : def.endTime,
        regStartTime: dto.regStartTime ? new Date(dto.regStartTime) : def.regStartTime,
        regEndTime: dto.regEndTime ? new Date(dto.regEndTime) : def.regEndTime,
        maxParticipants: dto.maxParticipants ?? def.maxParticipants,
        participationRules: participationRules as any,
        eligibilityRules: (dto.eligibilityRules ?? def.eligibilityRules ?? {}) as any,
        rewardDefinition: (dto.rewardDefinition ?? def.rewardDefinition ?? {}) as any,
      },
    });

    await this.audit.logAudit('EVENT_DRAFT_UPDATED', id, userId, { name: updated.name });
    return this.mapToChallengeWire(updated);
  }

  async submitForApproval(id: string, userId: string) {
    const def = await this.requireOwned(id, userId);
    if (def.status !== 'DRAFT' && def.status !== 'REJECTED') {
      throw new BadRequestException(`Cannot submit challenge in status ${def.status}`);
    }

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status: 'PENDING_APPROVAL' },
    });

    await this.audit.logAudit('EVENT_SUBMITTED_FOR_APPROVAL', id, userId, { name: updated.name });

    // Broadcast realtime event over socket to /notifications
    try {
      this.sockets.emitToNamespace('/notifications', 'challenge:submitted', {
        challengeId: id,
        name: updated.name,
        agencyId: userId,
        status: 'PENDING_APPROVAL',
        submittedAt: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn(`Failed to broadcast socket event for challenge ${id}: ${e}`);
    }

    return this.mapToChallengeWire(updated);
  }

  async listMine(userId: string) {
    const rows = await this.prisma.eventDefinition.findMany({
      where: {
        category: ChallengeService.CATEGORY,
        agencyId: userId,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapToChallengeWire(r));
  }

  async getMine(id: string, userId: string) {
    const row = await this.requireOwned(id, userId);
    return this.mapToChallengeWire(row);
  }

  async deleteDraft(id: string, userId: string) {
    const def = await this.requireOwned(id, userId);
    if (def.status !== 'DRAFT') {
      throw new BadRequestException('Only drafts can be deleted.');
    }
    await this.prisma.eventDefinition.delete({ where: { id } });
    await this.audit.logAudit('EVENT_CANCELLED', id, userId, {});
  }

  // ─── Admin Review ─────────────────────────────────────────────────────────

  async listAllForAdmin(status?: string) {
    const where: Record<string, any> = {
      category: ChallengeService.CATEGORY,
    };
    if (status) {
      where.status = status;
    }

    const rows = await this.prisma.eventDefinition.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const userIds = [
      ...new Set(rows.map((r) => r.agencyId || r.createdBy).filter(Boolean)),
    ] as string[];
    const users =
      userIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const userMap = new Map(users.map((u) => [u.id, u.fullName || u.username || u.id]));

    return rows.map((r) => {
      const wire = this.mapToChallengeWire(r);
      const submitterId = r.agencyId || r.createdBy;
      return {
        ...wire,
        submittedBy: submitterId ? userMap.get(submitterId) || submitterId : 'Platform Agency',
        agencyName: submitterId ? userMap.get(submitterId) || submitterId : 'Platform Agency',
      };
    });
  }

  async approveChallenge(id: string, actorId: string) {
    const def = await this.prisma.eventDefinition.findUnique({ where: { id } });
    if (!def) throw new NotFoundException(`Challenge ${id} not found`);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status: 'APPROVED' },
    });

    await this.audit.logAudit('EVENT_STATUS_CHANGED', id, actorId, {
      status: 'APPROVED',
      name: updated.name,
    });

    // Realtime notification over sockets
    try {
      this.sockets.emitToNamespace('/notifications', 'challenge:approved', {
        challengeId: id,
        name: updated.name,
        status: 'APPROVED',
        approvedAt: new Date().toISOString(),
      });
      if (updated.agencyId) {
        this.sockets.emitToUserEverywhere(updated.agencyId, 'challenge:approved', {
          challengeId: id,
          name: updated.name,
          status: 'APPROVED',
        });
      }
    } catch (e) {
      this.logger.warn(`Failed to broadcast socket event: ${e}`);
    }

    return this.mapToChallengeWire(updated);
  }

  async rejectChallenge(id: string, reason: string, actorId: string) {
    const def = await this.prisma.eventDefinition.findUnique({ where: { id } });
    if (!def) throw new NotFoundException(`Challenge ${id} not found`);

    const currentRules = (def.participationRules as Record<string, any>) || {};
    const participationRules = {
      ...currentRules,
      rejectionReason: reason,
    };

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: {
        status: 'REJECTED',
        participationRules: participationRules as any,
      },
    });

    await this.audit.logAudit('EVENT_STATUS_CHANGED', id, actorId, {
      status: 'REJECTED',
      reason,
      name: updated.name,
    });

    // Realtime notification over sockets
    try {
      this.sockets.emitToNamespace('/notifications', 'challenge:rejected', {
        challengeId: id,
        name: updated.name,
        status: 'REJECTED',
        reason,
        rejectedAt: new Date().toISOString(),
      });
      if (updated.agencyId) {
        this.sockets.emitToUserEverywhere(updated.agencyId, 'challenge:rejected', {
          challengeId: id,
          name: updated.name,
          status: 'REJECTED',
          reason,
        });
      }
    } catch (e) {
      this.logger.warn(`Failed to broadcast socket event: ${e}`);
    }

    return this.mapToChallengeWire(updated);
  }

  private async requireOwned(id: string, actorId: string) {
    const def = await this.prisma.eventDefinition.findUnique({ where: { id } });
    if (!def) throw new NotFoundException(`Challenge ${id} not found`);
    if (def.agencyId !== actorId && def.createdBy !== actorId) {
      throw new ForbiddenException('This challenge belongs to another agency.');
    }
    return def;
  }

  private mapToChallengeWire(def: any) {
    const rules = (def.participationRules as Record<string, any>) || {};
    const elig = (def.eligibilityRules as Record<string, any>) || {};
    const reward = (def.rewardDefinition as Record<string, any>) || {};

    return {
      id: def.id,
      code: def.code,
      name: def.name,
      title: def.name,
      shortDescription: rules.shortDescription || def.description || '',
      description: def.description || '',
      category: rules.category || 'Daily',
      coverImage: def.banner || def.thumbnail,
      banner: def.banner,
      thumbnail: def.thumbnail,
      challengeType: rules.challengeType || 'Login Streak',
      targetValue: rules.targetValue ?? 10,
      targetUnit: rules.targetUnit || 'Days',
      isMultiTask: Boolean(rules.isMultiTask),
      allTasksRequired: rules.allTasksRequired ?? true,
      tasks: rules.tasks ?? [],
      startTime: def.startTime?.toISOString?.() ?? def.startTime,
      endTime: def.endTime?.toISOString?.() ?? def.endTime,
      regStartTime: def.regStartTime?.toISOString?.() ?? def.regStartTime,
      regEndTime: def.regEndTime?.toISOString?.() ?? def.regEndTime,
      isRecurring: Boolean(rules.isRecurring),
      recurrenceConfig: rules.recurrenceConfig ?? {},
      eligibilityRules: elig,
      maxParticipants: def.maxParticipants,
      minParticipants: rules.minParticipants ?? 0,
      rewardDefinition: reward,
      rewardType: reward.type || 'Coins',
      rewardValue: reward.value || 500,
      coins: String(reward.value || 500),
      rules: rules.rules ?? [],
      antiCheat: rules.antiCheat ?? {},
      status: def.status,
      rejectionReason: rules.rejectionReason,
      createdAt: def.createdAt?.toISOString?.() ?? def.createdAt,
      updatedAt: def.updatedAt?.toISOString?.() ?? def.updatedAt,
      agencyId: def.agencyId,
      totalDays: rules.targetValue ?? 10,
      elapsedDays: 0,
      participants: '0',
    };
  }

  private generateCode(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const suffix = randomBytes(4).toString('hex').slice(0, 6);
    return `${slug || 'challenge'}-${suffix}`;
  }
}
