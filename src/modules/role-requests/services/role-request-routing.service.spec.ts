import { BadRequestException } from '@nestjs/common';
import { RoleRequestStage } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { RoleRequestRoutingService } from './role-request-routing.service';

/**
 * Approval routing runs entirely on the normalised hierarchy. Getting it wrong
 * lets an Official approve another region's applicant — the exact failure the
 * geographic scope work exists to prevent.
 */
describe('RoleRequestRoutingService', () => {
  let service: RoleRequestRoutingService;

  const prisma = { user: { findUnique: jest.fn() } };
  const scopes = { getUserScopes: jest.fn() };
  const roles = { getRoleNames: jest.fn() };

  const KARNATAKA = { regionId: 'r-blr', stateId: 's-ka', countryId: 'c-in' };

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRoleNames.mockResolvedValue(['OFFICIAL']);
    scopes.getUserScopes.mockResolvedValue([]);
    service = new RoleRequestRoutingService(
      prisma as unknown as PrismaService,
      scopes as unknown as GeographicScopeResolver,
      roles as unknown as RoleResolver,
    );
  });

  describe('resolveGeography', () => {
    it('takes the full hierarchy from the subject', async () => {
      prisma.user.findUnique.mockResolvedValue(KARNATAKA);

      await expect(service.resolveGeography('u-1')).resolves.toEqual(KARNATAKA);
    });

    it('refuses a subject with no region rather than filing an unroutable request', async () => {
      prisma.user.findUnique.mockResolvedValue({ regionId: null, stateId: null, countryId: null });

      await expect(service.resolveGeography('u-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('canActAtStage', () => {
    it('lets the region Official act on a request in their region', async () => {
      scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: 'r-blr' }]);

      await expect(
        service.canActAtStage('official-1', RoleRequestStage.OFFICIAL, KARNATAKA),
      ).resolves.toBe(true);
    });

    it('stops an Official from another region acting on it', async () => {
      scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: 'r-other' }]);

      await expect(
        service.canActAtStage('official-2', RoleRequestStage.OFFICIAL, KARNATAKA),
      ).resolves.toBe(false);
    });

    it('stops the right role acting at the wrong stage', async () => {
      scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: 'r-blr' }]);

      // An Official holds the region but MANAGER is a Country Manager's stage.
      await expect(
        service.canActAtStage('official-1', RoleRequestStage.MANAGER, KARNATAKA),
      ).resolves.toBe(false);
    });

    it('lets the Country Manager act at the MANAGER stage for their country', async () => {
      roles.getRoleNames.mockResolvedValue(['COUNTRY_MANAGER']);
      scopes.getUserScopes.mockResolvedValue([{ scopeType: 'COUNTRY', countryId: 'c-in' }]);

      await expect(
        service.canActAtStage('cm-1', RoleRequestStage.MANAGER, KARNATAKA),
      ).resolves.toBe(true);
    });

    it('lets platform staff act at any stage in any territory', async () => {
      roles.getRoleNames.mockResolvedValue(['ADMIN']);

      await expect(
        service.canActAtStage('admin-1', RoleRequestStage.ADMIN, KARNATAKA),
      ).resolves.toBe(true);
    });

    it('denies a reviewer holding the role but no scope at all', async () => {
      scopes.getUserScopes.mockResolvedValue([]);

      await expect(
        service.canActAtStage('official-3', RoleRequestStage.OFFICIAL, KARNATAKA),
      ).resolves.toBe(false);
    });
  });

  describe('queueFilter', () => {
    it('narrows the queue to the reviewer’s region', async () => {
      scopes.getUserScopes.mockResolvedValue([{ scopeType: 'REGION', regionId: 'r-blr' }]);

      await expect(service.queueFilter('official-1')).resolves.toEqual({
        OR: [{ regionId: 'r-blr' }],
      });
    });

    it('gives platform staff an unrestricted queue', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);

      await expect(service.queueFilter('sa-1')).resolves.toEqual({});
    });

    it('gives an unscoped reviewer an empty queue, not everyone’s', async () => {
      scopes.getUserScopes.mockResolvedValue([]);

      await expect(service.queueFilter('official-9')).resolves.toEqual({ OR: [] });
    });
  });
});
