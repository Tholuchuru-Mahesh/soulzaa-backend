import { Global, Module } from '@nestjs/common';
import { AudioRoomSeatsController } from './controllers/audio-room-seats.controller';
import { AudioRoomsController } from './controllers/audio-rooms.controller';
import { ChatController } from './controllers/chat.controller';
import { ChatAdminController } from './controllers/chat-admin.controller';
import { ModerationController } from './controllers/moderation.controller';
import { PkBattleController } from './controllers/pk-battle.controller';
import { PremiumSeatController } from './controllers/premium-seat.controller';
import { RoomAppearanceController } from './controllers/room-appearance.controller';
import { VoiceController } from './controllers/voice.controller';
import { WatchPartyController } from './controllers/watch-party.controller';
import { AudioRoomsAdminController } from './controllers/audio-rooms-admin.controller';
import { AUDIO_ROOMS_SERVICE } from './interfaces/audio-rooms.service.interface';
import { AUDIO_ROOM_CHAT_SERVICE } from './interfaces/chat.service.interface';
import { MODERATION_SERVICE } from './interfaces/moderation.service.interface';
import { PK_BATTLE_SERVICE } from './interfaces/pk-battle.service.interface';
import { VOICE_SERVICE } from './interfaces/voice.service.interface';
import { AudioRoomSeatsListener } from './listeners/audio-room-seats.listener';
import { AudioRoomSocketListener } from './listeners/audio-room-socket.listener';
import { ChatSocketListener } from './listeners/chat-socket.listener';
import { GiftSocketListener } from './listeners/gift-socket.listener';
import { LuckyPacketSocketListener } from './listeners/lucky-packet-socket.listener';
import { ModerationSocketListener } from './listeners/moderation-socket.listener';
import { RoomUtilitiesSocketListener } from './listeners/room-utilities-socket.listener';
import { PkGiftListener } from './listeners/pk-gift.listener';
import { PkSocketListener } from './listeners/pk-socket.listener';
import { PremiumSocketListener } from './listeners/premium-socket.listener';
import { ProgressionSocketListener } from './listeners/progression-socket.listener';
import { RoomCosmeticsSocketListener } from './listeners/room-cosmetics-socket.listener';
import { TreasureSocketListener } from './listeners/treasure-socket.listener';
import { VoiceLifecycleListener } from './listeners/voice-lifecycle.listener';
import { VoiceSeatSyncListener } from './listeners/voice-seat-sync.listener';
import { VoiceSocketListener } from './listeners/voice-socket.listener';
import { AudioRoomSeatsRepository } from './repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from './repositories/audio-rooms.repository';
import { ChatRepository } from './repositories/chat.repository';
import { LiveSessionRepository } from './repositories/live-session.repository';
import { ModerationRepository } from './repositories/moderation.repository';
import { PkBattleRepository } from './repositories/pk-battle.repository';
import { PremiumSeatRepository } from './repositories/premium-seat.repository';
import { RoomAppearanceRepository } from './repositories/room-appearance.repository';
import { WatchPartyRepository } from './repositories/watch-party.repository';
import { VoiceSessionRepository } from './repositories/voice-session.repository';
import { AudioRoomGiftContextHandler } from './services/audio-room-gift-context.handler';
import { AudioRoomSeatsService } from './services/audio-room-seats.service';
import { AudioRoomsService } from './services/audio-rooms.service';
import { ChatService } from './services/chat.service';
import { ModerationExpiryMonitor } from './services/moderation-expiry.monitor';
import { ModerationService } from './services/moderation.service';
import { PkBattleService } from './services/pk-battle.service';
import { PkExpiryMonitor } from './services/pk-expiry.monitor';
import { PremiumSeatExpiryMonitor } from './services/premium-seat-expiry.monitor';
import { PremiumSeatService } from './services/premium-seat.service';
import { RoomAppearanceService } from './services/room-appearance.service';
import { RoomPasswordService } from './services/room-password.service';
import { WatchPartyService } from './services/watch-party.service';
import { RoomPermissionService } from './services/room-permission.service';
import { RoomReferenceSeeder } from './services/room-reference-seeder.service';
import { VoiceHeartbeatMonitor } from './services/voice-heartbeat.monitor';
import { VoiceService } from './services/voice.service';

/**
 * Audio Rooms domain — room lifecycle (AR-0) + role & seat system (AR-1) +
 * ZEGOCLOUD voice layer (AR-2).
 *
 * AR-0: create/edit/delete/end, join/leave, ownership transfer, lock/password,
 * categories, languages, discovery + trending.
 * AR-1: RBAC (Owner/Admin/Premium Admin/Speaker/Listener via room_roles +
 * ROOM_PERMISSION_MATRIX), a configurable seat stage, and mic-request /
 * invitation / queue workflows with per-seat lock + mute and room-mute.
 * AR-2: ZEGOCLOUD token issuance + the voice-session lifecycle (join/leave/mute/
 * heartbeat/quality/reconnect), Redis voice presence + active-speaker detection,
 * a heartbeat-timeout monitor, and immutable voice_session_logs. Publish role
 * follows seat state (VoiceSeatSyncListener); `voice.*` fan-out flows through
 * EVENT_BUS → VoiceSocketListener.
 *
 * AR-3: moderation (kick, temp/permanent ban, member mute, report, notes,
 * appeals) with a role-hierarchy guard + platform-moderator authority, immutable
 * moderation_actions audit, Redis ban/mute enforcement caches, an expiry monitor,
 * and realtime `room.*`/`member.*` fan-out via ModerationSocketListener. The join
 * gate rejects banned users; self-unmute is blocked while moderator-muted.
 *
 * Owns the audio_rooms / room_* / seat_* / voice_* / moderation tables and the
 * Redis room-, stage-, voice-state and ban/mute caches.
 *
 * @Global so later phases resolve AUDIO_ROOMS_SERVICE / VOICE_SERVICE /
 * MODERATION_SERVICE by token without importing this module (cross-module access
 * only via `interfaces/` or EVENT_BUS).
 */
@Global()
@Module({
  controllers: [
    AudioRoomsController,
    AudioRoomSeatsController,
    VoiceController,
    ModerationController,
    ChatController,
    ChatAdminController,
    RoomAppearanceController,
    PremiumSeatController,
    WatchPartyController,
    PkBattleController,
    AudioRoomsAdminController,
  ],
  providers: [
    AudioRoomsRepository,
    AudioRoomSeatsRepository,
    VoiceSessionRepository,
    ModerationRepository,
    ChatRepository,
    RoomAppearanceRepository,
    PremiumSeatRepository,
    WatchPartyRepository,
    PkBattleRepository,
    LiveSessionRepository,
    AudioRoomsService,
    AudioRoomSeatsService,
    // VR-10: registers the AUDIO_ROOM gift context on the shared registry.
    AudioRoomGiftContextHandler,
    RoomAppearanceService,
    PremiumSeatService,
    PremiumSeatExpiryMonitor,
    WatchPartyService,
    PkBattleService,
    PkExpiryMonitor,
    RoomPermissionService,
    RoomPasswordService,
    RoomReferenceSeeder,
    VoiceService,
    VoiceHeartbeatMonitor,
    ModerationService,
    ModerationExpiryMonitor,
    ChatService,
    AudioRoomSocketListener,
    AudioRoomSeatsListener,
    VoiceSocketListener,
    VoiceSeatSyncListener,
    VoiceLifecycleListener,
    ModerationSocketListener,
    ChatSocketListener,
    GiftSocketListener,
    TreasureSocketListener,
    LuckyPacketSocketListener,
    RoomUtilitiesSocketListener,
    ProgressionSocketListener,
    RoomCosmeticsSocketListener,
    PremiumSocketListener,
    PkGiftListener,
    PkSocketListener,
    { provide: AUDIO_ROOMS_SERVICE, useExisting: AudioRoomsService },
    { provide: VOICE_SERVICE, useExisting: VoiceService },
    { provide: MODERATION_SERVICE, useExisting: ModerationService },
    { provide: AUDIO_ROOM_CHAT_SERVICE, useExisting: ChatService },
    { provide: PK_BATTLE_SERVICE, useExisting: PkBattleService },
  ],
  exports: [
    AUDIO_ROOMS_SERVICE,
    VOICE_SERVICE,
    MODERATION_SERVICE,
    AUDIO_ROOM_CHAT_SERVICE,
    PK_BATTLE_SERVICE,
  ],
})
export class AudioRoomsModule {}
