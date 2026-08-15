import { SupportTicketQueryService } from './support-ticket-query.service';

/**
 * The submitter's own ticket read.
 *
 * This exists because the staff route (`findById`) returns any ticket to
 * anyone holding `support_ticket.review`. An agency has no such permission, so
 * without this it could raise a ticket and then never open it.
 */
describe('SupportTicketQueryService.findOwnById', () => {
  const TICKET = 'ticket-1';
  const SUBMITTER = 'agency-1';

  function build() {
    const prisma: any = {
      supportTicket: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new SupportTicketQueryService(prisma, {} as never);
    return { service, prisma };
  }

  it('puts the submitter in the query rather than checking after the read', async () => {
    const { service, prisma } = build();

    await service.findOwnById(TICKET, SUBMITTER);

    // Filtering afterwards would still have loaded another user's ticket into
    // memory; making it part of the where clause means it is never fetched.
    expect(prisma.supportTicket.findFirst).toHaveBeenCalledWith({
      where: { id: TICKET, submitterId: SUBMITTER },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  });

  it('returns nothing for a ticket raised by somebody else', async () => {
    const { service, prisma } = build();
    prisma.supportTicket.findFirst.mockResolvedValue(null);

    await expect(service.findOwnById(TICKET, 'another-agency')).resolves.toBeNull();
  });

  it('does not expose the internal audit trail to the submitter', async () => {
    const { service, prisma } = build();
    prisma.supportTicket.findFirst.mockResolvedValue({ id: TICKET, messages: [] });

    await service.findOwnById(TICKET, SUBMITTER);

    // `audits` records staff handling — assignment, escalation, internal notes
    // — and is included by the staff read only.
    const include = prisma.supportTicket.findFirst.mock.calls[0][0].include;
    expect(include.audits).toBeUndefined();
    expect(include.messages).toBeDefined();
  });
});
