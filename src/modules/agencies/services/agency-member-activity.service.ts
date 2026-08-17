import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type {
  MemberActivityCounters,
  MemberTimelineEntry,
} from '../interfaces/agency-member.interface';
import { AgencyMemberService } from './agency-member.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_PAGE_SIZE = 100;

/**
 * How many rows are read from each timeline source before merging.
 *
 * Bounded so one very active member cannot pull their whole history into
 * memory, but generous enough that the merged list is accurate for the pages a
 * user will actually scroll through.
 */
const MAX_SOURCE_ROWS = 200;

/**
 * The Activity tab: counters and the merged event timeline for one member.
 *
 * Counters and timeline share the same date window, so they are built from one
 * set of queries and returned together — changing the date filter is one
 * request, not two, and the two halves can never disagree about the period
 * they describe.
 */
@Injectable()
export class AgencyMemberActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: AgencyMemberService,
  ) {}

  async getActivity(
    agencyId: string,
    userId: string,
    options: {
      page?: number;
      limit?: number;
      from?: Date;
      to?: Date;
      sort?: 'newest' | 'oldest';
    } = {},
  ) {
    // Before anything is read: a guessed uuid must reveal nothing.
    await this.members.assertMember(agencyId, userId);

    const to = options.to ?? new Date();
    const from = options.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);
    const sort = options.sort ?? 'newest';

    const window = { gte: from, lt: to };
    const [logins, sent, received, audioJoins, videoJoins, events] = await Promise.all([
      this.prisma.sessionHistory.findMany({
        where: { userId, event: 'CREATED', createdAt: window },
        orderBy: { createdAt: 'desc' },
        take: MAX_SOURCE_ROWS,
        select: { id: true, createdAt: true },
      }),
      this.prisma.giftTransaction.findMany({
        where: { senderId: userId, createdAt: window },
        orderBy: { createdAt: 'desc' },
        take: MAX_SOURCE_ROWS,
        select: { id: true, createdAt: true, totalCoinValue: true },
      }),
      this.prisma.giftTransaction.findMany({
        where: { receiverId: userId, createdAt: window },
        orderBy: { createdAt: 'desc' },
        take: MAX_SOURCE_ROWS,
        select: { id: true, createdAt: true, totalCoinValue: true },
      }),
      this.prisma.roomMember.findMany({
        where: { userId, joinedAt: window },
        orderBy: { joinedAt: 'desc' },
        take: MAX_SOURCE_ROWS,
        select: { id: true, joinedAt: true },
      }),
      this.prisma.videoRoomMember.findMany({
        where: { userId, joinedAt: window },
        orderBy: { joinedAt: 'desc' },
        take: MAX_SOURCE_ROWS,
        select: { id: true, joinedAt: true },
      }),
      this.prisma.eventParticipant.findMany({
        where: { userId, joinedAt: window },
        orderBy: { joinedAt: 'desc' },
        take: MAX_SOURCE_ROWS,
        select: { id: true, joinedAt: true, event: { select: { name: true } } },
      }),
    ]);

    const entries: MemberTimelineEntry[] = [
      ...logins.map((row) => ({
        id: row.id,
        kind: 'LOGIN' as const,
        title: 'Login',
        detail: 'user logged in to the application',
        occurredAt: row.createdAt,
      })),
      ...sent.map((row) => ({
        id: row.id,
        kind: 'GIFT_SENT' as const,
        title: 'Gift Sent',
        // BigInt: stringified, never passed through Number().
        detail: `Sent a gift worth ${row.totalCoinValue.toString()} coins`,
        occurredAt: row.createdAt,
      })),
      ...received.map((row) => ({
        id: row.id,
        kind: 'GIFT_RECEIVED' as const,
        title: 'Gift Received',
        detail: `Received a gift worth ${row.totalCoinValue.toString()} coins`,
        occurredAt: row.createdAt,
      })),
      ...audioJoins.map((row) => ({
        id: row.id,
        kind: 'ROOM_JOINED' as const,
        title: 'Joined Audio Room',
        detail: null,
        occurredAt: row.joinedAt,
      })),
      ...videoJoins.map((row) => ({
        id: row.id,
        kind: 'VIDEO_ROOM_JOINED' as const,
        title: 'Joined the video room',
        detail: null,
        occurredAt: row.joinedAt,
      })),
      ...events.map((row) => ({
        id: row.id,
        kind: 'EVENT_JOINED' as const,
        title: 'Event Joined',
        detail: row.event?.name ? `Joined the event "${row.event.name}"` : null,
        occurredAt: row.joinedAt,
      })),
    ];

    // Sorted across all six sources, then paged. Trimming per source first
    // would drop a busy source's newest entries in favour of a quiet source's
    // older ones.
    entries.sort((a, b) =>
      sort === 'oldest'
        ? a.occurredAt.getTime() - b.occurredAt.getTime()
        : b.occurredAt.getTime() - a.occurredAt.getTime(),
    );

    const total = entries.length;
    const items = entries.slice((page - 1) * limit, page * limit);

    const loginDays = new Set(logins.map((row) => row.createdAt.toISOString().slice(0, 10))).size;
    const roomsJoined = audioJoins.length + videoJoins.length;
    const counters: MemberActivityCounters = {
      loginDays,
      giftsSent: sent.length,
      giftsReceived: received.length,
      roomsJoined,
      eventsJoined: events.length,
      // The sum of the five above — which is what "total activities" has always
      // meant on this screen.
      totalActivities: loginDays + sent.length + received.length + roomsJoined + events.length,
    };

    return {
      range: { from, to },
      counters,
      timeline: {
        items,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
