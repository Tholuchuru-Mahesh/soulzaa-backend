import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HistoryQueryDto {
  page?: number;
  limit?: number;
}

@Injectable()
export class FamilyHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves paginated activity history for a family with enriched human-readable logs.
   */
  async getFamilyHistory(familyId: string, query: HistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = familyId ? { familyId } : {};

    const [total, rawItems] = await Promise.all([
      this.prisma.familyHistory.count({ where }),
      this.prisma.familyHistory.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Collect all referenced user IDs to batch resolve usernames
    const userIds = new Set<string>();
    for (const item of rawItems) {
      if (item.userId) userIds.add(item.userId);
      const d: any = item.details;
      if (d?.actorId) userIds.add(d.actorId);
      if (d?.kickedUserId) userIds.add(d.kickedUserId);
      if (d?.acceptedUserId) userIds.add(d.acceptedUserId);
      if (d?.rejectedUserId) userIds.add(d.rejectedUserId);
      if (d?.newFounderUserId) userIds.add(d.newFounderUserId);
      if (d?.previousFounderId) userIds.add(d.previousFounderId);
    }

    const users =
      userIds.size > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: Array.from(userIds) } },
            select: { id: true, username: true, fullName: true },
          })
        : [];

    const userMap = new Map(
      users.map((u) => [u.id, u.fullName || u.username || 'Member']),
    );

    const items = rawItems.map((item) => {
      const d: any = item.details || {};
      const primaryName = (item.userId ? userMap.get(item.userId) : null) || 'Member';
      const actorName = d.actorId ? userMap.get(d.actorId) || 'Moderator' : null;
      let description = '';

      switch (item.action) {
        case 'FAMILY_CREATED':
          description = `Family created by ${primaryName}`;
          break;
        case 'JOIN':
        case 'MEMBER_JOINED':
          description = `${primaryName} joined the family`;
          break;
        case 'LEAVE':
        case 'MEMBER_LEFT':
          description = `${primaryName} left the family`;
          break;
        case 'ACCEPT_REQUEST': {
          const acceptedName = d.acceptedUserId ? userMap.get(d.acceptedUserId) || 'Member' : primaryName;
          description = actorName
            ? `${acceptedName} joined the family (Approved by ${actorName})`
            : `${acceptedName} joined the family`;
          break;
        }
        case 'REJECT_REQUEST': {
          const rejectedName = d.rejectedUserId ? userMap.get(d.rejectedUserId) || 'Applicant' : 'Applicant';
          description = actorName
            ? `Join request from ${rejectedName} was rejected by ${actorName}`
            : `Join request from ${rejectedName} was rejected`;
          break;
        }
        case 'MEMBER_KICKED': {
          const kickedName = d.kickedUserId ? userMap.get(d.kickedUserId) || primaryName : primaryName;
          const reasonStr = d.reason ? ` (Reason: "${d.reason}")` : '';
          description = actorName
            ? `${kickedName} was removed from the family by ${actorName}${reasonStr}`
            : `${kickedName} was removed from the family${reasonStr}`;
          break;
        }
        case 'ROLE_CHANGED': {
          const roleStr = d.toRole ? d.toRole.replace(/_/g, ' ') : 'new role';
          description = actorName
            ? `${primaryName}'s role was updated to ${roleStr} by ${actorName}`
            : `${primaryName}'s role was updated to ${roleStr}`;
          break;
        }
        case 'OWNER_TRANSFERRED': {
          const newLeader = d.newFounderUserId ? userMap.get(d.newFounderUserId) || primaryName : primaryName;
          description = `Leadership transferred to ${newLeader}`;
          break;
        }
        case 'EDIT_PROFILE':
          description = `${primaryName} updated family profile details`;
          break;
        default:
          description = `${item.action.replace(/_/g, ' ')} by ${primaryName}`;
      }

      return {
        ...item,
        userName: primaryName,
        actorName,
        description,
      };
    });

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }
}
