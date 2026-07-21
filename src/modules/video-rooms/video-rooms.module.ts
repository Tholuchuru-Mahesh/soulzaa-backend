import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { VIDEO_ROOM_QUEUES } from './constants/video-room.constants';
import { VideoRoomsChatController } from './controllers/video-rooms-chat.controller';
import { VideoRoomsMediaController } from './controllers/video-rooms-media.controller';
import { VideoRoomMembersController } from './controllers/video-rooms-members.controller';
import { VideoRoomSeatsController } from './controllers/video-rooms-seats.controller';
import { VideoRoomViewersController } from './controllers/video-rooms-viewers.controller';
import { VideoRoomsController } from './controllers/video-rooms.controller';
import { VideoRoomChatGateway } from './gateway/video-room-chat.gateway';
import { MEDIA_PROVIDER } from './interfaces/media-provider.interface';
import { VIEWER_PRESENCE } from './interfaces/viewer-presence.interface';
import { VIDEO_ROOMS_SERVICE } from './interfaces/video-rooms.service.interface';
import { VideoRoomMediaLifecycleListener } from './listeners/video-room-media-lifecycle.listener';
import { VideoRoomMediaMetricsListener } from './listeners/video-room-media-metrics.listener';
import { VideoRoomMediaSocketListener } from './listeners/video-room-media-socket.listener';
import { VideoRoomChatAuditListener } from './listeners/video-room-chat-audit.listener';
import { VideoRoomChatMetricsListener } from './listeners/video-room-chat-metrics.listener';
import { VideoRoomChatSocketListener } from './listeners/video-room-chat-socket.listener';
import { VideoRoomChatSystemListener } from './listeners/video-room-chat-system.listener';
import { VideoRoomPresenceListener } from './listeners/video-room-presence.listener';
import { VideoRoomSeatLifecycleListener } from './listeners/video-room-seat-lifecycle.listener';
import { VideoRoomSeatMetricsListener } from './listeners/video-room-seat-metrics.listener';
import { VideoRoomSeatQueueListener } from './listeners/video-room-seat-queue.listener';
import { VideoRoomSeatSocketListener } from './listeners/video-room-seat-socket.listener';
import { VideoRoomSeatWorkflowMetricsListener } from './listeners/video-room-seat-workflow-metrics.listener';
import { VideoRoomSocketListener } from './listeners/video-room-socket.listener';
import { MediaTokenService } from './media/media-token.service';
import { ZegoMediaProvider } from './media/zego-media.provider';
import { VideoRoomChatRepository } from './repositories/video-room-chat.repository';
import { VideoRoomEventsRepository } from './repositories/video-room-events.repository';
import { VideoRoomMediaSessionRepository } from './repositories/video-room-media-session.repository';
import { VideoRoomModerationRepository } from './repositories/video-room-moderation.repository';
import { VideoRoomReferenceRepository } from './repositories/video-room-reference.repository';
import { VideoRoomRolesRepository } from './repositories/video-room-roles.repository';
import { VideoRoomRolesController } from './controllers/video-rooms-roles.controller';
import { VideoRoomPermissionCache } from './services/video-room-permission-cache.service';
import { VideoRoomRoleService } from './services/video-room-role.service';
import { VideoRoomOwnershipService } from './services/video-room-ownership.service';
import { VideoRoomRoleMonitor } from './scheduler/video-room-role.monitor';
import { VideoRoomRoleSocketListener } from './listeners/video-room-role-socket.listener';
import { VideoRoomRoleMetricsListener } from './listeners/video-room-role-metrics.listener';
import { VideoRoomSeatsRepository } from './repositories/video-room-seats.repository';
import { VideoRoomsRepository } from './repositories/video-rooms.repository';
import { VideoRoomMediaMonitor } from './scheduler/video-room-media.monitor';
import { VideoRoomSeatMonitor } from './scheduler/video-room-seat.monitor';
import { VideoRoomSessionMonitor } from './scheduler/video-room-session.monitor';
import { VideoRoomAnnouncementService } from './services/video-room-announcement.service';
import { VideoRoomChatCacheService } from './services/video-room-chat-cache.service';
import { VideoRoomChatPinService } from './services/video-room-chat-pin.service';
import { VideoRoomChatPolicyService } from './services/video-room-chat-policy.service';
import { VideoRoomChatQueryService } from './services/video-room-chat-query.service';
import { VideoRoomChatRateLimiter } from './services/video-room-chat-rate-limiter.service';
import { VideoRoomChatReceiptService } from './services/video-room-chat-receipt.service';
import { VideoRoomChatSettingsService } from './services/video-room-chat-settings.service';
import { VideoRoomChatService } from './services/video-room-chat.service';
import { VideoRoomEventService } from './services/video-room-event.service';
import { VideoRoomLifecycleService } from './services/video-room-lifecycle.service';
import { VideoRoomMediaRecoveryService } from './services/video-room-media-recovery.service';
import { VideoRoomMediaStateService } from './services/video-room-media-state.service';
import { VideoRoomMediaService } from './services/video-room-media.service';
import { VideoRoomMemberService } from './services/video-room-member.service';
import { VideoRoomMentionResolver } from './services/video-room-mention-resolver.service';
import { VideoRoomPasswordService } from './services/video-room-password.service';
import { VideoRoomPermissionService } from './services/video-room-permission.service';
import { VideoRoomPresenceService } from './services/video-room-presence.service';
import { VideoRoomQueryService } from './services/video-room-query.service';
import { VideoRoomReferenceSeederService } from './services/video-room-reference-seeder.service';
import { VideoRoomSeatInvitationService } from './services/video-room-seat-invitation.service';
import { VideoRoomSeatQueueService } from './services/video-room-seat-queue.service';
import { VideoRoomSeatRequestService } from './services/video-room-seat-request.service';
import { VideoRoomSeatReservationService } from './services/video-room-seat-reservation.service';
import { VideoRoomSeatStateService } from './services/video-room-seat-state.service';
import { VideoRoomSeatService } from './services/video-room-seat.service';
import { VideoRoomSessionService } from './services/video-room-session.service';
import { VideoRoomStateService } from './services/video-room-state.service';
import { VideoRoomSystemMessageService } from './services/video-room-system-message.service';
import { VideoRoomTypingService } from './services/video-room-typing.service';
import { DurableViewerPresence } from './services/durable-viewer-presence.service';
import { VideoRoomViewerQueryService } from './services/video-room-viewer-query.service';
import { VideoRoomViewerService } from './services/video-room-viewer.service';
import { VideoRoomsService } from './services/video-rooms.service';
import { VideoRoomsMetrics } from './video-rooms.metrics';

/**
 * Video Rooms domain — VR-0: Enterprise Foundation.
 *
 * VR-0 lands the durable system-of-record (video_rooms + settings/members/
 * statistics/presence/logs, reusing the shared room_categories/room_languages),
 * the ZEGOCLOUD media seam (IMediaProvider port + ZegoMediaProvider adapter over
 * the shared ZegoTokenService), the versioned room-state / session / presence
 * managers built on the infra Redis + lock primitives, the EVENT_BUS →
 * `/video-room` socket relay, the lock-guarded session-expiry sweep, Prometheus
 * metrics, and the fully-documented REST skeleton (every route returns 501 until
 * the lifecycle phase). No room business workflow is implemented here.
 *
 * Reuses every existing @Global infrastructure (Prisma, Redis, Zego, Socket,
 * EventBus, Metrics, Config, guards) — it only registers its own BullMQ queues.
 *
 * @Global so later phases resolve VIDEO_ROOMS_SERVICE by token without importing
 * this module (cross-module access only via `interfaces/` or the EVENT_BUS).
 */
@Global()
@Module({
  imports: [
    // Register the lean queue producers now; workers land with their phases.
    BullModule.registerQueue({ name: VIDEO_ROOM_QUEUES.MAIN }, { name: VIDEO_ROOM_QUEUES.CLEANUP }),
  ],
  controllers: [
    VideoRoomsController,
    VideoRoomMembersController,
    VideoRoomSeatsController,
    VideoRoomsMediaController,
    VideoRoomViewersController,
    VideoRoomRolesController,
    VideoRoomsChatController,
  ],
  providers: [
    VideoRoomsRepository,
    // VR-1 domain repositories (pure persistence for the seat/role/moderation/
    // media-session/event/reference tables). Services consuming them land per phase.
    VideoRoomRolesRepository,
    VideoRoomSeatsRepository,
    VideoRoomModerationRepository,
    VideoRoomMediaSessionRepository,
    VideoRoomEventsRepository,
    VideoRoomReferenceRepository,
    VideoRoomReferenceSeederService,
    VideoRoomsService,
    // VR-2 lifecycle (CQRS-ready command + query split, RBAC gate, password hashing).
    VideoRoomLifecycleService,
    VideoRoomQueryService,
    VideoRoomPermissionService,
    VideoRoomPasswordService,
    VideoRoomStateService,
    VideoRoomSessionService,
    VideoRoomPresenceService,
    VideoRoomEventService,
    // VR-3 participant lifecycle (join/leave/reconnect/heartbeat/presence/sync).
    VideoRoomMemberService,
    MediaTokenService,
    ZegoMediaProvider,
    VideoRoomSessionMonitor,
    VideoRoomsMetrics,
    VideoRoomSocketListener,
    VideoRoomPresenceListener,
    // VR-4 multi-seat engine (Redis-authoritative versioned stage + workflows).
    VideoRoomSeatStateService,
    VideoRoomSeatService,
    VideoRoomSeatReservationService,
    VideoRoomSeatRequestService,
    VideoRoomSeatInvitationService,
    VideoRoomSeatSocketListener,
    VideoRoomSeatMetricsListener,
    VideoRoomSeatLifecycleListener,
    VideoRoomSeatMonitor,
    // VR-8 seat request/invitation workflow (queue projection + auto-advance).
    VideoRoomSeatQueueService,
    VideoRoomSeatQueueListener,
    VideoRoomSeatWorkflowMetricsListener,
    // VR-5 media engine
    VideoRoomMediaStateService,
    VideoRoomMediaService,
    VideoRoomMediaRecoveryService,
    VideoRoomMediaSocketListener,
    VideoRoomMediaMetricsListener,
    VideoRoomMediaLifecycleListener,
    VideoRoomMediaMonitor,
    // VR-6 viewer mode (audience facade + read model over the VR-3/VR-4 engines).
    DurableViewerPresence,
    VideoRoomViewerService,
    VideoRoomViewerQueryService,
    // VR-7 role & permission engine (assignment, ownership, versioned cache,
    // temporary-grant sweep, realtime + metrics fan-out).
    VideoRoomPermissionCache,
    VideoRoomRoleService,
    VideoRoomOwnershipService,
    VideoRoomRoleMonitor,
    VideoRoomRoleSocketListener,
    VideoRoomRoleMetricsListener,
    // VR-9 chat (REST commands + ephemeral socket signals, Redis read model,
    // policy gate, announcements over the VR-1 table, system messages).
    VideoRoomChatRepository,
    VideoRoomChatCacheService,
    VideoRoomChatRateLimiter,
    VideoRoomMentionResolver,
    VideoRoomChatPolicyService,
    VideoRoomChatService,
    VideoRoomChatQueryService,
    VideoRoomChatPinService,
    VideoRoomChatSettingsService,
    VideoRoomAnnouncementService,
    VideoRoomTypingService,
    VideoRoomChatReceiptService,
    VideoRoomSystemMessageService,
    VideoRoomChatGateway,
    VideoRoomChatSocketListener,
    VideoRoomChatSystemListener,
    VideoRoomChatMetricsListener,
    VideoRoomChatAuditListener,
    // The media seam: business code depends on IMediaProvider, bound to Zego here.
    { provide: MEDIA_PROVIDER, useExisting: ZegoMediaProvider },
    // The audience seam: durable (member-is-viewer) is the only impl for VR-6;
    // an ephemeral (Redis-only) impl swaps in later via a mode-aware useFactory.
    { provide: VIEWER_PRESENCE, useExisting: DurableViewerPresence },
    // The only exported cross-module surface.
    { provide: VIDEO_ROOMS_SERVICE, useExisting: VideoRoomsService },
  ],
  exports: [VIDEO_ROOMS_SERVICE],
})
export class VideoRoomsModule {}
