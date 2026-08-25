/**
 * Realtime contract for support-ticket chat. Shared by the gateway, the join
 * policy and the service that emits — and mirrored by the Flutter app and the
 * admin console, so treat these strings as a published API: renaming one
 * silently stops delivery on any client that has not shipped the same change.
 */

/** Socket.IO namespace the ticket conversation lives on. */
export const SUPPORT_NAMESPACE = '/support';

/**
 * Room for one ticket's conversation. Underscore-separated to match the
 * `family_<id>` convention already used on the `/chat` namespace.
 */
export const supportTicketRoom = (ticketId: string): string => `ticket_${ticketId}`;

/** Server → client events. */
export const SUPPORT_EVENTS = {
  /** A new message was posted on the ticket, by either side. */
  MESSAGE: 'ticket:message',
  /** The ticket's status changed (e.g. IN_PROGRESS, RESOLVED, CLOSED). */
  STATUS: 'ticket:status',
} as const;

/** Permission that marks a socket client as support staff, mirroring the REST routes. */
export const SUPPORT_STAFF_PERMISSION = 'support_ticket.review';
