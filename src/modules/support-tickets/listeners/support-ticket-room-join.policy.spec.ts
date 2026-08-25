import { SupportTicketRoomJoinPolicy } from './support-ticket-room-join.policy';

/**
 * The negative cases are the point: without this policy the `/support`
 * namespace joins unconditionally, so a stranger could read someone else's
 * support conversation over the socket.
 */
describe('SupportTicketRoomJoinPolicy', () => {
  const SUBMITTER = '11111111-1111-4111-8111-111111111111';
  const STRANGER = '22222222-2222-4222-8222-222222222222';
  const STAFF = '33333333-3333-4333-8333-333333333333';
  const TICKET = '44444444-4444-4444-8444-444444444444';
  const room = `ticket_${TICKET}`;

  let prisma: { supportTicket: { findUnique: jest.Mock } };
  let permissions: { checkUserHasPermissions: jest.Mock };
  let policy: SupportTicketRoomJoinPolicy;

  beforeEach(() => {
    prisma = {
      supportTicket: { findUnique: jest.fn().mockResolvedValue({ submitterId: SUBMITTER }) },
    };
    permissions = {
      checkUserHasPermissions: jest
        .fn()
        .mockImplementation((userId: string) => Promise.resolve(userId === STAFF)),
    };
    policy = new SupportTicketRoomJoinPolicy(
      new Map() as never,
      prisma as never,
      permissions as never,
    );
  });

  it('registers itself for the /support namespace on init', () => {
    const registry = new Map();
    new SupportTicketRoomJoinPolicy(
      registry as never,
      prisma as never,
      permissions as never,
    ).onModuleInit();
    expect(registry.get('/support')).toBeDefined();
  });

  it('admits the submitter to their own ticket', async () => {
    await expect(policy.canJoin(SUBMITTER, room)).resolves.toBe('player');
  });

  it('admits staff holding support_ticket.review', async () => {
    await expect(policy.canJoin(STAFF, room)).resolves.toBe('player');
    expect(permissions.checkUserHasPermissions).toHaveBeenCalledWith(STAFF, [
      'support_ticket.review',
    ]);
  });

  it("denies a stranger someone else's ticket", async () => {
    await expect(policy.canJoin(STRANGER, room)).resolves.toBe('deny');
  });

  it('denies a ticket that does not exist, without leaking the difference', async () => {
    prisma.supportTicket.findUnique.mockResolvedValue(null);
    // Same answer as "not yours" — membership is not probeable by enumeration.
    await expect(policy.canJoin(STRANGER, room)).resolves.toBe('deny');
    await expect(policy.canJoin(SUBMITTER, room)).resolves.toBe('deny');
  });

  it('denies malformed room names without hitting the database', async () => {
    for (const bad of ['', 'ticket_', 'ticket_not-a-uuid', TICKET, `family_${TICKET}`]) {
      await expect(policy.canJoin(SUBMITTER, bad)).resolves.toBe('deny');
    }
    expect(prisma.supportTicket.findUnique).not.toHaveBeenCalled();
  });
});
