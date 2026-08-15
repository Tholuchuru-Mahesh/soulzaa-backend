import { AgencyActivationService } from './agency-activation.service';

/**
 * The activation fee gates the Coin Seller module.
 *
 * The properties that matter: paying grants the role through the path that
 * clears the permission cache, an unpaid agency is never treated as activated,
 * a replayed webhook cannot grant twice, and a short payment unlocks nothing.
 */
describe('AgencyActivationService', () => {
  const AGENCY = 'agency-1';
  const ACTIVATION = 'act-1';

  function build(row: Record<string, unknown> | null = null, hasRole = false) {
    const prisma: any = {
      agencyActivation: {
        findUnique: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockImplementation((a: any) => ({ id: ACTIVATION, ...a.data })),
        update: jest.fn().mockImplementation((a: any) => ({ id: ACTIVATION, ...a.data })),
      },
      role: { findUnique: jest.fn().mockResolvedValue({ id: 'role-cs' }) },
    };
    const roles = { assignRoleToUser: jest.fn().mockResolvedValue({}) };
    const roleResolver = { hasRole: jest.fn().mockResolvedValue(hasRole) };
    const config = {
      get: jest.fn().mockReturnValue({ razorpayKeyId: 'k', razorpayKeySecret: 's' }),
    };
    const service = new AgencyActivationService(
      prisma,
      config as never,
      roles as never,
      roleResolver as never,
    );
    return { service, prisma, roles, roleResolver };
  }

  describe('getStatus', () => {
    it('reports an unpaid agency as not activated, with the fee to pay', async () => {
      const { service } = build(null, false);

      const res = await service.getStatus(AGENCY);

      expect(res.activated).toBe(false);
      expect(res.status).toBe('PENDING');
      // ₹500.00 by default, held and charged in paise.
      expect(res.amountMinor).toBe(50000);
      expect(res.amount).toBe(500);
    });

    it('treats an agency already holding COIN_SELLER as activated', async () => {
      // Granted by an admin rather than paid for. Showing that agency a bill
      // would charge for something it already has.
      const { service } = build(null, true);

      const res = await service.getStatus(AGENCY);

      expect(res.activated).toBe(true);
    });

    it('offers the open payment link back rather than a second page', async () => {
      const { service } = build({
        id: ACTIVATION,
        status: 'PENDING',
        amountMinor: 50000,
        currency: 'INR',
        paymentLinkUrl: 'https://rzp.io/i/abc',
        paidAt: null,
      });

      const res = await service.getStatus(AGENCY);

      expect(res.paymentUrl).toBe('https://rzp.io/i/abc');
    });

    it('stops offering a payment link once activated', async () => {
      const { service } = build({
        id: ACTIVATION,
        status: 'ACTIVATED',
        amountMinor: 50000,
        currency: 'INR',
        paymentLinkUrl: 'https://rzp.io/i/abc',
        paidAt: new Date(),
      });

      const res = await service.getStatus(AGENCY);

      expect(res.activated).toBe(true);
      expect(res.paymentUrl).toBeNull();
    });
  });

  describe('activate', () => {
    it('grants COIN_SELLER through RoleService, which clears the cached permissions', async () => {
      const { service, roles } = build({
        id: ACTIVATION,
        agencyId: AGENCY,
        status: 'PENDING',
        amountMinor: 50000,
      });

      await service.activate(ACTIVATION, 'pay_1', 50000);

      // Writing user_roles directly would leave the agency holding the role in
      // Postgres and still being refused by the Redis-cached permission set.
      expect(roles.assignRoleToUser).toHaveBeenCalledWith({
        userId: AGENCY,
        roleId: 'role-cs',
      });
    });

    it('does not grant twice for a replayed webhook', async () => {
      const { service, roles, prisma } = build({
        id: ACTIVATION,
        agencyId: AGENCY,
        status: 'ACTIVATED',
        amountMinor: 50000,
      });

      await service.activate(ACTIVATION, 'pay_1', 50000);

      expect(roles.assignRoleToUser).not.toHaveBeenCalled();
      expect(prisma.agencyActivation.update).not.toHaveBeenCalled();
    });

    it('unlocks nothing when the payment is short of the fee', async () => {
      const { service, roles, prisma } = build({
        id: ACTIVATION,
        agencyId: AGENCY,
        status: 'PENDING',
        amountMinor: 50000,
      });

      await expect(service.activate(ACTIVATION, 'pay_1', 100)).rejects.toThrow(/does not cover/i);
      expect(roles.assignRoleToUser).not.toHaveBeenCalled();
      expect(prisma.agencyActivation.update).not.toHaveBeenCalled();
    });

    it('refuses to activate when the COIN_SELLER role is missing', async () => {
      const { service, prisma } = build({
        id: ACTIVATION,
        agencyId: AGENCY,
        status: 'PENDING',
        amountMinor: 50000,
      });
      prisma.role.findUnique.mockResolvedValue(null);

      // Loud rather than silent: the agency has paid and would otherwise be
      // marked activated while holding nothing.
      await expect(service.activate(ACTIVATION, 'pay_1', 50000)).rejects.toThrow(/not configured/i);
    });
  });

  describe('createPaymentLink', () => {
    it('refuses to bill an agency that is already a coin seller', async () => {
      const { service } = build(null, true);

      await expect(service.createPaymentLink(AGENCY, 'key-1')).rejects.toThrow(/already active/i);
    });

    it('returns the open link instead of opening a second payable page', async () => {
      const { service } = build({
        id: ACTIVATION,
        status: 'PENDING',
        amountMinor: 50000,
        currency: 'INR',
        paymentLinkUrl: 'https://rzp.io/i/abc',
      });

      const res = await service.createPaymentLink(AGENCY, 'key-2');

      expect(res.paymentUrl).toBe('https://rzp.io/i/abc');
    });
  });

  describe('resolveActivationId', () => {
    it('matches on payment notes', () => {
      const { service } = build();
      const id = service.resolveActivationId({
        payload: { payment: { entity: { notes: { agencyActivationId: ACTIVATION } } } },
      });
      expect(id).toBe(ACTIVATION);
    });

    it('falls back to the payment link reference', () => {
      const { service } = build();
      const id = service.resolveActivationId({
        payload: { payment_link: { entity: { reference_id: ACTIVATION } } },
      });
      expect(id).toBe(ACTIVATION);
    });

    it('returns null for an unrelated event', () => {
      const { service } = build();
      expect(service.resolveActivationId({ payload: {} })).toBeNull();
    });
  });
});
