import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { RoleRequestStage } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { STAGE_REVIEWER_ROLE } from '../constants/role-request.constants';

/** Roles that may act at any stage, in any territory. */
const UNRESTRICTED_ROLES = ['SUPER_ADMIN', 'ADMIN'];

export interface RequestGeography {
  regionId: string;
  stateId: string | null;
  countryId: string | null;
}

/**
 * Decides who may act on a role request, and where a request belongs.
 *
 * Routing is entirely on the normalised hierarchy: a request is filed against a
 * region, and each stage is answered by the role holding the matching scope. Two
 * Officials in different regions can never see each other's queue, because the
 * predicate is the region id rather than a name that might collide.
 */
@Injectable()
export class RoleRequestRoutingService {
  private readonly logger = new Logger(RoleRequestRoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: GeographicScopeResolver,
    private readonly roles: RoleResolver,
  ) {}

  /**
   * Resolves the full geography for a request from the subject's own location.
   *
   * Denormalising state and country onto the request means the MANAGER and ADMIN
   * stages do not have to walk the hierarchy on every queue read, and a request
   * keeps the territory it was filed in even if the subject later moves.
   */
  async resolveGeography(subjectUserId: string): Promise<RequestGeography> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectUserId },
      select: { regionId: true, stateId: true, countryId: true, country: true },
    });

    if (user?.regionId) {
      return { regionId: user.regionId, stateId: user.stateId, countryId: user.countryId };
    }

    // Registration captures `country` as free text and never fills the
    // normalised hierarchy, so an ordinary account reaches here with no region
    // and could never file a request at all. Derive it where the answer is not
    // a guess.
    const derived = await this.deriveRegion(subjectUserId, user);
    if (derived) {
      return derived;
    }

    // Without a region there is no Official to review it, and the request
    // would sit unroutable in a queue nobody owns.
    throw new BadRequestException(
      'The subject has no assigned region. Set their location before submitting a role request.',
    );
  }

  /**
   * Resolves a region for a user who has none, from the country they gave.
   *
   * Only when the answer is unambiguous — a country with exactly one region.
   * With several, guessing would file the request in the wrong territory and
   * hand it to an Official who does not cover that user, which is worse than
   * asking for the location to be set.
   *
   * The resolved location is written back, so the next flow that needs it does
   * not have to derive it again.
   */
  private async deriveRegion(
    subjectUserId: string,
    user: { countryId: string | null; country: string | null } | null,
  ): Promise<RequestGeography | null> {
    if (!user) return null;

    let countryId = user.countryId;
    if (!countryId && user.country) {
      // Free-text country, matched case-insensitively against the code or the
      // name — "IN", "in" and "India" all name the same country.
      const country = await this.prisma.country.findFirst({
        where: {
          OR: [
            { code: { equals: user.country, mode: 'insensitive' } },
            { name: { equals: user.country, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      countryId = country?.id ?? null;
    }
    if (!countryId) return null;

    const regions = await this.prisma.region.findMany({
      where: { state: { countryId } },
      select: { id: true, stateId: true },
      // Two is enough to know it is ambiguous; there is no need to read them all.
      take: 2,
    });
    if (regions.length !== 1) {
      if (regions.length > 1) {
        this.logger.warn(
          `User ${subjectUserId} has no region and country ${countryId} has several — cannot derive one`,
        );
      }
      return null;
    }

    const [region] = regions;
    await this.prisma.user.update({
      where: { id: subjectUserId },
      data: { regionId: region.id, stateId: region.stateId, countryId },
    });
    this.logger.log(`Derived region ${region.id} for user ${subjectUserId} from their country`);

    return { regionId: region.id, stateId: region.stateId, countryId };
  }

  /** Whether `actorId` may act on a request at `stage` in the given geography. */
  async canActAtStage(
    actorId: string,
    stage: RoleRequestStage,
    geography: RequestGeography,
  ): Promise<boolean> {
    const roleNames = await this.roles.getRoleNames(actorId);
    if (roleNames.some((name) => UNRESTRICTED_ROLES.includes(name))) return true;

    // Holding the reviewer role is necessary but not sufficient — an Official in
    // another region must not be able to approve this one.
    if (!roleNames.includes(STAGE_REVIEWER_ROLE[stage])) return false;

    const assignments = await this.scopes.getUserScopes(actorId);

    return assignments.some((scope) => {
      if (scope.scopeType === 'GLOBAL') return true;
      if (scope.scopeType === 'REGION') return scope.regionId === geography.regionId;
      if (scope.scopeType === 'STATE') return scope.stateId === geography.stateId;
      if (scope.scopeType === 'COUNTRY') return scope.countryId === geography.countryId;
      return false;
    });
  }

  /**
   * A Prisma `where` fragment selecting the requests `actorId` may review.
   *
   * `{}` is unrestricted; `{ OR: [] }` matches nothing — a reviewer with no
   * scope sees an empty queue rather than the whole platform's.
   */
  async queueFilter(actorId: string): Promise<Record<string, unknown>> {
    const roleNames = await this.roles.getRoleNames(actorId);
    if (roleNames.some((name) => UNRESTRICTED_ROLES.includes(name))) return {};

    const assignments = await this.scopes.getUserScopes(actorId);
    if (assignments.some((scope) => scope.scopeType === 'GLOBAL')) return {};

    const clauses: Array<Record<string, unknown>> = [];
    for (const scope of assignments) {
      if (scope.scopeType === 'REGION' && scope.regionId) {
        clauses.push({ regionId: scope.regionId });
      } else if (scope.scopeType === 'STATE' && scope.stateId) {
        clauses.push({ stateId: scope.stateId });
      } else if (scope.scopeType === 'COUNTRY' && scope.countryId) {
        clauses.push({ countryId: scope.countryId });
      }
    }

    return { OR: clauses };
  }
}
