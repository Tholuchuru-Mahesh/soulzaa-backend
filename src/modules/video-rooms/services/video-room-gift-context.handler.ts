import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GiftContextType, VideoRoomMemberRole, VideoRoomStatus } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type {
  GiftContextRequest,
  GiftEconomics,
  IGiftContextHandler,
} from 'src/modules/gifts/interfaces/gift-context-handler.interface';
import { GiftContextRegistry } from 'src/modules/gifts/services/gift-context.registry';
import { loadVideoRoomGiftConfig } from '../config/video-room-gift.config';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

/**
 * The VIDEO_ROOM gift context (VR-10).
 *
 * Deliberately has NO `onSend`: video rooms have no in-transaction side effects
 * (no treasure box this phase), so the send transaction stays a debit, N credits
 * and N ledger rows — nothing else inside the ACID boundary.
 *
 * Gifting is gated by membership + room settings, not by the RBAC permission
 * matrix. That matrix is management-only — HOST/PARTICIPANT/VIEWER all map to
 * empty permission sets — so adding SEND_GIFT there would mean granting it to
 * all six roles, which encodes nothing.
 */
@Injectable()
export class VideoRoomGiftContextHandler implements IGiftContextHandler, OnModuleInit {
  readonly contextType = GiftContextType.VIDEO_ROOM;

  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly config: ConfigService,
    private readonly registry: GiftContextRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Configured recipient cap; the resolver also enforces it before we get here. */
  get maxReceivers(): number {
    return loadVideoRoomGiftConfig(this.config).maxReceivers;
  }

  async validate(req: GiftContextRequest): Promise<void> {
    const { contextId: roomId, senderId, receiverIds } = req;

    if (receiverIds.length > this.maxReceivers) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
        `A gift may target at most ${this.maxReceivers} recipients.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }

    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowGifts) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_GIFTS_DISABLED,
        'Gifting is disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    // A blocked sender may still hold a stale membership row; check explicitly.
    if (await this.moderation.findActiveBlock(roomId, senderId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'You are blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    const sender = await this.rooms.getMember(roomId, senderId);
    if (!sender?.isActive) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_MEMBER,
        'You are not in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    this.assertCountryAllowed(sender.country);

    const allowViewerGifts = this.viewerGiftsAllowed(settings?.metadata);
    for (const receiverId of receiverIds) {
      const receiver = await this.rooms.getMember(roomId, receiverId);
      if (!receiver?.isActive) {
        throw new BusinessException(
          ERROR_CODES.GIFT_RECEIVER_INVALID,
          'A recipient is not in this room.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!allowViewerGifts && receiver.role === VideoRoomMemberRole.VIEWER) {
        throw new BusinessException(
          ERROR_CODES.GIFT_RECEIVER_INVALID,
          'This room does not allow gifting viewers.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }

  /**
   * Video rooms pay creator earnings: the receiver is credited the configured
   * rate of their own gift's value into EARNINGS. Returned in basis points so
   * the pipeline never has to know about percentages.
   */
  economics(_req: GiftContextRequest): GiftEconomics {
    const rate = Number(
      this.config.get<{ creatorEarningRatePercent: number }>('gift')?.creatorEarningRatePercent ??
        0,
    );
    return { receiverEarningsBps: Math.round(rate * 100) };
  }

  /**
   * Regulatory country gate. The sender's country is the one captured on their
   * membership row at join time — not a request header — so a client cannot
   * spoof its way past the restriction.
   *
   * Platform-level rather than per-gift: the `gifts` table has neither a country
   * nor a metadata column, so per-gift country rules would require a migration,
   * which this phase forbids. A member with no recorded country is allowed
   * through; blocking on unknown would bar every pre-existing member.
   */
  private assertCountryAllowed(country: string | null | undefined): void {
    if (!country) return;
    const blocked = loadVideoRoomGiftConfig(this.config).blockedCountries;
    if (blocked.includes(country.trim().toUpperCase())) {
      throw new BusinessException(
        ERROR_CODES.GIFT_COUNTRY_RESTRICTED,
        'Gifting is not available in your region.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Per-room override of viewer gifting, stored in settings metadata (the VR-2
   * precedent for policy flags that don't warrant a column).
   */
  private viewerGiftsAllowed(metadata: unknown): boolean {
    const fallback = loadVideoRoomGiftConfig(this.config).allowViewerGiftsDefault;
    if (!metadata || typeof metadata !== 'object') return fallback;
    const value = (metadata as Record<string, unknown>).allowViewerGifts;
    return typeof value === 'boolean' ? value : fallback;
  }
}
