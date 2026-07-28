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
      select: { regionId: true, stateId: true, countryId: true },
    });

    if (!user?.regionId) {
      // Without a region there is no Official to review it, and the request
      // would sit unroutable in a queue nobody owns.
      throw new BadRequestException(
        'The subject has no assigned region. Set their location before submitting a role request.',
      );
    }

    return { regionId: user.regionId, stateId: user.stateId, countryId: user.countryId };
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
