import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ReverseGeocodeResult {
  countryCode: string;
  stateName: string | null;
  cityName: string | null;
}

interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GoogleGeocodeResponse {
  status: string;
  results: Array<{ address_components: GoogleAddressComponent[] }>;
}

const CITY_TYPES = ['locality', 'postal_town', 'administrative_area_level_2'];

/**
 * Reverse-geocodes GPS coordinates via the Google Geocoding API. The only place
 * that API is called; `LocationDetectionService` consumes it to resolve a user's
 * Country/State/Region.
 *
 * Fails soft everywhere — a missing key, a network error, a timeout, or a
 * zero-result response all just return `null`. Location capture is a
 * best-effort convenience, not something that should ever surface as an error
 * to the caller; an unresolved location is handled the same way an unmatched
 * one is (see `LocationDetectionService`) — left unassigned rather than guessed.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(private readonly config: ConfigService) {}

  async reverseGeocode(latitude: number, longitude: number): Promise<ReverseGeocodeResult | null> {
    const apiKey = this.config.get('geocoding', { infer: true })?.googleApiKey;
    if (!apiKey) {
      this.logger.warn('Reverse geocode skipped: GOOGLE_GEOCODING_API_KEY is not configured');
      return null;
    }

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${latitude},${longitude}`);
    url.searchParams.set('key', apiKey);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        this.logger.warn(`Reverse geocode HTTP ${response.status}`);
        return null;
      }

      const body = (await response.json()) as GoogleGeocodeResponse;
      if (body.status !== 'OK' || body.results.length === 0) {
        this.logger.warn(`Reverse geocode returned status=${body.status}`);
        return null;
      }

      return this.parseComponents(body.results[0].address_components);
    } catch (err) {
      this.logger.warn(`Reverse geocode failed: ${(err as Error).message}`);
      return null;
    }
  }

  private parseComponents(components: GoogleAddressComponent[]): ReverseGeocodeResult | null {
    const country = components.find((c) => c.types.includes('country'));
    if (!country) return null;

    const state = components.find((c) => c.types.includes('administrative_area_level_1'));
    const city = components.find((c) => c.types.some((t) => CITY_TYPES.includes(t)));

    return {
      countryCode: country.short_name.toUpperCase(),
      stateName: state?.long_name ?? null,
      cityName: city?.long_name ?? null,
    };
  }
}
