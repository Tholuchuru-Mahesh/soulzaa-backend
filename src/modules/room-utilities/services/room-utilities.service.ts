import { Injectable } from '@nestjs/common';
import type { IRoomUtilitiesService } from '../interfaces/room-utilities.service.interface';
import { CountdownService } from './countdown.service';
import { PollService } from './poll.service';
import { SpinWheelService } from './spin-wheel.service';

/**
 * Aggregate read facade over the room-utility services. Backs the
 * connection-recovery endpoint so a reconnecting client can restore any live
 * poll, countdown or spin wheel in a single call.
 */
@Injectable()
export class RoomUtilitiesService implements IRoomUtilitiesService {
  constructor(
    private readonly polls: PollService,
    private readonly countdown: CountdownService,
    private readonly spinWheel: SpinWheelService,
  ) {}

  async getActiveState(roomId: string): Promise<{
    poll: unknown;
    countdown: unknown;
    spinWheel: unknown;
  }> {
    const [poll, countdown, spinWheel] = await Promise.all([
      this.polls.getActive(roomId),
      this.countdown.getActive(roomId),
      this.spinWheel.getActiveWheels(roomId),
    ]);
    return { poll, countdown, spinWheel };
  }
}
