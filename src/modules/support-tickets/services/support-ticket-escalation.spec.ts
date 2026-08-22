import { DEFAULT_ROLE_PERMISSIONS } from 'src/modules/authorization/constants/rbac-permissions.constants';
import { SupportTicketQueryService } from './support-ticket-query.service';

/**
 * A user raises a ticket, an Official handles it in their territory, and when
 * the Official escalates it the case belongs to the Admin portal. That handover
 * only works if an Admin can actually reach the ticket queue, so the invariants
 * are: the permission the queue is guarded by is held by both roles, and an
 * unrestricted caller is not narrowed to a territory they do not have.
 */
describe('support ticket escalation reaches the Admin portal', () => {
  describe('permissions', () => {
    it('lets an Admin review tickets — escalation hands the case to them', () => {
      expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain('support_ticket.review');
    });

    it('still lets an Official review tickets in their territory', () => {
      expect(DEFAULT_ROLE_PERMISSIONS.OFFICIAL).toContain('support_ticket.review');
    });
  });

  describe('SupportTicketQueryService.listForOfficial', () => {
    const prisma = {
      supportTicket: { count: jest.fn(), findMany: jest.fn() },
      user: { findMany: jest.fn() },
    };
    const scope = { userScopeFilter: jest.fn() };
    let service: SupportTicketQueryService;

    beforeEach(() => {
      jest.clearAllMocks();
      service = new SupportTicketQueryService(prisma as never, scope as never);
      prisma.supportTicket.count.mockResolvedValue(0);
      prisma.supportTicket.findMany.mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);
    });

    const list = (status?: string) =>
      service.listForOfficial('actor-1', { limit: 25, offset: 0, status: status as never });

    it('does not narrow an Admin to a territory', async () => {
      // `{}` is what WorkforceScopeService returns for SUPER_ADMIN/ADMIN.
      scope.userScopeFilter.mockResolvedValue({});

      await list();

      expect(prisma.supportTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('lets the Admin portal ask for just the escalated queue', async () => {
      scope.userScopeFilter.mockResolvedValue({});

      await list('ESCALATED');

      expect(prisma.supportTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'ESCALATED' } }),
      );
    });

    it('still confines an Official to their own territory', async () => {
      scope.userScopeFilter.mockResolvedValue({ OR: [{ stateId: 's-ka' }] });

      await list('ESCALATED');

      expect(prisma.supportTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ stateId: 's-ka' }], status: 'ESCALATED' },
        }),
      );
    });
  });
});
