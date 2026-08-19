import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventValidationService } from './event-validation.service';

export interface DraftWriteInput {
  name: string;
  description?: string;
  banner?: string;
  thumbnail?: string;
  startTime: Date;
  endTime: Date;
  regStartTime: Date;
  regEndTime: Date;
  maxParticipants?: number;
  participationRules?: Record<string, unknown>;
  eligibilityRules?: Record<string, unknown>;
  rewardDefinition?: Record<string, unknown>;
}

/**
 * The agency half of the event lifecycle: author a draft, edit it, submit it
 * for Official/Admin approval. Nothing here can make an event live.
 *
 * It persists directly rather than delegating to EventService.createEvent,
 * which hardcodes `status: 'SCHEDULED'` — and since EventValidationService
 * treats SCHEDULED as "accepting registrations", delegating would publish the
 * event as a side effect of creating it, defeating the whole approval flow.
 */
@Injectable()
export class EventDraftService {
  private readonly logger = new Logger(EventDraftService.name);

  /**
   * The engine category agency-authored events are filed under. The
   * admin-facing label the agency picked lives in participationRules, so the
   * EventStatistics taxonomy stays as it was.
   */
  private static readonly CATEGORY = 'AGENCY_CAMPAIGN';

  /** Statuses an agency may still edit. */
  private static readonly EDITABLE = new Set(['DRAFT', 'REJECTED']);

  /**
   * The complete set of transitions this service can perform. There is
   * deliberately no edge to SCHEDULED, APPROVED or ACTIVE.
   */
  private static readonly SUBMIT_FROM = new Set(['DRAFT', 'REJECTED']);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: EventValidationService,
    private readonly audit: EventAuditService,
  ) {}

  async createDraft(input: DraftWriteInput, actorId: string) {
    this.validation.validateCategory(EventDraftService.CATEGORY);
    this.validation.validateTimeWindows(
      input.startTime,
      input.endTime,
      input.regStartTime,
      input.regEndTime,
    );

    const def = await this.prisma.eventDefinition.create({
      data: {
        code: this.generateCode(input.name),
        name: input.name,
        description: input.description,
        category: EventDraftService.CATEGORY,
        banner: input.banner,
        thumbnail: input.thumbnail,
        startTime: input.startTime,
        endTime: input.endTime,
        regStartTime: input.regStartTime,
        regEndTime: input.regEndTime,
        participationRules: (input.participationRules ?? {}) as never,
        eligibilityRules: (input.eligibilityRules ?? {}) as never,
        rewardDefinition: (input.rewardDefinition ?? {}) as never,
        maxParticipants: input.maxParticipants ?? 1000,
        visibility: 'PUBLIC',
        status: 'DRAFT',
        createdBy: actorId,
        agencyId: actorId,
      },
    });

    await this.audit.logAudit('EVENT_CREATED', def.id, actorId, { code: def.code });
    return def;
  }

  async updateDraft(id: string, input: Partial<DraftWriteInput>, actorId: string) {
    const existing = await this.requireOwned(id, actorId);

    if (!EventDraftService.EDITABLE.has(existing.status)) {
      throw new BadRequestException(
        `This event can no longer be edited (status: ${existing.status}).`,
      );
    }

    if (input.startTime && input.endTime) {
      this.validation.validateTimeWindows(
        input.startTime,
        input.endTime,
        input.regStartTime,
        input.regEndTime,
      );
    }

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        banner: input.banner,
        thumbnail: input.thumbnail,
        startTime: input.startTime,
        endTime: input.endTime,
        regStartTime: input.regStartTime,
        regEndTime: input.regEndTime,
        maxParticipants: input.maxParticipants,
        ...(input.participationRules
          ? { participationRules: input.participationRules as never }
          : {}),
        ...(input.eligibilityRules ? { eligibilityRules: input.eligibilityRules as never } : {}),
        ...(input.rewardDefinition ? { rewardDefinition: input.rewardDefinition as never } : {}),
      },
    });

    await this.audit.logAudit('EVENT_DRAFT_UPDATED', id, actorId, {});
    return updated;
  }

  async submitForApproval(id: string, actorId: string) {
    const existing = await this.requireOwned(id, actorId);

    if (!EventDraftService.SUBMIT_FROM.has(existing.status)) {
      throw new BadRequestException(
        existing.status === 'PENDING_APPROVAL'
          ? 'This event has already been submitted for approval.'
          : `An event with status ${existing.status} cannot be submitted for approval.`,
      );
    }

    this.assertSubmittable(existing);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status: 'PENDING_APPROVAL' },
    });

    await this.audit.logAudit('EVENT_SUBMITTED_FOR_APPROVAL', id, actorId, {
      from: existing.status,
    });
    this.logger.log(`Event ${id} submitted for approval by ${actorId}`);
    return updated;
  }

  listMine(actorId: string) {
    return this.prisma.eventDefinition.findMany({
      where: { agencyId: actorId },
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  getMine(id: string, actorId: string) {
    return this.requireOwned(id, actorId);
  }

  async deleteDraft(id: string, actorId: string): Promise<void> {
    const existing = await this.requireOwned(id, actorId);
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException('Only a draft can be deleted.');
    }
    await this.prisma.eventDefinition.delete({ where: { id } });
    await this.audit.logAudit('EVENT_CANCELLED', id, actorId, { reason: 'Draft deleted' });
  }

  /** Loads the event and proves the caller owns it. */
  private async requireOwned(id: string, actorId: string) {
    const def = await this.prisma.eventDefinition.findUnique({ where: { id } });
    if (!def) throw new NotFoundException(`Event ${id} not found`);
    // agencyId is the scope; createdBy is retained for attribution.
    if (def.agencyId !== actorId) {
      throw new ForbiddenException('This event belongs to another agency.');
    }
    return def;
  }

  /**
   * Server-side completeness check. The client validates too, but a client is
   * not an authority — a hand-rolled request must not reach a reviewer with
   * half the event missing.
   */
  private assertSubmittable(def: {
    name: string;
    description: string | null;
    banner: string | null;
    regStartTime: Date | null;
    regEndTime: Date | null;
    participationRules: unknown;
    rewardDefinition: unknown;
  }): void {
    const missing: string[] = [];
    if (!def.name?.trim()) missing.push('event name');
    if (!def.description?.trim()) missing.push('event description');
    if (!def.banner) missing.push('event banner');
    if (!def.regStartTime || !def.regEndTime) missing.push('registration period');

    const rules = (def.participationRules ?? {}) as Record<string, unknown>;
    if (!Array.isArray(rules.pointRules) || rules.pointRules.length === 0) {
      missing.push('at least one point rule');
    }

    const rewards = (def.rewardDefinition ?? {}) as Record<string, unknown>;
    if (!Array.isArray(rewards.tiers) || rewards.tiers.length === 0) {
      missing.push('at least one reward tier');
    }

    if (missing.length > 0) {
      throw new BadRequestException(`Cannot submit yet — still missing: ${missing.join(', ')}.`);
    }
  }

  /**
   * `super-star-singing-battle-a1b2c3`. The code column is unique; the random
   * suffix keeps two events of the same name from colliding.
   */
  private generateCode(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const suffix = randomBytes(4).toString('hex').slice(0, 6);
    return `${slug || 'agency-event'}-${suffix}`;
  }
}
