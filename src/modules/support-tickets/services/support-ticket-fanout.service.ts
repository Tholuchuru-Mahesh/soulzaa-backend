import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupportTicket, SupportTicketMessage } from '@prisma/client';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import {
  SUPPORT_EVENTS,
  SUPPORT_NAMESPACE,
  supportTicketRoom,
} from '../constants/support-tickets.constants';

/** Longest message body we put in a push preview before trimming. */
const PREVIEW_MAX = 120;

/**
 * Delivery for support-ticket activity: the live socket fan-out plus the
 * durable in-app + push notification.
 *
 * Split out of `SupportTicketService` so the write path stays a write path —
 * the ticket service persists and audits, this decides who hears about it.
 *
 * Every method here is best-effort and swallows its own failures. A push
 * provider timing out must not roll back a reply that is already committed and
 * audited: the user would see a 500 and retry, double-posting their message.
 * Delivery failures are logged and dropped; the message is still in the ticket.
 */
@Injectable()
export class SupportTicketFanoutService {
  private readonly logger = new Logger(SupportTicketFanoutService.name);

  constructor(
    private readonly sockets: SocketManager,
    // Injected by token: NotificationModule exports NOTIFICATION_SERVICE, not the class.
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
  ) {}

  /**
   * A message was posted. Everyone watching the ticket gets it over the socket;
   * the party who did *not* write it gets a notification.
   */
  async onMessage(ticket: SupportTicket, message: SupportTicketMessage): Promise<void> {
    this.emit(ticket.id, SUPPORT_EVENTS.MESSAGE, {
      ticketId: ticket.id,
      message: {
        id: message.id,
        ticketId: message.ticketId,
        authorId: message.authorId,
        isStaff: message.isStaff,
        message: message.message,
        createdAt: message.createdAt.toISOString(),
      },
    });

    const recipientId = message.isStaff
      ? ticket.submitterId
      : (ticket.escalatedToAdminId ?? ticket.assignedOfficialId);

    // An unassigned, unescalated ticket has no individual to notify. It still
    // reaches staff through the queue listing, so this is a normal outcome.
    if (!recipientId || recipientId === message.authorId) return;

    await this.safely('message notification', async () => {
      await this.notifications.create({
        userId: recipientId,
        type: message.isStaff ? 'SUPPORT_TICKET_REPLY' : 'SUPPORT_TICKET_USER_REPLY',
        actorId: message.authorId,
        entityType: 'SUPPORT_TICKET',
        entityId: ticket.id,
        data: { ticketId: ticket.id, title: ticket.title, preview: this.preview(message.message) },
      });

      await this.notifications.notify(recipientId, {
        category: PUSH_CATEGORIES.SYSTEM,
        title: message.isStaff ? 'Support replied' : `New reply: ${ticket.title}`,
        body: this.preview(message.message),
        // Ticket bodies routinely carry payment disputes and account details,
        // so the lock-screen preview is redacted when previews are off.
        redactedBody: message.isStaff ? 'Support replied to your ticket' : 'New reply on a ticket',
        data: { ticketId: ticket.id, kind: 'support_ticket_message' },
        // One ticket collapses into one on-device thread rather than N pushes.
        threadId: supportTicketRoom(ticket.id),
        collapseKey: supportTicketRoom(ticket.id),
        badge: 'unread',
      });
    });
  }

  /**
   * The ticket's status changed. Broadcast to watchers; notify the submitter
   * only when it reached a terminal state — they do not need a push because
   * their ticket moved from OPEN to IN_PROGRESS.
   */
  async onStatusChange(ticket: SupportTicket, from: string, actorId: string): Promise<void> {
    this.emit(ticket.id, SUPPORT_EVENTS.STATUS, {
      ticketId: ticket.id,
      from,
      status: ticket.status,
      actorId,
    });

    const terminal = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';
    if (!terminal || actorId === ticket.submitterId) return;

    await this.safely('status notification', async () => {
      await this.notifications.create({
        userId: ticket.submitterId,
        type: 'SUPPORT_TICKET_RESOLVED',
        actorId,
        entityType: 'SUPPORT_TICKET',
        entityId: ticket.id,
        data: { ticketId: ticket.id, title: ticket.title, status: ticket.status },
      });

      await this.notifications.notify(ticket.submitterId, {
        category: PUSH_CATEGORIES.SYSTEM,
        title: ticket.status === 'RESOLVED' ? 'Ticket resolved' : 'Ticket closed',
        body: ticket.title,
        data: { ticketId: ticket.id, kind: 'support_ticket_status', status: ticket.status },
        threadId: supportTicketRoom(ticket.id),
        badge: 'unread',
      });
    });
  }

  private emit(ticketId: string, event: string, payload: unknown): void {
    try {
      this.sockets.emitToNamespaceRoom(
        SUPPORT_NAMESPACE,
        supportTicketRoom(ticketId),
        event,
        payload,
      );
    } catch (err) {
      this.logger.warn(`socket emit ${event} failed for ticket ${ticketId}: ${String(err)}`);
    }
  }

  private preview(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
  }

  private async safely(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`${what} failed: ${String(err)}`);
    }
  }
}
