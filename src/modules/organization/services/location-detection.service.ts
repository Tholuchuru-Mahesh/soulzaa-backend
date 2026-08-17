import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeocodingService } from 'src/infra/geocoding/geocoding.service';
import { DetectLocationDto } from '../dto/detect-location.dto';
import { UserLocationService, type UserLocation } from './user-location.service';

/**
 * Self-service counterpart to `UserLocationService`'s admin-only assignment —
 * this is how a regular end user's `User.countryId/stateId/regionId` actually
 * gets populated, either from GPS (reverse-geocoded) or a manual Country →
 * State → Region pick when GPS is denied or unresolved.
 *
 * Every write still goes through `UserLocationService.assignLocation`, which
 * owns the hierarchy-consistency validation — this service's only job is
 * turning a `DetectLocationDto` into the `{ countryId, stateId, regionId }`
 * that call needs.
 */
@Injectable()
export class LocationDetectionService {
  private readonly logger = new Logger(LocationDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService,
    private readonly userLocation: UserLocationService,
  ) {}

  async detectAndAssign(userId: string, dto: DetectLocationDto): Promise<UserLocation> {
    if (dto.countryId || dto.stateId || dto.regionId) {
      return this.userLocation.assignLocation(userId, {
        countryId: dto.countryId ?? null,
        stateId: dto.stateId ?? null,
        regionId: dto.regionId ?? null,
      });
    }

    if (dto.latitude === undefined || dto.longitude === undefined) {
      throw new BadRequestException(
        'Provide either latitude/longitude or a manual countryId/stateId/regionId',
      );
    }

    const resolved = await this.resolveFromCoordinates(dto.latitude, dto.longitude);
    const merged = await this.mergeWithExisting(userId, resolved);
    return this.userLocation.assignLocation(userId, merged);
  }

  /**
   * GPS resolution is additive-only: a level the geocode couldn't confidently
   * resolve (rate limit, no key configured, unmatched city name, ...) must
   * never null out a level that was already assigned — by an earlier GPS run
   * or an Admin. If the resolved country genuinely differs from the one on
   * file, that's a real relocation, not a partial miss — the old state/region
   * belonged to the old country and would fail (or silently misrepresent) the
   * hierarchy check in `assignLocation`, so they're dropped rather than
   * carried forward in that case.
   */
  private async mergeWithExisting(
    userId: string,
    resolved: { countryId: string | null; stateId: string | null; regionId: string | null },
  ): Promise<{ countryId: string | null; stateId: string | null; regionId: string | null }> {
    const existing = await this.userLocation.getLocation(userId);

    const countryChanged =
      resolved.countryId !== null &&
      existing.countryId !== null &&
      resolved.countryId !== existing.countryId;
    if (countryChanged) return resolved;

    return {
      countryId: resolved.countryId ?? existing.countryId,
      stateId: resolved.stateId ?? existing.stateId,
      regionId: resolved.regionId ?? existing.regionId,
    };
  }

  /**
   * Matches a geocode result down through the hierarchy, stopping at the first
   * level that doesn't resolve — an unmatched city still leaves country/state
   * assigned, an unmatched state still leaves country assigned. Never guesses:
   * a level with no confident match is left null rather than assigned wrong,
   * same principle as `UserLocationService.backfillFromProfileCountry`.
   */
  private async resolveFromCoordinates(
    latitude: number,
    longitude: number,
  ): Promise<{ countryId: string | null; stateId: string | null; regionId: string | null }> {
    const geocode = await this.geocoding.reverseGeocode(latitude, longitude);
    if (!geocode) {
      this.logger.warn(`No geocode result for (${latitude}, ${longitude})`);
      return { countryId: null, stateId: null, regionId: null };
    }

    const country = await this.prisma.country.findFirst({
      where: { code: { equals: geocode.countryCode, mode: 'insensitive' }, isActive: true },
    });
    if (!country) {
      this.logger.warn(`No active Country matches code '${geocode.countryCode}'`);
      return { countryId: null, stateId: null, regionId: null };
    }

    if (!geocode.stateName) {
      return { countryId: country.id, stateId: null, regionId: null };
    }

    const state = await this.prisma.state.findFirst({
      where: {
        countryId: country.id,
        name: { equals: geocode.stateName, mode: 'insensitive' },
        isActive: true,
      },
    });
    if (!state) {
      return { countryId: country.id, stateId: null, regionId: null };
    }

    if (!geocode.cityName) {
      return { countryId: country.id, stateId: state.id, regionId: null };
    }

    const candidates = await this.prisma.region.findMany({
      where: { stateId: state.id, isActive: true },
    });
    const city = geocode.cityName.toLowerCase();
    const region = candidates.find(
      (r) =>
        r.name.toLowerCase().includes(city) ||
        city.includes(r.name.toLowerCase().replace(/ region$/, '')),
    );

    return { countryId: country.id, stateId: state.id, regionId: region?.id ?? null };
  }
}
