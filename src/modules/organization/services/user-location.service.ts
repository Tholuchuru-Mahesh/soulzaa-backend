import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface AssignLocationInput {
  countryId?: string | null;
  stateId?: string | null;
  regionId?: string | null;
}

export interface UserLocation {
  userId: string;
  countryId: string | null;
  stateId: string | null;
  regionId: string | null;
}

export interface UserLocationDetail extends UserLocation {
  countryCode: string | null;
  stateCode: string | null;
  regionCode: string | null;
}

/**
 * Owns a user's normalised location — the reference geographic scope filtering,
 * routing and eligibility read.
 *
 * Kept separate from the free-text `User.country` profile field, which stays a
 * self-reported value used for timezone resolution and display. Conflating the
 * two would mean a user editing their own profile could move themselves out of
 * an official's territory.
 */
@Injectable()
export class UserLocationService {
  private readonly logger = new Logger(UserLocationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sets a user's location, validating that the hierarchy is internally
   * consistent — a region must sit in the given state, a state in the given
   * country. An inconsistent assignment would make a user visible to one scope
   * and invisible to its parent.
   */
  async assignLocation(userId: string, input: AssignLocationInput): Promise<UserLocation> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found`);
    }

    let countryId = input.countryId ?? null;
    let stateId = input.stateId ?? null;
    const regionId = input.regionId ?? null;

    if (regionId) {
      const region = await this.prisma.region.findUnique({ where: { id: regionId } });
      if (!region) {
        throw new BadRequestException(`Region '${regionId}' not found`);
      }
      if (stateId && region.stateId !== stateId) {
        throw new BadRequestException(`Region '${regionId}' does not belong to state '${stateId}'`);
      }
      stateId = stateId ?? region.stateId;
    }

    if (stateId) {
      const state = await this.prisma.state.findUnique({ where: { id: stateId } });
      if (!state) {
        throw new BadRequestException(`State '${stateId}' not found`);
      }
      if (countryId && state.countryId !== countryId) {
        throw new BadRequestException(
          `State '${stateId}' does not belong to country '${countryId}'`,
        );
      }
      // A state implies its country; storing it saves every country-scoped query
      // from having to join upward.
      countryId = countryId ?? state.countryId;
    }

    if (countryId) {
      const country = await this.prisma.country.findUnique({ where: { id: countryId } });
      if (!country) {
        throw new BadRequestException(`Country '${countryId}' not found`);
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { countryId, stateId, regionId },
    });

    return {
      userId: updated.id,
      countryId: updated.countryId,
      stateId: updated.stateId,
      regionId: updated.regionId,
    };
  }

  /** A user's location with human-readable codes for display. */
  async getLocation(userId: string): Promise<UserLocationDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { locationCountry: true, locationState: true, locationRegion: true },
    });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found`);
    }

    return {
      userId: user.id,
      countryId: user.countryId,
      countryCode: user.locationCountry?.code ?? null,
      stateId: user.stateId,
      stateCode: user.locationState?.code ?? null,
      regionId: user.regionId,
      regionCode: user.locationRegion?.code ?? null,
    };
  }

  /**
   * Seeds `countryId` from the free-text `User.country` profile value.
   *
   * Country is the only level recoverable this way — nothing in the existing
   * data records a user's state or region, so those stay null until set
   * explicitly. Additive and idempotent: it only touches users whose countryId
   * is still null, so re-running it can never overwrite a curated assignment.
   *
   * Unmatched values are skipped rather than guessed. A wrong country here puts
   * a user in the wrong official's territory, which is worse than leaving them
   * unassigned and visible through the migration bridge.
   */
  async backfillFromProfileCountry(): Promise<{
    scanned: number;
    matched: number;
    skipped: number;
  }> {
    const countries = await this.prisma.country.findMany({
      select: { id: true, code: true, name: true },
    });

    const byKey = new Map<string, string>();
    for (const country of countries) {
      byKey.set(country.code.trim().toUpperCase(), country.id);
      byKey.set(country.name.trim().toUpperCase(), country.id);
    }

    const users = await this.prisma.user.findMany({
      where: { countryId: null, country: { not: null } },
      select: { id: true, country: true },
    });

    let matched = 0;
    let skipped = 0;

    for (const user of users) {
      const key = (user.country ?? '').trim().toUpperCase();
      const countryId = byKey.get(key);
      if (!countryId) {
        skipped++;
        continue;
      }
      await this.prisma.user.update({ where: { id: user.id }, data: { countryId } });
      matched++;
    }

    this.logger.log(
      `User location backfill: scanned ${users.length}, matched ${matched}, skipped ${skipped}`,
    );
    return { scanned: users.length, matched, skipped };
  }
}
