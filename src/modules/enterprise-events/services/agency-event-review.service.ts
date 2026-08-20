import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { EventAuditService } from './event-audit.service';

/**
 * The admin half of the agency event lifecycle: read the queue an agency
 * submitted into, then approve or reject.
 *
 * Agency events and agency challenges share the event_definitions table and are
 * told apart only by category, so every read here is category-scoped — a
 * challenge must never surface in the event queue, or an admin approves one
 * workflow from the other's screen.
 */
@Injectable()
export class AgencyEventReviewService {
  private readonly logger = new Logger(AgencyEventReviewService.name);

  /** The category EventDraftService files agency-authored events under. */
  private static readonly CATEGORY = 'AGENCY_CAMPAIGN';

  /** The only status a decision may be taken from. */
  private static readonly AWAITING_REVIEW = 'PENDING_APPROVAL';

  constructor(
    private readonly prisma: PrismaService,
    private readonly sockets: SocketManager,
    private readonly audit: EventAuditService,
  ) {}

  async listForAdmin(status?: string) {
    const rows = await this.prisma.eventDefinition.findMany({
      where: status
        ? { category: AgencyEventReviewService.CATEGORY, status }
        : { category: AgencyEventReviewService.CATEGORY },
      orderBy: { createdAt: 'desc' },
    });

    const submitterIds = [
      ...new Set(rows.map((r) => r.agencyId ?? r.createdBy).filter(Boolean)),
    ] as string[];

    const submitters =
      submitterIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: submitterIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const nameById = new Map(submitters.map((u) => [u.id, u.fullName || u.username || u.id]));

    return rows.map((row) => {
      const submitterId = row.agencyId ?? row.createdBy;
      const agencyName = submitterId ? (nameById.get(submitterId) ?? submitterId) : 'Unknown';
      return { ...row, submittedBy: agencyName, agencyName };
    });
  }

  /**
   * Approval publishes: SCHEDULED is the status EventLifecycleScheduler picks up
   * to open registration and start the event on the agency's own dates. Leaving
   * it at APPROVED would tell the agency yes while the event never ran.
   */
  async approve(id: string, actorId: string) {
    await this.requirePendingEvent(id);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status: 'SCHEDULED' },
    });

    await this.audit.logAudit('EVENT_STATUS_CHANGED', id, actorId, {
      status: 'SCHEDULED',
      name: updated.name,
    });
    this.broadcast('event:approved', updated.agencyId, {
      eventId: id,
      name: updated.name,
      status: 'SCHEDULED',
      approvedAt: new Date().toISOString(),
    });

    return updated;
  }

  /**
   * The reason rides in participationRules because EventDefinition has no column
   * for it. Merged rather than replaced — the point rules live in the same blob,
   * and EventDraftService lets the agency edit and resubmit from REJECTED.
   */
  async reject(id: string, reason: string, actorId: string) {
    const existing = await this.requirePendingEvent(id);

    const rules = (existing.participationRules ?? {}) as Record<string, unknown>;

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: {
        status: 'REJECTED',
        participationRules: { ...rules, rejectionReason: reason } as never,
      },
    });

    await this.audit.logAudit('EVENT_STATUS_CHANGED', id, actorId, {
      status: 'REJECTED',
      reason,
      name: updated.name,
    });
    this.broadcast('event:rejected', updated.agencyId, {
      eventId: id,
      name: updated.name,
      status: 'REJECTED',
      reason,
      rejectedAt: new Date().toISOString(),
    });

    return updated;
  }

  /** Loads the event, proving it is an agency event and still awaiting a decision. */
  private async requirePendingEvent(id: string) {
    const def = await this.prisma.eventDefinition.findUnique({ where: { id } });
    if (!def || def.category !== AgencyEventReviewService.CATEGORY) {
      throw new NotFoundException(`Agency event ${id} not found`);
    }
    if (def.status !== AgencyEventReviewService.AWAITING_REVIEW) {
      throw new BadRequestException(`This event is not awaiting review (status: ${def.status}).`);
    }
    return def;
  }

  /** A dropped notification must never cost the decision itself. */
  private broadcast(event: string, agencyId: string | null, payload: Record<string, unknown>) {
    try {
      this.sockets.emitToNamespace('/notifications', event, payload);
      if (agencyId) {
        this.sockets.emitToUserEverywhere(agencyId, event, payload);
      }
    } catch (e) {
      this.logger.warn(`Failed to broadcast ${event}: ${e}`);
    }
  }
}
