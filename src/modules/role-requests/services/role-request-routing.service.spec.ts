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

  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    country: { findFirst: jest.fn().mockResolvedValue(null) },
    state: {
      findUnique: jest.fn().mockResolvedValue({ countryId: 'c-in' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    region: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
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
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });

      await expect(service.resolveGeography('u-1')).rejects.toThrow(BadRequestException);
    });

    // Once the form's fields are selectors, this is the path every application
    // takes: an explicit id, no name matching, correct with any number of
    // countries, states or regions.
    it('uses an explicit regionId from the form, without matching any names', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.region.findUnique.mockResolvedValue({
        id: 'r-blr',
        stateId: 's-ka',
        state: { countryId: 'c-in' },
      });

      await expect(service.resolveGeography('u-1', { regionId: 'r-blr' })).resolves.toEqual(
        KARNATAKA,
      );

      // No fuzzy matching happened at all.
      expect(prisma.country.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { regionId: 'r-blr', stateId: 's-ka', countryId: 'c-in' },
      });
    });

    it('ignores a regionId that names nothing rather than trusting the client', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.region.findUnique.mockResolvedValue(null);
      prisma.region.findMany.mockResolvedValue([]);

      await expect(service.resolveGeography('u-1', { regionId: 'made-up' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('resolves from an explicit stateId when the state has one region', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.region.findMany.mockResolvedValue([{ id: 'r-blr', stateId: 's-ka' }]);

      await expect(service.resolveGeography('u-1', { stateId: 's-ka' })).resolves.toEqual(
        KARNATAKA,
      );
    });

    // The multi-state case that matters today: two states under one country,
    // and the applicant's own answer is what separates them.
    it('does not fall back to the country when the named state has several regions', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.region.findMany.mockResolvedValue([
        { id: 'r-blr', stateId: 's-ka' },
        { id: 'r-mys', stateId: 's-ka' },
      ]);

      await expect(service.resolveGeography('u-1', { stateId: 's-ka' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // The application form asks for country and state, so those answers are
    // the best source available — better than anything inferred.
    it('resolves the region from the application form the applicant filled in', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-in' });
      prisma.state.findFirst.mockResolvedValue({ id: 's-ka' });
      prisma.region.findMany.mockResolvedValue([{ id: 'r-blr', stateId: 's-ka' }]);

      await expect(
        service.resolveGeography('u-1', {
          country: 'India',
          state: 'Karnataka',
          city: 'Bangalore',
        }),
      ).resolves.toEqual(KARNATAKA);

      // Narrowed by the state the applicant gave, not just the country.
      expect(prisma.region.findMany).toHaveBeenCalledWith({
        where: { stateId: 's-ka' },
        select: { id: true, stateId: true },
        take: 2,
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { regionId: 'r-blr', stateId: 's-ka', countryId: 'c-in' },
      });
    });

    it('ignores a form state that names nothing and falls back to the country', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-in' });
      prisma.state.findFirst.mockResolvedValue(null);
      prisma.region.findMany.mockResolvedValue([{ id: 'r-blr', stateId: 's-ka' }]);

      await expect(
        service.resolveGeography('u-1', { country: 'India', state: 'Atlantis' }),
      ).resolves.toEqual(KARNATAKA);
    });

    // Registration only ever captures a free-text country, so an ordinary
    // account arrives here with no region. Without deriving one, nobody could
    // apply to become an agency at all.
    it('derives the region from the country when there is only one', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: 'India',
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-in' });
      prisma.region.findMany.mockResolvedValue([{ id: 'r-blr', stateId: 's-ka' }]);

      await expect(service.resolveGeography('u-1')).resolves.toEqual(KARNATAKA);
      // Written back, so later flows do not have to derive it again.
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { regionId: 'r-blr', stateId: 's-ka', countryId: 'c-in' },
      });
    });

    it('matches the country case-insensitively on code or name', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: 'in',
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-in' });
      prisma.region.findMany.mockResolvedValue([{ id: 'r-blr', stateId: 's-ka' }]);

      await service.resolveGeography('u-1');

      const where = prisma.country.findFirst.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { code: { equals: 'in', mode: 'insensitive' } },
        { name: { equals: 'in', mode: 'insensitive' } },
      ]);
    });

    it('refuses to guess when the country has several regions', async () => {
      // Filing it in the wrong territory would hand the request to an Official
      // who does not cover that user — worse than asking for the location.
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: 'c-in',
        country: 'India',
      });
      prisma.region.findMany.mockResolvedValue([
        { id: 'r-blr', stateId: 's-ka' },
        { id: 'r-mum', stateId: 's-mh' },
      ]);

      await expect(service.resolveGeography('u-1')).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // The real shape of a new signup: registration requires no country at all,
    // so the account arrives with every location column empty.
    it('still resolves a user who has no country, when the platform has one region', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.region.findMany.mockResolvedValue([{ id: 'r-blr', stateId: 's-ka' }]);

      await expect(service.resolveGeography('u-1')).resolves.toEqual(KARNATAKA);
      // No country filter — there was no country to filter on.
      expect(prisma.region.findMany.mock.calls[0][0].where).toEqual({});
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { regionId: 'r-blr', stateId: 's-ka', countryId: 'c-in' },
      });
    });

    it('refuses a user with no country when the platform has several regions', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: null,
      });
      prisma.region.findMany.mockResolvedValue([
        { id: 'r-blr', stateId: 's-ka' },
        { id: 'r-mum', stateId: 's-mh' },
      ]);

      await expect(service.resolveGeography('u-1')).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('does not derive anything when an unknown country name has several regions behind it', async () => {
      prisma.user.findUnique.mockResolvedValue({
        regionId: null,
        stateId: null,
        countryId: null,
        country: 'Atlantis',
      });
      prisma.country.findFirst.mockResolvedValue(null);
      prisma.region.findMany.mockResolvedValue([
        { id: 'r-blr', stateId: 's-ka' },
        { id: 'r-mum', stateId: 's-mh' },
      ]);

      await expect(service.resolveGeography('u-1')).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('prefers the region already on the account over deriving one', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...KARNATAKA, country: 'India' });

      await expect(service.resolveGeography('u-1')).resolves.toEqual(KARNATAKA);
      expect(prisma.region.findMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
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
