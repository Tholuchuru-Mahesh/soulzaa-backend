import { BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeocodingService } from 'src/infra/geocoding/geocoding.service';
import { LocationDetectionService } from './location-detection.service';
import { UserLocationService } from './user-location.service';

describe('LocationDetectionService', () => {
  let service: LocationDetectionService;

  const prisma = {
    country: { findFirst: jest.fn() },
    state: { findFirst: jest.fn() },
    region: { findMany: jest.fn() },
  };
  const geocoding = { reverseGeocode: jest.fn() };
  const userLocation = { getLocation: jest.fn(), assignLocation: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    userLocation.getLocation.mockResolvedValue({
      userId: 'u-1',
      countryId: null,
      stateId: null,
      regionId: null,
    });
    service = new LocationDetectionService(
      prisma as unknown as PrismaService,
      geocoding as unknown as GeocodingService,
      userLocation as unknown as UserLocationService,
    );
  });

  describe('manual pick', () => {
    it('delegates a manual countryId/stateId/regionId straight to assignLocation', async () => {
      userLocation.assignLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });

      await service.detectAndAssign('u-1', { countryId: 'c-1', stateId: 's-1', regionId: 'r-1' });

      expect(geocoding.reverseGeocode).not.toHaveBeenCalled();
      expect(userLocation.assignLocation).toHaveBeenCalledWith('u-1', {
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-1',
      });
    });
  });

  describe('GPS resolution', () => {
    it('resolves country, state, and region from a full geocode match', async () => {
      geocoding.reverseGeocode.mockResolvedValue({
        countryCode: 'IN',
        stateName: 'Karnataka',
        cityName: 'Bengaluru',
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-1', code: 'IN' });
      prisma.state.findFirst.mockResolvedValue({ id: 's-1', name: 'Karnataka' });
      prisma.region.findMany.mockResolvedValue([
        { id: 'r-mys', name: 'Mysuru Region' },
        { id: 'r-blr', name: 'Bengaluru Region' },
      ]);
      userLocation.assignLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-blr',
      });

      await service.detectAndAssign('u-1', { latitude: 12.97, longitude: 77.59 });

      expect(userLocation.assignLocation).toHaveBeenCalledWith('u-1', {
        countryId: 'c-1',
        stateId: 's-1',
        regionId: 'r-blr',
      });
    });

    it('stops at country when the geocoded state has no match, rather than guessing', async () => {
      geocoding.reverseGeocode.mockResolvedValue({
        countryCode: 'IN',
        stateName: 'Nowhereland',
        cityName: 'Somewhereville',
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-1', code: 'IN' });
      prisma.state.findFirst.mockResolvedValue(null);
      userLocation.assignLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-1',
        stateId: null,
        regionId: null,
      });

      await service.detectAndAssign('u-1', { latitude: 1, longitude: 1 });

      expect(prisma.region.findMany).not.toHaveBeenCalled();
      expect(userLocation.assignLocation).toHaveBeenCalledWith('u-1', {
        countryId: 'c-1',
        stateId: null,
        regionId: null,
      });
    });

    it('leaves region unmatched when no region name embeds the geocoded city', async () => {
      geocoding.reverseGeocode.mockResolvedValue({
        countryCode: 'IN',
        stateName: 'Karnataka',
        cityName: 'Hubli',
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-1', code: 'IN' });
      prisma.state.findFirst.mockResolvedValue({ id: 's-1', name: 'Karnataka' });
      prisma.region.findMany.mockResolvedValue([{ id: 'r-blr', name: 'Bengaluru Region' }]);
      userLocation.assignLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-1',
        stateId: 's-1',
        regionId: null,
      });

      await service.detectAndAssign('u-1', { latitude: 1, longitude: 1 });

      expect(userLocation.assignLocation).toHaveBeenCalledWith('u-1', {
        countryId: 'c-1',
        stateId: 's-1',
        regionId: null,
      });
    });
  });

  describe('fail-soft and merge behaviour', () => {
    it('preserves the existing full location when the geocode fails outright', async () => {
      geocoding.reverseGeocode.mockResolvedValue(null);
      userLocation.getLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-old',
        stateId: 's-old',
        regionId: 'r-old',
      });
      userLocation.assignLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-old',
        stateId: 's-old',
        regionId: 'r-old',
      });

      await service.detectAndAssign('u-1', { latitude: 1, longitude: 1 });

      expect(userLocation.assignLocation).toHaveBeenCalledWith('u-1', {
        countryId: 'c-old',
        stateId: 's-old',
        regionId: 'r-old',
      });
    });

    it('drops the stale state/region when the resolved country genuinely differs', async () => {
      geocoding.reverseGeocode.mockResolvedValue({
        countryCode: 'US',
        stateName: null,
        cityName: null,
      });
      prisma.country.findFirst.mockResolvedValue({ id: 'c-new', code: 'US' });
      userLocation.getLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-old',
        stateId: 's-old',
        regionId: 'r-old',
      });
      userLocation.assignLocation.mockResolvedValue({
        userId: 'u-1',
        countryId: 'c-new',
        stateId: null,
        regionId: null,
      });

      await service.detectAndAssign('u-1', { latitude: 1, longitude: 1 });

      expect(userLocation.assignLocation).toHaveBeenCalledWith('u-1', {
        countryId: 'c-new',
        stateId: null,
        regionId: null,
      });
    });
  });

  it('rejects a request with neither coordinates nor a manual pick', async () => {
    await expect(service.detectAndAssign('u-1', {})).rejects.toThrow(BadRequestException);
    expect(userLocation.assignLocation).not.toHaveBeenCalled();
  });
});
