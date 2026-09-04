import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GiftContextType, VoicePublishRole } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import {
  AUDIO_ROOM_EVENTS,
  RoomCreatedEvent,
  RoomEndedEvent,
  RoomJoinedEvent,
  RoomLeftEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import {
  AUDIO_ROOM_VOICE_EVENTS,
  VoiceJoinedEvent,
  VoiceLeftEvent,
  VoiceSpeakingChangedEvent,
  VoiceStateEvent,
} from 'src/modules/audio-rooms/events/audio-room-voice.events';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { dateKeyOf } from '../constants/analytics.constants';
import { GLOBAL_ANALYTICS_UUID } from '../services/analytics.service';
import { AnalyticsCountersService } from '../services/analytics-counters.service';
import { AnalyticsRepository } from '../repositories/analytics.repository';

@Injectable()
export class AnalyticsActivityListener implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsActivityListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly repo: AnalyticsRepository,
    private readonly counters: AnalyticsCountersService,
  ) {}

  onModuleInit(): void {
    // 1. Room lifecycle events
    this.bus.subscribe<RoomCreatedEvent>(
      AUDIO_ROOM_EVENTS.CREATED,
      (e) => void this.onRoomCreated(e),
    );
    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) => void this.onRoomEnded(e));

    // 2. Attendance/Visitor events
    this.bus.subscribe<RoomJoinedEvent>(AUDIO_ROOM_EVENTS.JOINED, (e) => void this.onRoomJoined(e));
    this.bus.subscribe<RoomLeftEvent>(AUDIO_ROOM_EVENTS.LEFT, (e) => void this.onRoomLeft(e));

    // 3. Speaking/mic events
    this.bus.subscribe<VoiceJoinedEvent>(
      AUDIO_ROOM_VOICE_EVENTS.JOINED,
      (e) => void this.onVoiceJoined(e),
    );
    this.bus.subscribe<VoiceLeftEvent>(
      AUDIO_ROOM_VOICE_EVENTS.LEFT,
      (e) => void this.onVoiceLeft(e),
    );
    this.bus.subscribe<VoiceStateEvent>(
      AUDIO_ROOM_VOICE_EVENTS.STATE,
      (e) => void this.onVoiceState(e),
    );
    this.bus.subscribe<VoiceSpeakingChangedEvent>(
      AUDIO_ROOM_VOICE_EVENTS.SPEAKING,
      (e) => void this.onSpeakingChanged(e),
    );

    // 4. Gifting/Revenue events
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => void this.onGiftSent(e));
  }

  // ---- Room Lifecycle Handlers ----

  private async onRoomCreated(event: RoomCreatedEvent): Promise<void> {
    const { roomId, ownerId } = event.payload;
    try {
      await this.repo.createRoomActivity(roomId);
      // Live counter: the owner hosted a room today.
      await this.counters.incrCreator(ownerId, dateKeyOf(), 'roomsHosted', 1);
    } catch (err) {
      this.logger.error(
        `Failed to initialize room activity stats for room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  private async onRoomEnded(event: RoomEndedEvent): Promise<void> {
    const { roomId, durationSeconds } = event.payload;
    try {
      await this.repo.updateRoomDuration(roomId, durationSeconds);
    } catch (err) {
      this.logger.error(
        `Failed to update activity duration for room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  // ---- Visitor / Attendance Handlers ----

  private async onRoomJoined(event: RoomJoinedEvent): Promise<void> {
    const { roomId, userId, participantCount } = event.payload;
    try {
      await this.repo.createVisitor(roomId, userId);
      await this.repo.incrementRoomJoins(roomId, participantCount, userId);
      // Live counters: joins, unique visitors, and peak participants for today.
      const dateKey = dateKeyOf();
      await this.counters.incrRoom(roomId, dateKey, 'joins', 1);
      await this.counters.addRoomVisitor(roomId, dateKey, userId);
      await this.counters.bumpRoomPeak(roomId, dateKey, participantCount);
    } catch (err) {
      this.logger.error(
        `Failed to record user join visitor stats for user ${userId} in room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  private async onRoomLeft(event: RoomLeftEvent): Promise<void> {
    const { roomId, userId } = event.payload;
    try {
      await this.repo.closeVisitor(roomId, userId);
    } catch (err) {
      this.logger.error(
        `Failed to close visitor stats for user ${userId} in room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  // ---- Voice / Mic / Speaker Handlers ----

  private async onVoiceJoined(event: VoiceJoinedEvent): Promise<void> {
    const { roomId, userId, role } = event.payload;
    try {
      if (role === VoicePublishRole.PUBLISHER) {
        await this.repo.createSpeakerSession(roomId, userId);
      }
    } catch (err) {
      this.logger.error(
        `Failed to create speaker session for user ${userId} in room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  private async onVoiceLeft(event: VoiceLeftEvent): Promise<void> {
    const { roomId, userId, durationSeconds } = event.payload;
    try {
      // 1. If currently speaking, stop the speaking timer and add remaining duration
      const speakingKey = `analytics:speaking:start:${roomId}:${userId}`;
      const startTime = await this.redis.get(speakingKey);
      let elapsedSeconds = 0;

      if (startTime) {
        elapsedSeconds = Math.max(0, Math.round((Date.now() - Number(startTime)) / 1000));
        await this.redis.del(speakingKey);

        if (elapsedSeconds > 0) {
          await this.repo.incrementRoomSpeaking(roomId, Math.round(elapsedSeconds / 60));
        }
      }

      // 2. Close speaker session
      await this.repo.closeSpeakerSession(roomId, userId, elapsedSeconds);

      // 3. Live counters: seat air-time (voice-session duration) = the chosen
      //    "speaking duration" metric, credited to both room and creator.
      if (durationSeconds > 0) {
        const dateKey = dateKeyOf();
        await this.counters.incrRoom(roomId, dateKey, 'speakingSeconds', durationSeconds);
        await this.counters.incrCreator(userId, dateKey, 'speakingSeconds', durationSeconds);
      }
    } catch (err) {
      this.logger.error(
        `Failed to close speaker session for user ${userId} in room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  private async onVoiceState(event: VoiceStateEvent): Promise<void> {
    const { roomId, userId, role } = event.payload;
    try {
      if (role === VoicePublishRole.PUBLISHER) {
        // User was promoted to speaker seat
        await this.repo.createSpeakerSession(roomId, userId);
      } else {
        // User was demoted from speaker seat (became subscriber/listener)
        const speakingKey = `analytics:speaking:start:${roomId}:${userId}`;
        const startTime = await this.redis.get(speakingKey);
        let elapsedSeconds = 0;

        if (startTime) {
          elapsedSeconds = Math.max(0, Math.round((Date.now() - Number(startTime)) / 1000));
          await this.redis.del(speakingKey);

          if (elapsedSeconds > 0) {
            await this.repo.incrementRoomSpeaking(roomId, Math.round(elapsedSeconds / 60));
          }
        }

        await this.repo.closeSpeakerSession(roomId, userId, elapsedSeconds);
      }
    } catch (err) {
      this.logger.error(
        `Failed to handle voice state change for user ${userId} in room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  private async onSpeakingChanged(event: VoiceSpeakingChangedEvent): Promise<void> {
    const { roomId, userId, isSpeaking } = event.payload;
    const speakingKey = `analytics:speaking:start:${roomId}:${userId}`;

    try {
      if (isSpeaking) {
        await this.redis.set(speakingKey, Date.now().toString());
      } else {
        const startTime = await this.redis.get(speakingKey);
        if (startTime) {
          const elapsedSeconds = Math.max(0, Math.round((Date.now() - Number(startTime)) / 1000));
          await this.redis.del(speakingKey);

          if (elapsedSeconds > 0) {
            await this.repo.incrementSpeakingDuration(roomId, userId, elapsedSeconds);
            await this.repo.incrementRoomSpeaking(roomId, Math.round(elapsedSeconds / 60));
          }
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to process speaking state change for user ${userId} in room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  // ---- Gift / Revenue Handlers ----

  private async onGiftSent(event: GiftSentEvent): Promise<void> {
    const p = event.payload;
    // Strictly AUDIO_ROOM only — video room gifts have their own isolated analytics and repositories.
    if (p.contextType !== GiftContextType.AUDIO_ROOM) return;

    try {
      const dateKey = dateKeyOf();

      // 1. If sent in an audio room, increment room-level stats
      await this.repo.incrementRoomGifts(p.contextId, p.totalCoinValue);

      // Track Room Revenue
      await this.repo.upsertRevenueReport(
        dateKey,
        p.contextId,
        GLOBAL_ANALYTICS_UUID,
        p.totalCoinValue,
        p.creatorEarnings,
      );

      // Live counters: room gift revenue.
      await this.counters.incrRoom(p.contextId, dateKey, 'giftCoins', p.totalCoinValue);
      await this.counters.incrRoom(p.contextId, dateKey, 'giftCount', 1);

      // 2. Track Creator Revenue
      await this.repo.upsertRevenueReport(
        dateKey,
        GLOBAL_ANALYTICS_UUID,
        p.receiverId,
        p.totalCoinValue,
        p.creatorEarnings,
      );

      // Live counters: creator revenue (gifts received + earnings).
      await this.counters.incrCreator(p.receiverId, dateKey, 'giftsReceivedCount', 1);
      await this.counters.incrCreator(p.receiverId, dateKey, 'giftCoinsReceived', p.totalCoinValue);
      await this.counters.incrCreator(p.receiverId, dateKey, 'creatorEarnings', p.creatorEarnings);

      // 3. Track Global/Platform Revenue
      await this.repo.upsertRevenueReport(
        dateKey,
        GLOBAL_ANALYTICS_UUID,
        GLOBAL_ANALYTICS_UUID,
        p.totalCoinValue,
        p.creatorEarnings,
      );
    } catch (err) {
      this.logger.error(
        `Failed to process revenue metrics for gift ${p.transactionId}: ${(err as Error).message}`,
      );
    }
  }
}
