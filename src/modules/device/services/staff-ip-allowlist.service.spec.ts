import { StaffIpAllowlistService, isIpInCidr } from './staff-ip-allowlist.service';

describe('StaffIpAllowlistService & isIpInCidr', () => {
  describe('isIpInCidr', () => {
    it('matches exact IPv4', () => {
      expect(isIpInCidr('192.168.1.1', '192.168.1.1')).toBe(true);
      expect(isIpInCidr('192.168.1.2', '192.168.1.1')).toBe(false);
    });

    it('matches IPv4 CIDR ranges (/24, /16, /32)', () => {
      expect(isIpInCidr('10.0.0.50', '10.0.0.0/24')).toBe(true);
      expect(isIpInCidr('10.0.1.50', '10.0.0.0/24')).toBe(false);
      expect(isIpInCidr('172.16.5.10', '172.16.0.0/16')).toBe(true);
      expect(isIpInCidr('172.17.5.10', '172.16.0.0/16')).toBe(false);
    });

    it('handles IPv4-mapped IPv6 notation', () => {
      expect(isIpInCidr('::ffff:192.168.1.5', '192.168.1.0/24')).toBe(true);
      expect(isIpInCidr('192.168.1.5', '::ffff:192.168.1.0/24')).toBe(true);
    });

    it('handles localhost aliases', () => {
      expect(isIpInCidr('127.0.0.1', '127.0.0.1/32')).toBe(true);
      expect(isIpInCidr('::1', '127.0.0.1')).toBe(true);
      expect(isIpInCidr('127.0.0.1', '::1')).toBe(true);
    });
  });

  describe('isIpAllowed', () => {
    let service: StaffIpAllowlistService;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        staffAllowedIp: {
          findMany: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          findUnique: jest.fn(),
        },
        auditLog: {
          create: jest.fn(),
        },
      };
      service = new StaffIpAllowlistService(mockPrisma);
    });

    it('auto-registers initial IP and returns true when no allowed IPs configured for user', async () => {
      mockPrisma.staffAllowedIp.findMany.mockResolvedValue([]);
      mockPrisma.staffAllowedIp.create.mockResolvedValue({ id: 'ip-auto' });
      const allowed = await service.isIpAllowed('user-1', '192.168.1.100');
      expect(allowed).toBe(true);
      expect(mockPrisma.staffAllowedIp.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            cidr: '192.168.1.100/32',
            label: 'Initial IP (auto-registered on first login)',
          }),
        }),
      );
    });

    it('returns true when request IP matches an active CIDR', async () => {
      mockPrisma.staffAllowedIp.findMany.mockResolvedValue([
        { id: 'ip-1', userId: 'user-1', cidr: '192.168.1.0/24', isActive: true },
      ]);
      const allowed = await service.isIpAllowed('user-1', '192.168.1.55');
      expect(allowed).toBe(true);
    });

    it('returns false when request IP is outside active CIDRs', async () => {
      mockPrisma.staffAllowedIp.findMany.mockResolvedValue([
        { id: 'ip-1', userId: 'user-1', cidr: '10.0.0.0/8', isActive: true },
      ]);
      const allowed = await service.isIpAllowed('user-1', '192.168.1.55');
      expect(allowed).toBe(false);
    });
  });
});
