import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from 'src/infra/observability/metrics.service';

/**
 * Prometheus metrics for the video-room domain, registered on the shared
 * MetricsService registry so they are exposed at GET /metrics (mirrors the infra
 * MonitoringMetrics / queue QueueMetrics pattern). VR-0 registers the families
 * (they report 0 until data flows); later phases call the set/inc helpers as
 * rooms go live, viewers connect, and sessions reconnect. Redis/socket latency is
 * already emitted by infra MonitoringMetrics — reused, not duplicated here.
 */
@Injectable()
export class VideoRoomsMetrics {
  private readonly liveRooms: Gauge;
  private readonly viewers: Gauge;
  private readonly peakViewers: Gauge;
  private peakViewersSeen = 0;
  private readonly hosts: Gauge;
  private readonly sessions: Gauge;
  private readonly heartbeatFailures: Counter;
  private readonly reconnects: Counter;
  private readonly created: Counter;
  private readonly deleted: Counter;
  private readonly locked: Counter;
  private readonly joins: Counter;
  private readonly leaves: Counter;
  private readonly duplicateSessions: Counter;
  private readonly reconnectFailures: Counter;
  private readonly sessionDuration: Histogram;
  // ---- VR-4 seats ----
  private readonly occupiedSeats: Gauge;
  private readonly lockedSeats: Gauge;
  private readonly seatRequests: Counter;
  private readonly seatInvitations: Counter;
  private readonly seatTransfers: Counter;
  private readonly seatSwitches: Counter;
  private readonly reservationTimeouts: Counter;
  // ---- VR-5 media ----
  private readonly mediaActiveStreams: Gauge;
  private readonly mediaPublishingUsers: Gauge;
  private readonly mediaSubscribedUsers: Gauge;
  private readonly mediaSessionsC: Counter;
  private readonly mediaTokensC: Counter;
  private readonly mediaPublishC: Counter;
  private readonly mediaPublishFailC: Counter;
  private readonly mediaFailC: Counter;
  private readonly mediaRecoveryC: Counter;
  private readonly mediaReconnectC: Counter;
  private readonly mediaBitrateC: Counter;
  private readonly mediaCameraC: Counter;
  private readonly mediaMicC: Counter;
  private readonly mediaBeautyC: Counter;
  private readonly mediaJoinH: Histogram;
  private readonly mediaPublishH: Histogram;
  private readonly mediaSubscribeH: Histogram;
  private readonly mediaSessionDurH: Histogram;
  private readonly mediaQualityG: Gauge;
  // ---- VR-6 viewer promote/demote ----
  private readonly viewerPromotions: Counter;
  private readonly viewerDemotions: Counter;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.liveRooms = new Gauge({
      name: 'video_rooms_live_total',
      help: 'Video rooms currently LIVE',
      registers,
    });
    this.viewers = new Gauge({
      name: 'video_rooms_viewers_total',
      help: 'Video-room audience members currently connected',
      registers,
    });
    this.peakViewers = new Gauge({
      name: 'video_rooms_peak_viewers',
      help: 'Video-room peak concurrent viewers observed (fleet-wide high-water mark)',
      registers,
    });
    this.hosts = new Gauge({
      name: 'video_rooms_hosts_total',
      help: 'Video-room hosts currently connected',
      registers,
    });
    this.sessions = new Gauge({
      name: 'video_rooms_sessions_total',
      help: 'Active video-room client sessions',
      registers,
    });
    this.heartbeatFailures = new Counter({
      name: 'video_rooms_heartbeat_failures_total',
      help: 'Video-room session heartbeats that failed / expired',
      registers,
    });
    this.reconnects = new Counter({
      name: 'video_rooms_reconnects_total',
      help: 'Video-room client reconnects',
      registers,
    });
    this.created = new Counter({
      name: 'video_rooms_created_total',
      help: 'Video rooms created (lifecycle)',
      registers,
    });
    this.deleted = new Counter({
      name: 'video_rooms_deleted_total',
      help: 'Video rooms soft-deleted (lifecycle)',
      registers,
    });
    this.locked = new Counter({
      name: 'video_rooms_locked_total',
      help: 'Video rooms locked (lifecycle)',
      registers,
    });
    this.joins = new Counter({
      name: 'video_rooms_joins_total',
      help: 'Video-room member joins',
      registers,
    });
    this.leaves = new Counter({
      name: 'video_rooms_leaves_total',
      help: 'Video-room member leaves (clean + reclaimed)',
      registers,
    });
    this.duplicateSessions = new Counter({
      name: 'video_rooms_duplicate_sessions_total',
      help: 'Video-room duplicate sessions evicted (per-device)',
      registers,
    });
    this.reconnectFailures = new Counter({
      name: 'video_rooms_reconnect_failures_total',
      help: 'Video-room reconnect attempts that failed (session already reclaimed)',
      registers,
    });
    this.sessionDuration = new Histogram({
      name: 'video_rooms_session_duration_seconds',
      help: 'Video-room member session duration (join → leave/reclaim)',
      registers,
      buckets: [5, 30, 60, 300, 900, 1800, 3600, 7200],
    });
    this.occupiedSeats = new Gauge({
      name: 'video_rooms_seats_occupied',
      help: 'Video-room seats currently occupied (fleet-wide)',
      registers,
    });
    this.lockedSeats = new Gauge({
      name: 'video_rooms_seats_locked',
      help: 'Video-room seats currently locked (fleet-wide)',
      registers,
    });
    this.seatRequests = new Counter({
      name: 'video_rooms_seat_requests_total',
      help: 'Video-room seat requests created',
      registers,
    });
    this.seatInvitations = new Counter({
      name: 'video_rooms_seat_invitations_total',
      help: 'Video-room seat invitations sent',
      registers,
    });
    this.seatTransfers = new Counter({
      name: 'video_rooms_seat_transfers_total',
      help: 'Video-room seat transfers (admin-moved occupants)',
      registers,
    });
    this.seatSwitches = new Counter({
      name: 'video_rooms_seat_switches_total',
      help: 'Video-room seat switches (self-moved occupants)',
      registers,
    });
    this.reservationTimeouts = new Counter({
      name: 'video_rooms_seat_reservation_timeouts_total',
      help: 'Video-room seat reservations released by TTL expiry',
      registers,
    });
    // ---- VR-5 media ----
    this.mediaActiveStreams = new Gauge({
      name: 'video_rooms_media_active_streams',
      help: 'Currently live media streams',
      registers,
    });
    this.mediaPublishingUsers = new Gauge({
      name: 'video_rooms_media_publishing_users',
      help: 'Users currently publishing',
      registers,
    });
    this.mediaSubscribedUsers = new Gauge({
      name: 'video_rooms_media_subscribed_users',
      help: 'Users currently subscribing',
      registers,
    });
    this.mediaSessionsC = new Counter({
      name: 'video_rooms_media_sessions_total',
      help: 'Media sessions started',
      registers,
    });
    this.mediaTokensC = new Counter({
      name: 'video_rooms_media_tokens_issued_total',
      help: 'Media tokens issued',
      registers,
    });
    this.mediaPublishC = new Counter({
      name: 'video_rooms_media_publish_total',
      help: 'Stream publishes',
      registers,
    });
    this.mediaPublishFailC = new Counter({
      name: 'video_rooms_media_publish_failures_total',
      help: 'Stream publish failures',
      registers,
    });
    this.mediaFailC = new Counter({
      name: 'video_rooms_media_failures_total',
      help: 'Media failures',
      registers,
    });
    this.mediaRecoveryC = new Counter({
      name: 'video_rooms_media_recovery_success_total',
      help: 'Successful media recoveries',
      registers,
    });
    this.mediaReconnectC = new Counter({
      name: 'video_rooms_media_reconnect_total',
      help: 'Media reconnects',
      registers,
    });
    this.mediaBitrateC = new Counter({
      name: 'video_rooms_media_bitrate_changes_total',
      help: 'Adaptive bitrate changes',
      registers,
    });
    this.mediaCameraC = new Counter({
      name: 'video_rooms_media_camera_toggles_total',
      help: 'Camera on/off toggles',
      registers,
    });
    this.mediaMicC = new Counter({
      name: 'video_rooms_media_mic_toggles_total',
      help: 'Mic on/off toggles',
      registers,
    });
    this.mediaBeautyC = new Counter({
      name: 'video_rooms_media_beauty_changes_total',
      help: 'Beauty changes',
      registers,
    });
    this.mediaJoinH = new Histogram({
      name: 'video_rooms_media_join_seconds',
      help: 'Media join latency',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    });
    this.mediaPublishH = new Histogram({
      name: 'video_rooms_media_publish_seconds',
      help: 'Publish latency',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    });
    this.mediaSubscribeH = new Histogram({
      name: 'video_rooms_media_subscribe_seconds',
      help: 'Subscribe latency',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    });
    this.mediaSessionDurH = new Histogram({
      name: 'video_rooms_media_session_duration_seconds',
      help: 'Media session duration',
      buckets: [5, 30, 60, 300, 900, 1800, 3600, 7200],
      registers,
    });
    this.mediaQualityG = new Gauge({
      name: 'video_rooms_media_quality_profile',
      help: 'Active streams by quality profile',
      labelNames: ['profile'],
      registers,
    });
    this.viewerPromotions = new Counter({
      name: 'video_rooms_viewer_promotions_total',
      help: 'Viewers force-promoted to a seat by a host/moderator',
      registers,
    });
    this.viewerDemotions = new Counter({
      name: 'video_rooms_viewer_demotions_total',
      help: 'Participants force-demoted back to the audience by a host/moderator',
      registers,
    });
  }

  // ---- VR-4 seat helpers ----

  incOccupiedSeat(): void {
    this.occupiedSeats.inc();
  }

  decOccupiedSeat(): void {
    this.occupiedSeats.dec();
  }

  incLockedSeat(): void {
    this.lockedSeats.inc();
  }

  decLockedSeat(): void {
    this.lockedSeats.dec();
  }

  incSeatRequest(): void {
    this.seatRequests.inc();
  }

  incSeatInvitation(): void {
    this.seatInvitations.inc();
  }

  incSeatTransfer(): void {
    this.seatTransfers.inc();
  }

  incSeatSwitch(): void {
    this.seatSwitches.inc();
  }

  incReservationTimeout(): void {
    this.reservationTimeouts.inc();
  }

  setLiveRooms(count: number): void {
    this.liveRooms.set(count);
  }

  setViewers(count: number): void {
    this.viewers.set(count);
  }

  setPeakViewers(count: number): void {
    if (count > this.peakViewersSeen) {
      this.peakViewersSeen = count;
      this.peakViewers.set(count);
    }
  }

  setHosts(count: number): void {
    this.hosts.set(count);
  }

  setSessions(count: number): void {
    this.sessions.set(count);
  }

  incHeartbeatFailure(): void {
    this.heartbeatFailures.inc();
  }

  incReconnect(): void {
    this.reconnects.inc();
  }

  incCreated(): void {
    this.created.inc();
  }

  incDeleted(): void {
    this.deleted.inc();
  }

  incLocked(): void {
    this.locked.inc();
  }

  incJoin(): void {
    this.joins.inc();
  }

  incLeave(): void {
    this.leaves.inc();
  }

  incDuplicateSession(): void {
    this.duplicateSessions.inc();
  }

  incReconnectFailure(): void {
    this.reconnectFailures.inc();
  }

  observeSessionDuration(seconds: number): void {
    this.sessionDuration.observe(seconds);
  }

  // ---- VR-5 media helpers ----

  incMediaSession(): void {
    this.mediaSessionsC.inc();
  }

  incTokenIssued(): void {
    this.mediaTokensC.inc();
  }

  setActiveStreams(count: number): void {
    this.mediaActiveStreams.set(count);
  }

  incActiveStream(): void {
    this.mediaActiveStreams.inc();
  }

  decActiveStream(): void {
    this.mediaActiveStreams.dec();
  }

  setPublishingUsers(count: number): void {
    this.mediaPublishingUsers.set(count);
  }

  setSubscribedUsers(count: number): void {
    this.mediaSubscribedUsers.set(count);
  }

  incPublish(): void {
    this.mediaPublishC.inc();
  }

  incPublishFailure(): void {
    this.mediaPublishFailC.inc();
  }

  incMediaFailure(): void {
    this.mediaFailC.inc();
  }

  incRecoverySuccess(): void {
    this.mediaRecoveryC.inc();
  }

  /**
   * VR-5 media reconnect counter. Named distinctly from the pre-existing
   * `incReconnect()` (session-level `video_rooms_reconnects_total`, still used
   * by VideoRoomMemberService) — the brief's verbatim method name collided
   * with it, which is not something TypeScript allows (duplicate class
   * member), so this helper is named `incMediaReconnect()` instead while
   * keeping its own distinct metric name/counter (`mediaReconnectC` /
   * `video_rooms_media_reconnect_total`).
   */
  incMediaReconnect(): void {
    this.mediaReconnectC.inc();
  }

  incBitrateChange(): void {
    this.mediaBitrateC.inc();
  }

  incCameraToggle(): void {
    this.mediaCameraC.inc();
  }

  incMicToggle(): void {
    this.mediaMicC.inc();
  }

  incBeautyChange(): void {
    this.mediaBeautyC.inc();
  }

  observeMediaJoin(seconds: number): void {
    this.mediaJoinH.observe(seconds);
  }

  observePublish(seconds: number): void {
    this.mediaPublishH.observe(seconds);
  }

  observeSubscribe(seconds: number): void {
    this.mediaSubscribeH.observe(seconds);
  }

  observeMediaSessionDuration(seconds: number): void {
    this.mediaSessionDurH.observe(seconds);
  }

  setQualityProfile(profile: string, count: number): void {
    this.mediaQualityG.set({ profile }, count);
  }

  // ---- VR-6 viewer promote/demote helpers ----

  incViewerPromotion(): void {
    this.viewerPromotions.inc();
  }

  incViewerDemotion(): void {
    this.viewerDemotions.inc();
  }
}
