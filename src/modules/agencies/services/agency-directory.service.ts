import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';

const MAX_PAGE_SIZE = 50;

/**
 * The public list of agencies a member can browse.
 *
 * The trading name comes from the approved application's `formData.agencyName`
 * — there is no agency table, because an agency is a user account with the
 * AGENCY role, so the name the applicant registered lives on the request that
 * approved them.
 *
 * Only approved agencies appear. An application still in review is not an
 * agency yet and must not be listed as one.
 */
@Injectable()
export class AgencyDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  async list(options: { search?: string; page?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);

    // Approved AGENCY requests are the source: holding the role without an
    // approved application (an admin grant) still counts, but the name can
    // only come from an application, so this is what the directory is built on.
    const requests = await this.prisma.roleRequest.findMany({
      where: { type: 'AGENCY', status: 'APPROVED' },
      orderBy: { decidedAt: 'desc' },
      select: { subjectUserId: true, formData: true, decidedAt: true },
    });

    // One row per agency: a user who applied more than once keeps the newest
    // approval, which is the name they trade under now.
    const byUser = new Map<string, { name: string; approvedAt: Date | null }>();
    for (const request of requests) {
      if (byUser.has(request.subjectUserId)) continue;
      const form = (request.formData ?? {}) as Record<string, unknown>;
      const name = typeof form.agencyName === 'string' ? form.agencyName.trim() : '';
      byUser.set(request.subjectUserId, { name, approvedAt: request.decidedAt });
    }

    const search = options.search?.trim().toLowerCase();
    let entries = [...byUser.entries()];
    if (search) {
      entries = entries.filter(([, value]) => value.name.toLowerCase().includes(search));
    }

    const total = entries.length;
    const pageEntries = entries.slice((page - 1) * limit, page * limit);
    const ids = pageEntries.map(([userId]) => userId);

    const [identities, memberCounts] = await Promise.all([
      this.profiles.resolvePublicIdentities(ids),
      this.prisma.agencyRelationship.groupBy({
        by: ['agencyId'],
        where: { agencyId: { in: ids }, status: 'ACTIVE' },
        _count: { agencyId: true },
      }),
    ]);
    const membersById = new Map(memberCounts.map((row) => [row.agencyId, row._count.agencyId]));

    return {
      items: pageEntries.map(([userId, value]) => ({
        agencyId: userId,
        // Falls back to the account's own display name when the application
        // carried no trading name, so an entry is never blank.
        agencyName: value.name || (identities.get(userId)?.displayName ?? 'Agency'),
        ownerName: identities.get(userId)?.displayName ?? null,
        avatarUrl: identities.get(userId)?.avatarUrl ?? null,
        memberCount: membersById.get(userId) ?? 0,
        approvedAt: value.approvedAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }
}
