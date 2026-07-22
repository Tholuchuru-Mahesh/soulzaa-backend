import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { loadVideoRoomGiftConfig } from '../config/video-room-gift.config';
import { SendVideoRoomGiftDto, VideoRoomGiftTarget } from '../dto/send-video-room-gift.dto';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';

/**
 * Expands a gift's `target` selector into concrete receiver ids (VR-10).
 *
 * Kept apart from the send pipeline because target expansion is a pure read over
 * live room state, while sending moves money — separating them means the
 * expansion rules can be exercised exhaustively without a wallet in play.
 */
@Injectable()
export class VideoRoomGiftTargetResolver {
  constructor(
    private readonly seats: VideoRoomSeatStateService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve recipients for a send. The returned list is de-duplicated, excludes
   * the sender, is non-empty, and is within the configured cap — so callers can
   * treat it as already-validated.
   */
  async resolve(roomId: string, dto: SendVideoRoomGiftDto, senderId: string): Promise<string[]> {
    const cfg = loadVideoRoomGiftConfig(this.config);
    const candidates = await this.candidatesFor(roomId, dto, cfg.allowRoomAll);

    // Excluding the sender here rather than in validation keeps "gift the stage"
    // usable for someone who is themselves on stage: they gift everyone else.
    const receivers = [...new Set(candidates)].filter((id) => id && id !== senderId);

    if (receivers.length === 0) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'There is nobody to receive this gift.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (receivers.length > cfg.maxReceivers) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
        `A gift may target at most ${cfg.maxReceivers} recipients.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return receivers;
  }

  private async candidatesFor(
    roomId: string,
    dto: SendVideoRoomGiftDto,
    allowRoomAll: boolean,
  ): Promise<string[]> {
    switch (dto.target) {
      case VideoRoomGiftTarget.SINGLE:
        return dto.receiverId ? [dto.receiverId] : [];

      case VideoRoomGiftTarget.MULTI:
        return dto.receiverIds ?? [];

      case VideoRoomGiftTarget.SEAT_ALL:
        return this.occupiedSeatUsers(roomId);

      case VideoRoomGiftTarget.ROOM_ALL:
        if (!allowRoomAll) {
          throw new BusinessException(
            ERROR_CODES.GIFT_CONTEXT_INVALID,
            'Gifting the whole room is not enabled.',
            HttpStatus.BAD_REQUEST,
          );
        }
        // Resolver seam is in place; the audience source lands with the feature.
        return this.occupiedSeatUsers(roomId);

      default:
        throw new BusinessException(
          ERROR_CODES.GIFT_CONTEXT_INVALID,
          'Unsupported gift target.',
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  /** Occupants of the live seat stage, in seat order. */
  private async occupiedSeatUsers(roomId: string): Promise<string[]> {
    const stage = await this.seats.getSnapshot(roomId);
    if (!stage) return [];
    return stage.seats.map((seat) => seat.occupantUserId).filter((id): id is string => Boolean(id));
  }
}
