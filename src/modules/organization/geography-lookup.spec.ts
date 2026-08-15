import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/common/constants';
import { DEFAULT_ROLE_PERMISSIONS } from 'src/modules/authorization/constants/rbac-permissions.constants';
import { GeographyLookupController } from './controllers/geography-lookup.controller';
import { CountryService } from './services/country.service';
import { OrganizationHierarchyService } from './services/organization-hierarchy.service';
import { RegionService } from './services/region.service';
import { StateService } from './services/state.service';

const reflector = new Reflector();

describe('geography lookup contract', () => {
  // The three selectors are open to any signed-in user on purpose: an agency
  // applicant has to pick their country and state on the application form, and
  // holds no organization permission. A list of place names discloses nothing.
  it('leaves the selectors ungated so an applicant can read them', () => {
    expect(reflector.get<string[]>(PERMISSIONS_KEY, GeographyLookupController)).toBeUndefined();

    for (const handler of ['listCountries', 'listStates', 'listRegions'] as const) {
      expect(
        reflector.get<string[]>(PERMISSIONS_KEY, GeographyLookupController.prototype[handler]),
      ).toBeUndefined();
    }
  });

  // The whole hierarchy at once is an operational view rather than a selector,
  // so it keeps the permission the class used to carry.
  it('still gates the full tree on hierarchy view, which ADMIN holds', () => {
    expect(
      reflector.get<string[]>(PERMISSIONS_KEY, GeographyLookupController.prototype.tree),
    ).toEqual(['organization.hierarchy.view']);
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain('organization.hierarchy.view');
  });

  it('exposes the four lookups the dashboards bind to', () => {
    const handlers = Object.getOwnPropertyNames(GeographyLookupController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(new Set(handlers)).toEqual(
      new Set(['listCountries', 'listStates', 'listRegions', 'tree']),
    );
  });
});

describe('geography lookup responses', () => {
  const row = (id: string, code: string, name: string) => ({
    id,
    code,
    name,
    isActive: true,
    description: 'internal field the selector should not receive',
  });

  const countries = { getAllCountries: jest.fn() };
  const states = { getAllStates: jest.fn() };
  const regions = { getAllRegions: jest.fn() };
  const hierarchy = { getFullHierarchy: jest.fn() };

  const controller = new GeographyLookupController(
    countries as unknown as CountryService,
    states as unknown as StateService,
    regions as unknown as RegionService,
    hierarchy as unknown as OrganizationHierarchyService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('returns a stable flat shape the dashboards can bind to', async () => {
    countries.getAllCountries.mockResolvedValue([row('c-1', 'IN', 'India')]);

    const result = await controller.listCountries();

    // Exactly these four keys — extra internal fields would leak into a contract
    // the frontend then depends on.
    expect(result).toEqual([{ id: 'c-1', code: 'IN', name: 'India', isActive: true }]);
  });

  it('defaults to active-only and honours activeOnly=false', async () => {
    countries.getAllCountries.mockResolvedValue([]);

    await controller.listCountries();
    expect(countries.getAllCountries).toHaveBeenCalledWith(true);

    await controller.listCountries('false');
    expect(countries.getAllCountries).toHaveBeenCalledWith(false);
  });

  it('scopes states to their country', async () => {
    states.getAllStates.mockResolvedValue([row('s-1', 'KA', 'Karnataka')]);

    const result = await controller.listStates('c-1');

    expect(states.getAllStates).toHaveBeenCalledWith('c-1', true);
    expect(result[0]).toEqual({ id: 's-1', code: 'KA', name: 'Karnataka', isActive: true });
  });

  it('scopes regions to their state', async () => {
    regions.getAllRegions.mockResolvedValue([row('r-1', 'BLR', 'Bengaluru')]);

    const result = await controller.listRegions('s-1');

    expect(regions.getAllRegions).toHaveBeenCalledWith('s-1', true);
    expect(result[0].code).toBe('BLR');
  });
});
