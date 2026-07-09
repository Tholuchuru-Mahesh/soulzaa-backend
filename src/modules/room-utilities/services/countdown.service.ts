import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RoomCountdown, RoomCountdownStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { countdownRoomLockKey } from '../constants/room-utilities.constants';
import { StartCountdownDto } from '../dto/room-utilities.dto';
import {
  CountdownCancelledEvent,
  CountdownCompletedEvent,
  CountdownPausedEvent,
  CountdownResumedEvent,
  CountdownStartedEvent,
  CountdownTickEvent,
} from '../events/room-utilities.events';
import { CountdownRepository } from '../repositories/countdown.repository';
import { RoomUtilAuthz } from './room-util-authz.service';

/**
 * Countdown timer (AR-15): a host starts a single timer per room; pause/resume
 * recompute the remaining time from/into `endsAt`; cancel terminates it. The
 * tick monitor broadcasts progress and completes the timer when it elapses.
 * Remaining time is always derived server-side so clients self-correct on
 * reconnect.
 */
@Injectable()
export class CountdownService {
  constructor(
    private readonly repo: CountdownRepository,
    private readonly authz: RoomUtilAuthz,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async start(actor: RoomActor, roomId: string, dto: StartCountdownDto): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    return this.locks.withLock(countdownRoomLockKey(roomId), async () => {
      if (await this.repo.findActive(roomId)) {
        throw new BusinessException(
          ERROR_CODES.COUNTDOWN_EXISTS,
          'A countdown is already running in this room.',
          HttpStatus.CONFLICT,
        );
      }
      const endsAt = new Date(Date.now() + dto.durationSeconds * 1000);
      const row = await this.repo.create({
        roomId,
        creatorId: actor.id,
        label: dto.label ?? null,
        durationSeconds: dto.durationSeconds,
        endsAt,
      });
      await this.bus.publish(new CountdownStartedEvent(this.payload(row)));
      return this.view(row);
    });
  }

  async pause(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    return this.locks.withLock(countdownRoomLockKey(roomId), async () => {
      const row = await this.requireActive(roomId);
      if (row.status !== RoomCountdownStatus.RUNNING) {
        throw new BusinessException(
          ERROR_CODES.COUNTDOWN_NOT_RUNNING,
          'The countdown is not running.',
          HttpStatus.CONFLICT,
        );
      }
      const remaining = this.remainingFor(row);
      const updated = await this.repo.update(row.id, {
        status: RoomCountdownStatus.PAUSED,
        remainingSeconds: remaining,
      });
      await this.bus.publish(new CountdownPausedEvent(this.payload(updated)));
      return this.view(updated);
    });
  }

  async resume(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    return this.locks.withLock(countdownRoomLockKey(roomId), async () => {
      const row = await this.requireActive(roomId);
      if (row.status !== RoomCountdownStatus.PAUSED) {
        throw new BusinessException(
          ERROR_CODES.COUNTDOWN_NOT_PAUSED,
          'The countdown is not paused.',
          HttpStatus.CONFLICT,
        );
      }
      const endsAt = new Date(Date.now() + row.remainingSeconds * 1000);
      const updated = await this.repo.update(row.id, {
        status: RoomCountdownStatus.RUNNING,
        endsAt,
      });
      await this.bus.publish(new CountdownResumedEvent(this.payload(updated)));
      return this.view(updated);
    });
  }

  async cancel(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    return this.locks.withLock(countdownRoomLockKey(roomId), async () => {
      const row = await this.requireActive(roomId);
      const updated = await this.repo.update(row.id, {
        status: RoomCountdownStatus.CANCELLED,
        remainingSeconds: 0,
        completedAt: new Date(),
      });
      await this.bus.publish(new CountdownCancelledEvent(this.payload(updated)));
      return this.view(updated);
    });
  }

  async getActive(roomId: string): Promise<unknown> {
    const row = await this.repo.findActive(roomId);
    return { active: row ? this.view(row) : null };
  }

  /** Broadcast ticks and complete elapsed countdowns (called by the tick monitor). */
  async tickAndComplete(now: Date): Promise<void> {
    const running = await this.repo.listRunning(200);
    for (const row of running) {
      if (row.endsAt.getTime() <= now.getTime()) {
        await this.locks.withLock(countdownRoomLockKey(row.roomId), async () => {
          const fresh = await this.repo.findById(row.id);
          if (!fresh || fresh.status !== RoomCountdownStatus.RUNNING) return;
          if (fresh.endsAt.getTime() > Date.now()) return;
          const done = await this.repo.update(fresh.id, {
            status: RoomCountdownStatus.COMPLETED,
            remainingSeconds: 0,
            completedAt: new Date(),
          });
          await this.bus.publish(new CountdownCompletedEvent(this.payload(done)));
        });
      } else {
        await this.bus.publish(new CountdownTickEvent(this.payload(row)));
      }
    }
  }

  // ---- Internals ----

  private async requireActive(roomId: string): Promise<RoomCountdown> {
    const row = await this.repo.findActive(roomId);
    if (!row) {
      throw new BusinessException(
        ERROR_CODES.COUNTDOWN_NOT_FOUND,
        'No active countdown in this room.',
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private remainingFor(row: RoomCountdown): number {
    if (row.status === RoomCountdownStatus.RUNNING) {
      return Math.max(0, Math.ceil((row.endsAt.getTime() - Date.now()) / 1000));
    }
    return row.remainingSeconds;
  }

  private payload(row: RoomCountdown) {
    return {
      roomId: row.roomId,
      countdownId: row.id,
      label: row.label,
      durationSeconds: row.durationSeconds,
      remainingSeconds: this.remainingFor(row),
      endsAt: row.status === RoomCountdownStatus.RUNNING ? row.endsAt.toISOString() : null,
      status: row.status,
    };
  }

  private view(row: RoomCountdown) {
    return {
      id: row.id,
      roomId: row.roomId,
      creatorId: row.creatorId,
      label: row.label,
      durationSeconds: row.durationSeconds,
      remainingSeconds: this.remainingFor(row),
      status: row.status,
      startedAt: row.startedAt,
      endsAt: row.endsAt,
      completedAt: row.completedAt,
    };
  }
}
