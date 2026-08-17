import { ConfigService } from '@nestjs/config';
import { GeocodingService } from './geocoding.service';

describe('GeocodingService', () => {
  let service: GeocodingService;
  const config = { get: jest.fn() };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue({ googleApiKey: 'test-key' });
    service = new GeocodingService(config as unknown as ConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns null without making a request when no API key is configured', async () => {
    config.get.mockReturnValue({ googleApiKey: undefined });
    global.fetch = jest.fn();

    const result = await service.reverseGeocode(12.97, 77.59);

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('parses country, state, and city from a successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [
          {
            address_components: [
              { long_name: 'Bengaluru', short_name: 'Bengaluru', types: ['locality', 'political'] },
              {
                long_name: 'Karnataka',
                short_name: 'KA',
                types: ['administrative_area_level_1', 'political'],
              },
              { long_name: 'India', short_name: 'IN', types: ['country', 'political'] },
            ],
          },
        ],
      }),
    });

    const result = await service.reverseGeocode(12.97, 77.59);

    expect(result).toEqual({ countryCode: 'IN', stateName: 'Karnataka', cityName: 'Bengaluru' });
  });

  it('returns null on a non-OK HTTP response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    expect(await service.reverseGeocode(1, 1)).toBeNull();
  });

  it('returns null when Google reports zero results', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) });

    expect(await service.reverseGeocode(1, 1)).toBeNull();
  });

  it('returns null instead of throwing when the request itself fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    expect(await service.reverseGeocode(1, 1)).toBeNull();
  });

  it('returns null when the response has no country component', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [
          {
            address_components: [{ long_name: 'Nowhere', short_name: 'NW', types: ['political'] }],
          },
        ],
      }),
    });

    expect(await service.reverseGeocode(1, 1)).toBeNull();
  });
});
