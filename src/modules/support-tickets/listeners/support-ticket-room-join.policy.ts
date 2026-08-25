import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  ROOM_JOIN_POLICY_REGISTRY,
  type RoomJoinPolicy,
  type RoomJoinPolicyRegistry,
} from 'src/infra/socket/room-join-policy.interface';
import { PermissionResolver } from 'src/modules/authorization/services/permission-resolver.service';
import {
  SUPPORT_NAMESPACE,
  SUPPORT_STAFF_PERMISSION,
  supportTicketRoom,
} from '../constants/support-tickets.constants';

/**
 * Gates `room:join` on `/support`. Self-registers into the shared policy
 * registry on module init, mirroring `GamesRoomJoinPolicy`.
 *
 * This is load-bearing for privacy, not just tidiness: a namespace with no
 * policy joins unconditionally, so without this any authenticated user could
 * join `ticket_<someone else's id>` and read a stranger's support conversation
 * — which routinely contains payment disputes and account details.
 *
 * Access mirrors the REST routes exactly: the submitter reads their own ticket,
 * and staff holding `support_ticket.review` read any ticket. Everyone else is
 * denied, including for a ticket id that does not exist — an unknown id and a
 * ticket belonging to someone else return the same answer, so membership is not
 * probeable by enumeration.
 */
@Injectable()
export class SupportTicketRoomJoinPolicy implements RoomJoinPolicy, OnModuleInit {
  constructor(
    @Inject(ROOM_JOIN_POLICY_REGISTRY) private readonly registry: RoomJoinPolicyRegistry,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolver,
  ) {}

  onModuleInit(): void {
    this.registry.set(SUPPORT_NAMESPACE, this);
  }

  async canJoin(userId: string, roomId: string): Promise<'player' | 'spectator' | 'deny'> {
    const ticketId = this.ticketIdOf(roomId);
    if (!ticketId) return 'deny';

    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { submitterId: true },
    });
    if (!ticket) return 'deny';

    if (ticket.submitterId === userId) return 'player';

    const isStaff = await this.permissions.checkUserHasPermissions(userId, [
      SUPPORT_STAFF_PERMISSION,
    ]);
    return isStaff ? 'player' : 'deny';
  }

  /** `ticket_<uuid>` → `<uuid>`; anything else is not a ticket room. */
  private ticketIdOf(roomId: string): string | null {
    const expectedPrefixLength = supportTicketRoom('').length;
    if (!roomId?.startsWith(supportTicketRoom(''))) return null;
    const id = roomId.slice(expectedPrefixLength);
    return isUUID(id, '4') ? id : null;
  }
}
