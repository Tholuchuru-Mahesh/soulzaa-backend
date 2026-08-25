import { SupportTicketFanoutService } from './support-ticket-fanout.service';

const SUBMITTER = 'user-1';
const OFFICIAL = 'official-1';
const ADMIN = 'admin-1';

const ticket = (over: Record<string, unknown> = {}) =>
  ({
    id: 'ticket-1',
    submitterId: SUBMITTER,
    title: 'Cannot withdraw coins',
    status: 'IN_PROGRESS',
    assignedOfficialId: OFFICIAL,
    escalatedToAdminId: null,
    ...over,
  }) as never;

const message = (over: Record<string, unknown> = {}) =>
  ({
    id: 'msg-1',
    ticketId: 'ticket-1',
    authorId: OFFICIAL,
    isStaff: true,
    message: 'We are looking into it',
    createdAt: new Date('2026-08-26T10:00:00Z'),
    ...over,
  }) as never;

describe('SupportTicketFanoutService', () => {
  let sockets: { emitToNamespaceRoom: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let svc: SupportTicketFanoutService;

  beforeEach(() => {
    sockets = { emitToNamespaceRoom: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue({}),
      notify: jest.fn().mockResolvedValue(true),
    };
    svc = new SupportTicketFanoutService(sockets as never, notifications as never);
  });

  const recipients = () => notifications.create.mock.calls.map((c) => c[0].userId);

  it('broadcasts every message to the ticket room', async () => {
    await svc.onMessage(ticket(), message());
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/support',
      'ticket_ticket-1',
      'ticket:message',
      expect.objectContaining({ ticketId: 'ticket-1' }),
    );
  });

  it('notifies the submitter when staff replies', async () => {
    await svc.onMessage(ticket(), message({ isStaff: true, authorId: OFFICIAL }));
    expect(recipients()).toEqual([SUBMITTER]);
    expect(notifications.create.mock.calls[0][0].type).toBe('SUPPORT_TICKET_REPLY');
  });

  it('notifies the assigned official when the user replies', async () => {
    await svc.onMessage(ticket(), message({ isStaff: false, authorId: SUBMITTER }));
    expect(recipients()).toEqual([OFFICIAL]);
    expect(notifications.create.mock.calls[0][0].type).toBe('SUPPORT_TICKET_USER_REPLY');
  });

  it('prefers the escalation admin over the assigned official', async () => {
    await svc.onMessage(
      ticket({ escalatedToAdminId: ADMIN }),
      message({ isStaff: false, authorId: SUBMITTER }),
    );
    expect(recipients()).toEqual([ADMIN]);
  });

  it('still broadcasts, but notifies nobody, on an unassigned ticket', async () => {
    await svc.onMessage(
      ticket({ assignedOfficialId: null, escalatedToAdminId: null }),
      message({ isStaff: false, authorId: SUBMITTER }),
    );
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('never notifies the author of their own message', async () => {
    await svc.onMessage(
      ticket({ assignedOfficialId: SUBMITTER }),
      message({ isStaff: false, authorId: SUBMITTER }),
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('notifies the submitter only on a terminal status', async () => {
    await svc.onStatusChange(ticket({ status: 'IN_PROGRESS' }), 'OPEN', OFFICIAL);
    expect(notifications.create).not.toHaveBeenCalled();

    await svc.onStatusChange(ticket({ status: 'RESOLVED' }), 'IN_PROGRESS', OFFICIAL);
    expect(recipients()).toEqual([SUBMITTER]);
    expect(notifications.create.mock.calls[0][0].type).toBe('SUPPORT_TICKET_RESOLVED');
  });

  it('broadcasts status changes even when nobody is notified', async () => {
    await svc.onStatusChange(ticket({ status: 'IN_PROGRESS' }), 'OPEN', OFFICIAL);
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      '/support',
      'ticket_ticket-1',
      'ticket:status',
      expect.objectContaining({ from: 'OPEN', status: 'IN_PROGRESS' }),
    );
  });

  it('does not let a push failure escape into the write path', async () => {
    notifications.notify.mockRejectedValue(new Error('FCM down'));
    await expect(svc.onMessage(ticket(), message())).resolves.toBeUndefined();
  });

  it('does not let a socket failure escape either', async () => {
    sockets.emitToNamespaceRoom.mockImplementation(() => {
      throw new Error('adapter down');
    });
    await expect(svc.onMessage(ticket(), message())).resolves.toBeUndefined();
  });
});
