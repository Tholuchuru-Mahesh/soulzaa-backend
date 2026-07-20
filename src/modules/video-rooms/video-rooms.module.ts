import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { VIDEO_ROOM_QUEUES } from './constants/video-room.constants';
import { VideoRoomsMediaController } from './controllers/video-rooms-media.controller';
import { VideoRoomMembersController } from './controllers/video-rooms-members.controller';
import { VideoRoomSeatsController } from './controllers/video-rooms-seats.controller';
import { VideoRoomViewersController } from './controllers/video-rooms-viewers.controller';
import { VideoRoomsController } from './controllers/video-rooms.controller';
import { MEDIA_PROVIDER } from './interfaces/media-provider.interface';
import { VIEWER_PRESENCE } from './interfaces/viewer-presence.interface';
import { VIDEO_ROOMS_SERVICE } from './interfaces/video-rooms.service.interface';
import { VideoRoomMediaLifecycleListener } from './listeners/video-room-media-lifecycle.listener';
import { VideoRoomMediaMetricsListener } from './listeners/video-room-media-metrics.listener';
import { VideoRoomMediaSocketListener } from './listeners/video-room-media-socket.listener';
import { VideoRoomPresenceListener } from './listeners/video-room-presence.listener';
import { VideoRoomSeatLifecycleListener } from './listeners/video-room-seat-lifecycle.listener';
import { VideoRoomSeatMetricsListener } from './listeners/video-room-seat-metrics.listener';
import { VideoRoomSeatSocketListener } from './listeners/video-room-seat-socket.listener';
import { VideoRoomSocketListener } from './listeners/video-room-socket.listener';
import { MediaTokenService } from './media/media-token.service';
import { ZegoMediaProvider } from './media/zego-media.provider';
import { VideoRoomEventsRepository } from './repositories/video-room-events.repository';
import { VideoRoomMediaSessionRepository } from './repositories/video-room-media-session.repository';
import { VideoRoomModerationRepository } from './repositories/video-room-moderation.repository';
import { VideoRoomReferenceRepository } from './repositories/video-room-reference.repository';
import { VideoRoomRolesRepository } from './repositories/video-room-roles.repository';
import { VideoRoomSeatsRepository } from './repositories/video-room-seats.repository';
import { VideoRoomsRepository } from './repositories/video-rooms.repository';
import { VideoRoomMediaMonitor } from './scheduler/video-room-media.monitor';
import { VideoRoomSeatMonitor } from './scheduler/video-room-seat.monitor';
import { VideoRoomSessionMonitor } from './scheduler/video-room-session.monitor';
import { VideoRoomEventService } from './services/video-room-event.service';
import { VideoRoomLifecycleService } from './services/video-room-lifecycle.service';
import { VideoRoomMediaRecoveryService } from './services/video-room-media-recovery.service';
import { VideoRoomMediaStateService } from './services/video-room-media-state.service';
import { VideoRoomMediaService } from './services/video-room-media.service';
import { VideoRoomMemberService } from './services/video-room-member.service';
import { VideoRoomPasswordService } from './services/video-room-password.service';
import { VideoRoomPermissionService } from './services/video-room-permission.service';
import { VideoRoomPresenceService } from './services/video-room-presence.service';
import { VideoRoomQueryService } from './services/video-room-query.service';
import { VideoRoomReferenceSeederService } from './services/video-room-reference-seeder.service';
import { VideoRoomSeatInvitationService } from './services/video-room-seat-invitation.service';
import { VideoRoomSeatRequestService } from './services/video-room-seat-request.service';
import { VideoRoomSeatReservationService } from './services/video-room-seat-reservation.service';
import { VideoRoomSeatStateService } from './services/video-room-seat-state.service';
import { VideoRoomSeatService } from './services/video-room-seat.service';
import { VideoRoomSessionService } from './services/video-room-session.service';
import { VideoRoomStateService } from './services/video-room-state.service';
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
