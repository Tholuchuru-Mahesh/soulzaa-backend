import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface StartStreamInput {
  streamerId: string;
  title: string;
  description?: string;
  /** Snapshot the streamer's geography at stream start so territory counts stay accurate. */
  countryId?: string | null;
  stateId?: string | null;
  regionId?: string | null;
}

@Injectable()
export class LiveStreamingService {
  private readonly logger = new Logger(LiveStreamingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Start a new live stream for a streamer. */
  async startStream(input: StartStreamInput) {
    const stream = await this.prisma.liveStream.create({
      data: {
        streamerId: input.streamerId,
        title: input.title,
        description: input.description,
        status: 'LIVE',
        startedAt: new Date(),
        countryId: input.countryId,
        stateId: input.stateId,
        regionId: input.regionId,
      },
    });
    this.logger.log(`Live stream ${stream.id} started by streamer ${input.streamerId}`);
    return stream;
  }

  /** End a live stream. */
  async endStream(streamId: string, streamerId: string) {
    const stream = await this.prisma.liveStream.findUnique({ where: { id: streamId } });
    if (!stream) throw new NotFoundException(`Live stream ${streamId} not found`);
    if (stream.streamerId !== streamerId) {
      throw new NotFoundException('Stream not found for this streamer');
    }

    const updated = await this.prisma.liveStream.update({
      where: { id: streamId },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    this.logger.log(`Live stream ${streamId} ended`);
    return updated;
  }

  /** List currently LIVE streams — optionally scoped to a territory. */
  async listLive(
    scopeFilter: Record<string, unknown>,
    limit = 25,
    offset = 0,
  ) {
    const isUnrestricted = Object.keys(scopeFilter).length === 0;

    // Re-map user scope predicates (countryId/stateId/regionId on the User
    // table) to the same columns on the live_streams table.
    let locationFilter: Record<string, unknown> = {};
    if (!isUnrestricted && 'OR' in scopeFilter) {
      locationFilter = {
        OR: (scopeFilter as { OR: Array<Record<string, unknown>> }).OR.map((clause) => {
          const out: Record<string, unknown> = {};
          if ('countryId' in clause) out['countryId'] = clause['countryId'];
          if ('stateId' in clause) out['stateId'] = clause['stateId'];
          if ('regionId' in clause) out['regionId'] = clause['regionId'];
          return out;
        }),
      };
    }

    const where = { status: 'LIVE' as const, ...locationFilter };

    const [total, items] = await Promise.all([
      this.prisma.liveStream.count({ where }),
      this.prisma.liveStream.findMany({
        where,
        orderBy: { viewerCount: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
        select: {
          id: true,
          streamerId: true,
          title: true,
          thumbnailKey: true,
          viewerCount: true,
          startedAt: true,
          stateId: true,
          countryId: true,
        },
      }),
    ]);

    return { total, items };
  }

  /** Count live streams in a territory — used by the dashboard endpoint. */
  async countLive(scopeFilter: Record<string, unknown>): Promise<number> {
    const isUnrestricted = Object.keys(scopeFilter).length === 0;

    let locationFilter: Record<string, unknown> = {};
    if (!isUnrestricted && 'OR' in scopeFilter) {
      locationFilter = {
        OR: (scopeFilter as { OR: Array<Record<string, unknown>> }).OR.map((clause) => {
          const out: Record<string, unknown> = {};
          if ('countryId' in clause) out['countryId'] = clause['countryId'];
          if ('stateId' in clause) out['stateId'] = clause['stateId'];
          if ('regionId' in clause) out['regionId'] = clause['regionId'];
          return out;
        }),
      };
    }

    return this.prisma.liveStream.count({ where: { status: 'LIVE', ...locationFilter } });
  }

  /** Find streams by a specific streamer. */
  async findByStreamer(streamerId: string, limit = 25, offset = 0) {
    const [total, items] = await Promise.all([
      this.prisma.liveStream.count({ where: { streamerId } }),
      this.prisma.liveStream.findMany({
        where: { streamerId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
      }),
    ]);
    return { total, items };
  }
}
