import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RandomPickPool } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { pickIndex, pickNumber } from '../constants/room-utilities.constants';
import { RandomPickDto } from '../dto/room-utilities.dto';
import { RandomPickedEvent } from '../events/room-utilities.events';
import { InteractiveToolsRepository } from '../repositories/interactive-tools.repository';
import { RoomUtilAuthz } from './room-util-authz.service';

/**
 * Random picker (AR-15): a host draws a random speaker/audience member (from the
 * LIVE stage snapshot, resolved at pick time so a departed user can't win) or a
 * random number in a range. The selection is server-decided.
 */
@Injectable()
export class RandomPickerService {
  constructor(
    private readonly repo: InteractiveToolsRepository,
    private readonly authz: RoomUtilAuthz,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async pick(actor: RoomActor, roomId: string, dto: RandomPickDto): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);

    let pickedUserId: string | null = null;
    let pickedNumber: number | null = null;

    if (dto.pool === RandomPickPool.NUMBER) {
      const min = dto.rangeMin ?? 1;
      const max = dto.rangeMax ?? 100;
      if (max < min) {
        throw new BusinessException(
          ERROR_CODES.RANDOM_PICK_INVALID_RANGE,
          'rangeMax must be greater than or equal to rangeMin.',
          HttpStatus.BAD_REQUEST,
        );
      }
      pickedNumber = pickNumber(min, max);
    } else {
      const candidates = await this.resolveCandidates(roomId, dto.pool);
      if (candidates.length === 0) {
        throw new BusinessException(
          ERROR_CODES.RANDOM_PICK_NO_CANDIDATES,
          'There is no one to pick from in this pool.',
          HttpStatus.CONFLICT,
        );
      }
      pickedUserId = candidates[pickIndex(candidates.length)];
    }

    const row = await this.repo.createRandomPick({
      roomId,
      userId: actor.id,
      pool: dto.pool,
      rangeMin: dto.rangeMin ?? null,
      rangeMax: dto.rangeMax ?? null,
      pickedUserId,
      pickedNumber,
    });
    await this.bus.publish(
      new RandomPickedEvent({
        roomId,
        pickId: row.id,
        userId: actor.id,
        pool: dto.pool,
        pickedUserId,
        pickedNumber,
        createdAt: row.createdAt.toISOString(),
      }),
    );
    return { id: row.id, pool: dto.pool, pickedUserId, pickedNumber, createdAt: row.createdAt };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listPickHistory(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        pool: r.pool,
        pickedUserId: r.pickedUserId,
        pickedNumber: r.pickedNumber,
        createdAt: r.createdAt,
      })),
      total,
      q.page,
      q.limit,
    );
  }

  /** Resolve the live candidate user ids for a user pool from the stage snapshot. */
  private async resolveCandidates(roomId: string, pool: RandomPickPool): Promise<string[]> {
    const stage = await this.authz.rooms$().getStage(roomId);
    const speakers = stage.seats
      .map((s) => s.occupantUserId)
      .filter((id): id is string => id !== null);
    const audience = stage.queue.map((q) => q.userId);
    switch (pool) {
      case RandomPickPool.SPEAKERS:
        return speakers;
      case RandomPickPool.AUDIENCE:
        return audience;
      case RandomPickPool.ALL:
        return [...new Set([...speakers, ...audience])];
      default:
        return [];
    }
  }
}
