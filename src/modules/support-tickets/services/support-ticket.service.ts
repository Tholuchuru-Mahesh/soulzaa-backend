import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupportTicketStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  AssignTicketDto,
  CreateSupportTicketDto,
  EscalateTicketDto,
  ReplyToTicketDto,
  UpdateTicketStatusDto,
} from '../dto/support-ticket.dto';

@Injectable()
export class SupportTicketService {
  private readonly logger = new Logger(SupportTicketService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a new support ticket.
   * Snapshots the submitter's geographic location at creation time so the
   * ticket remains in the correct Official's queue if the user moves later.
   */
  async create(submitterId: string, dto: CreateSupportTicketDto) {
    // Fetch the submitter's location snapshot
    const user = await this.prisma.user.findUnique({
      where: { id: submitterId },
      select: { countryId: true, stateId: true, regionId: true },
    });
    if (!user) throw new BadRequestException('Submitter user not found');

    let countryId = user.countryId;
    let stateId = user.stateId;
    const regionId = user.regionId;

    if (!countryId) {
      const defaultCountry = await this.prisma.country.findFirst({ where: { code: 'IN' } });
      if (defaultCountry) countryId = defaultCountry.id;
    }
    if (!stateId) {
      const defaultState = await this.prisma.state.findFirst({ where: { code: 'KA' } });
      if (defaultState) stateId = defaultState.id;
    }

    const ticket = await this.prisma.supportTicket.create({
      data: {
        submitterId,
        title: dto.title,
        description: dto.description,
        category: dto.category ?? 'OTHER',
        priority: dto.priority ?? 'MEDIUM',
        countryId,
        stateId,
        regionId,
      },
    });

    await this.audit(ticket.id, submitterId, 'CREATED', { category: ticket.category });
    this.logger.log(`Support ticket ${ticket.id} created by user ${submitterId}`);
    return ticket;
  }

  /** Official or submitter posts a reply message to the ticket. */
  async reply(ticketId: string, authorId: string, dto: ReplyToTicketDto, isStaff: boolean) {
    const ticket = await this.requireTicket(ticketId);

    // Only the submitter or staff may reply; enforce ticket is not closed.
    if (!isStaff && ticket.submitterId !== authorId) {
      throw new ForbiddenException('Only the submitter may reply as a user');
    }
    if (ticket.status === 'CLOSED') {
      throw new BadRequestException('Cannot reply to a closed ticket');
    }

    const messageText = dto.message || (dto as any).body || '';
    const [message] = await this.prisma.$transaction([
      this.prisma.supportTicketMessage.create({
        data: { ticketId, authorId, message: messageText, isStaff },
      }),
      // Auto-move to IN_PROGRESS on first staff reply
      ...(isStaff && ticket.status === 'OPEN'
        ? [
            this.prisma.supportTicket.update({
              where: { id: ticketId },
              data: { status: 'IN_PROGRESS' },
            }),
          ]
        : []),
    ]);

    await this.audit(ticketId, authorId, 'REPLIED', { isStaff });
    return message;
  }

  /** Official changes the ticket status. */
  async updateStatus(ticketId: string, actorId: string, dto: UpdateTicketStatusDto) {
    const ticket = await this.requireTicket(ticketId);

    const terminalStates: SupportTicketStatus[] = ['CLOSED', 'RESOLVED'];
    if (terminalStates.includes(ticket.status) && dto.status !== 'CLOSED') {
      throw new BadRequestException(`Ticket is already ${ticket.status}`);
    }

    const extra: Record<string, unknown> = {};
    if (dto.status === 'RESOLVED') extra['resolvedAt'] = new Date();
    if (dto.status === 'CLOSED') extra['closedAt'] = new Date();

    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: dto.status as SupportTicketStatus, ...extra },
    });

    await this.audit(ticketId, actorId, 'STATUS_CHANGED', {
      from: ticket.status,
      to: dto.status,
    });
    return updated;
  }

  /** Official assigns the ticket to themselves or another Official. */
  async assign(ticketId: string, actorId: string, dto: AssignTicketDto) {
    await this.requireTicket(ticketId);

    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        assignedOfficialId: dto.officialId,
        status: 'IN_PROGRESS',
      },
    });

    await this.audit(ticketId, actorId, 'ASSIGNED', { assignedTo: dto.officialId });
    return updated;
  }

  /** Official escalates the ticket to Admin level. */
  async escalate(ticketId: string, actorId: string, dto: EscalateTicketDto) {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.status === 'ESCALATED') {
      throw new BadRequestException('Ticket is already escalated');
    }

    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: 'ESCALATED',
        escalatedAt: new Date(),
      },
    });

    await this.audit(ticketId, actorId, 'ESCALATED', { reason: dto.reason });
    this.logger.warn(`Ticket ${ticketId} escalated by ${actorId}: ${dto.reason ?? '—'}`);
    return updated;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async requireTicket(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException(`Support ticket ${ticketId} not found`);
    return ticket;
  }

  private async audit(
    ticketId: string,
    actorId: string | null,
    action: string,
    details?: Record<string, unknown>,
  ) {
    try {
      await this.prisma.supportTicketAudit.create({
        data: { ticketId, actorId, action, details: (details ?? {}) as object },
      });
    } catch (err) {
      // Audit failures must never block the main flow
      this.logger.error(`Audit write failed for ticket ${ticketId}: ${(err as Error).message}`);
    }
  }
}
