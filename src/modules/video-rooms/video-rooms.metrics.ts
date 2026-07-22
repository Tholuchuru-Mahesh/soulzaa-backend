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
  // ---- VR-8 seat request/invitation workflow ----
  private readonly seatQueueDepth: Histogram;
  private readonly seatRequestResolutions: Counter<'status'>;
  private readonly seatApprovalLatency: Histogram;
  private readonly seatInvitationOutcomes: Counter<'status'>;
  private readonly seatPromotions: Counter<'result'>;
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
  // ---- VR-7 role & permission engine ----
  private readonly permCacheHits: Counter;
  private readonly permCacheMisses: Counter;
  private readonly roleAssignments: Counter;
  private readonly permissionChecks: Counter;
  private readonly permissionDenials: Counter;
  private readonly ownershipTransfers: Counter;
  private readonly temporaryRoles: Counter;
  private readonly authorizationH: Histogram;
  // ---- VR-9 chat ----
  private readonly chatMessages: Counter<'type'>;
  private readonly chatMessageLatency: Histogram;
  private readonly chatDeliveryLatency: Histogram;
  private readonly chatReadLatency: Histogram;
  private readonly typingEvents: Counter;
  private readonly chatAnnouncements: Counter<'action'>;
  private readonly pinnedMessages: Gauge;
  private readonly spamDetected: Counter<'kind'>;
  private readonly chatRateLimitViolations: Counter;
  // ---- VR-10 gifts ----
  private readonly giftsSentC: Counter<'category'>;
  private readonly giftCoinsC: Counter<'category'>;
  private readonly giftSendLatencyH: Histogram;
  private readonly giftWalletLatencyH: Histogram;
  private readonly giftQueueDepthG: Gauge;
  private readonly giftAnimationQueueDepthG: Gauge;
  private readonly giftFailuresC: Counter;
  private readonly giftRecoveryC: Counter<'result'>;
  private readonly giftCombosC: Counter<'phase'>;
  // ---- VR-11 treasure ----
  private readonly treasureProgressG: Gauge<'room' | 'level'>;
  private readonly treasureUnlocksC: Counter<'level' | 'algorithm'>;
  private readonly treasureDistributionSecondsH: Histogram<'level'>;
  private readonly treasureFailuresC: Counter<'stage'>;
  private readonly treasureQueueDepthG: Gauge<string>;
  private readonly treasureInFlightG: Gauge<string>;
  private readonly treasureMintedC: Counter<'level' | 'strategy'>;
  private readonly treasureWalletLatencyH: Histogram;
  // ---- VR-12 PK battles ----
  private readonly pkActiveG: Gauge;
  private readonly pkBattleDurationH: Histogram;
  private readonly pkGiftThroughputC: Counter;
  private readonly pkScoreLatencyH: Histogram;
  private readonly pkRecoveriesC: Counter<'reason'>;
  private readonly pkInvitationOutcomesC: Counter<'outcome'>;
  private readonly pkWinnerCalculationH: Histogram;
  private readonly pkRewardDistributionH: Histogram;
  private readonly pkRedisSyncC: Counter<'result'>;
  private readonly pkRecoveryQueueDepthG: Gauge;

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
    // ---- VR-8 seat request/invitation workflow ----
    this.seatQueueDepth = new Histogram({
      name: 'video_rooms_seat_queue_depth',
      help: "Observed depth of a single room's seat queue at each queue update (distribution across rooms — p50/p95/max, not an aggregate)",
      buckets: [0, 1, 2, 5, 10, 20, 50, 100],
      registers,
    });
    this.seatRequestResolutions = new Counter({
      name: 'video_rooms_seat_request_resolutions_total',
      help: 'Seat request resolutions by terminal status',
      labelNames: ['status'] as const,
      registers,
    });
    this.seatApprovalLatency = new Histogram({
      name: 'video_rooms_seat_approval_latency_seconds',
      help: 'Seconds from seat request creation to resolution',
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers,
    });
    this.seatInvitationOutcomes = new Counter({
      name: 'video_rooms_seat_invitation_outcomes_total',
      help: 'Seat invitation outcomes; delivery and acceptance rates derive from this',
      labelNames: ['status'] as const,
      registers,
    });
    this.seatPromotions = new Counter({
      name: 'video_rooms_seat_promotion_total',
      help: 'Viewer→participant promotion attempts by result',
      labelNames: ['result'] as const,
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
    this.permCacheHits = new Counter({
      name: 'video_rooms_permission_cache_hits_total',
      help: 'Permission cache hits',
      registers,
    });
    this.permCacheMisses = new Counter({
      name: 'video_rooms_permission_cache_misses_total',
      help: 'Permission cache misses, including version mismatches',
      registers,
    });
    this.roleAssignments = new Counter({
      name: 'video_rooms_role_assignments_total',
      help: 'In-room role grants, updates and revocations',
      labelNames: ['role', 'action'],
      registers,
    });
    this.permissionChecks = new Counter({
      name: 'video_rooms_permission_checks_total',
      help: 'Authorization decisions, by outcome',
      labelNames: ['result'],
      registers,
    });
    this.permissionDenials = new Counter({
      name: 'video_rooms_permission_denials_total',
      help: 'Denied authorization decisions, by permission',
      labelNames: ['permission'],
      registers,
    });
    this.ownershipTransfers = new Counter({
      name: 'video_rooms_ownership_transfers_total',
      help: 'Room ownership handovers (deliberate transfer + recovery)',
      registers,
    });
    this.temporaryRoles = new Counter({
      name: 'video_rooms_temporary_roles_total',
      help: 'Temporary role grants and automatic expiries',
      labelNames: ['action'],
      registers,
    });
    this.authorizationH = new Histogram({
      name: 'video_rooms_authorization_duration_seconds',
      help: 'Latency of a full authorization decision (cache hit or DB resolve)',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
      registers,
    });
    // ---- VR-9 chat ----
    this.chatMessages = new Counter({
      name: 'video_rooms_chat_messages_total',
      help: 'Video-room chat messages sent, by type',
      labelNames: ['type'],
      registers,
    });
    this.chatMessageLatency = new Histogram({
      name: 'video_rooms_chat_message_latency_seconds',
      help: 'Time from send request to socket broadcast',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers,
    });
    this.chatDeliveryLatency = new Histogram({
      name: 'video_rooms_chat_delivery_latency_seconds',
      help: 'Time from message creation to a delivered receipt',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers,
    });
    this.chatReadLatency = new Histogram({
      name: 'video_rooms_chat_read_latency_seconds',
      help: 'Time from message creation to a read receipt',
      buckets: [1, 5, 15, 30, 60, 300, 900],
      registers,
    });
    this.typingEvents = new Counter({
      name: 'video_rooms_chat_typing_events_total',
      help: 'Typing start/stop signals received',
      registers,
    });
    this.chatAnnouncements = new Counter({
      name: 'video_rooms_chat_announcements_total',
      help: 'Announcement lifecycle actions',
      labelNames: ['action'],
      registers,
    });
    this.pinnedMessages = new Gauge({
      name: 'video_rooms_chat_pinned_messages',
      help: 'Currently pinned messages across all rooms',
      registers,
    });
    this.spamDetected = new Counter({
      name: 'video_rooms_chat_spam_detected_total',
      help: 'Spam signals detected, by kind (flood/duplicate/blocked_word)',
      labelNames: ['kind'],
      registers,
    });
    this.chatRateLimitViolations = new Counter({
      name: 'video_rooms_chat_rate_limit_violations_total',
      help: 'Chat rate-limit rejections',
      registers,
    });

    // ---- VR-10 gifts ----
    // Labelled by gift CATEGORY (5 bounded values), never by giftId: a per-gift
    // label is unbounded cardinality and would blow up the metric store. Top
    // gifts are served from the per-room Redis ZSET instead.
    this.giftsSentC = new Counter({
      name: 'video_rooms_gifts_sent_total',
      help: 'Gifts sent in video rooms',
      labelNames: ['category'],
      registers,
    });
    this.giftCoinsC = new Counter({
      name: 'video_rooms_gift_coins_total',
      help: 'Coin value of gifts sent in video rooms (revenue)',
      labelNames: ['category'],
      registers,
    });
    this.giftSendLatencyH = new Histogram({
      name: 'video_rooms_gift_send_latency_seconds',
      help: 'End-to-end gift send latency (excludes animation delivery)',
      buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers,
    });
    this.giftWalletLatencyH = new Histogram({
      name: 'video_rooms_gift_wallet_latency_seconds',
      help: 'Wallet movement latency inside a gift send',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
      registers,
    });
    this.giftQueueDepthG = new Gauge({
      name: 'video_rooms_gift_queue_depth',
      help: 'Pending gift delivery jobs',
      registers,
    });
    this.giftAnimationQueueDepthG = new Gauge({
      name: 'video_rooms_gift_animation_queue_depth',
      help: 'Animations awaiting broadcast',
      registers,
    });
    this.giftFailuresC = new Counter({
      name: 'video_rooms_gift_failures_total',
      help: 'Gift delivery failures (a dead-lettered gift is a missing animation)',
      registers,
    });
    this.giftRecoveryC = new Counter({
      name: 'video_rooms_gift_recovery_total',
      help: 'Dead-letter replay outcomes',
      labelNames: ['result'],
      registers,
    });
    this.giftCombosC = new Counter({
      name: 'video_rooms_gift_combos_total',
      help: 'Gift combo lifecycle transitions',
      labelNames: ['phase'],
      registers,
    });

    // ---- VR-11 treasure ----
    this.treasureProgressG = new Gauge({
      name: 'video_rooms_treasure_progress',
      help: 'Current treasure box progress per room and level',
      labelNames: ['room', 'level'],
      registers,
    });
    this.treasureUnlocksC = new Counter({
      name: 'video_rooms_treasure_unlocks_total',
      help: 'Treasure boxes unlocked, by level and winner algorithm',
      labelNames: ['level', 'algorithm'],
      registers,
    });
    this.treasureDistributionSecondsH = new Histogram({
      name: 'video_rooms_treasure_distribution_seconds',
      help: 'End-to-end reward distribution time per unlock (SLO: < 5s, production.txt:1561)',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      labelNames: ['level'],
      registers,
    });
    this.treasureFailuresC = new Counter({
      name: 'video_rooms_treasure_failures_total',
      help: 'Unlock failures, labelled by the pipeline stage that produced them',
      labelNames: ['stage'],
      registers,
    });
    this.treasureQueueDepthG = new Gauge({
      name: 'video_rooms_treasure_queue_depth',
      help: 'Pending treasure unlock jobs',
      registers,
    });
    this.treasureInFlightG = new Gauge({
      name: 'video_rooms_treasure_unlocks_in_flight',
      help: 'Treasure unlocks currently executing',
      registers,
    });
    this.treasureMintedC = new Counter({
      name: 'video_rooms_treasure_minted_total',
      help: 'GOLD minted to treasure winners (platform-funded; not taken from gift value)',
      labelNames: ['level', 'strategy'],
      registers,
    });
    this.treasureWalletLatencyH = new Histogram({
      name: 'video_rooms_treasure_wallet_seconds',
      help: 'Wallet credit time inside an unlock — isolates the wallet when the 5s SLO breaks',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    });

    // ---- VR-12 PK battles ----
    this.pkActiveG = new Gauge({
      name: 'video_rooms_pk_active',
      help: 'PK battles currently non-terminal (fleet-wide)',
      registers,
    });
    this.pkBattleDurationH = new Histogram({
      name: 'video_rooms_pk_battle_duration_seconds',
      help: 'Wall-clock duration of a settled PK battle',
      buckets: [15, 30, 60, 120, 300, 600, 1200],
      registers,
    });
    this.pkGiftThroughputC = new Counter({
      name: 'video_rooms_pk_gift_throughput_total',
      help: 'Gifts that landed a PK score contribution',
      registers,
    });
    this.pkScoreLatencyH = new Histogram({
      name: 'video_rooms_pk_score_latency_seconds',
      help: 'Time from a gift being scored to its broadcast leaving the event bus',
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers,
    });
    this.pkRecoveriesC = new Counter({
      name: 'video_rooms_pk_recoveries_total',
      help: 'PK battles recovered from a frozen/interrupted state, by reason',
      labelNames: ['reason'] as const,
      registers,
    });
    this.pkInvitationOutcomesC = new Counter({
      name: 'video_rooms_pk_invitation_outcomes_total',
      help: 'PK invitation outcomes; delivery and acceptance rates derive from this',
      labelNames: ['outcome'] as const,
      registers,
    });
    this.pkWinnerCalculationH = new Histogram({
      name: 'video_rooms_pk_winner_calculation_seconds',
      help: 'Time from a battle ending to its winner being declared',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    });
    this.pkRewardDistributionH = new Histogram({
      name: 'video_rooms_pk_reward_distribution_seconds',
      help: 'Time from a battle ending to its rewards being distributed',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers,
    });
    this.pkRedisSyncC = new Counter({
      name: 'video_rooms_pk_redis_sync_total',
      help: 'PK scoreboard Redis-mirror syncs, by result',
      labelNames: ['result'] as const,
      registers,
    });
    this.pkRecoveryQueueDepthG = new Gauge({
      name: 'video_rooms_pk_recovery_queue_depth',
      help: 'PK battles/invitations awaiting the recovery sweep',
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

  // ---- VR-8 seat request/invitation workflow helpers ----

  observeSeatQueueDepth(depth: number): void {
    this.seatQueueDepth.observe(depth);
  }

  incSeatRequestResolution(status: string): void {
    this.seatRequestResolutions.inc({ status });
  }

  observeSeatApprovalLatency(seconds: number): void {
    this.seatApprovalLatency.observe(seconds);
  }

  incSeatInvitationOutcome(status: string): void {
    this.seatInvitationOutcomes.inc({ status });
  }

  incSeatPromotion(result: 'success' | 'failure'): void {
    this.seatPromotions.inc({ result });
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

  // ---- VR-7 permission cache helpers ----

  incPermissionCacheHit(): void {
    this.permCacheHits.inc();
  }

  incPermissionCacheMiss(): void {
    this.permCacheMisses.inc();
  }

  incRoleAssignment(role: string, action: 'assigned' | 'removed' | 'updated'): void {
    this.roleAssignments.inc({ role, action });
  }

  incPermissionCheck(result: 'allowed' | 'denied'): void {
    this.permissionChecks.inc({ result });
  }

  incPermissionDenial(permission: string): void {
    this.permissionDenials.inc({ permission });
  }

  incOwnershipTransfer(): void {
    this.ownershipTransfers.inc();
  }

  incTemporaryRole(action: 'granted' | 'expired'): void {
    this.temporaryRoles.inc({ action });
  }

  observeAuthorization(seconds: number): void {
    this.authorizationH.observe(seconds);
  }

  // ---- VR-9 chat helpers ----

  incChatMessage(type: string): void {
    this.chatMessages.inc({ type });
  }

  observeChatLatency(seconds: number): void {
    this.chatMessageLatency.observe(seconds);
  }

  observeChatDelivery(seconds: number): void {
    this.chatDeliveryLatency.observe(seconds);
  }

  observeChatRead(seconds: number): void {
    this.chatReadLatency.observe(seconds);
  }

  incTypingEvent(): void {
    this.typingEvents.inc();
  }

  incAnnouncement(action: string): void {
    this.chatAnnouncements.inc({ action });
  }

  setPinnedMessages(count: number): void {
    this.pinnedMessages.set(count);
  }

  incSpamDetected(kind: string): void {
    this.spamDetected.inc({ kind });
  }

  incChatRateLimitViolation(): void {
    this.chatRateLimitViolations.inc();
  }

  // ---- VR-10 gift helpers ----

  /** One call per ledger row, so an N-receiver send counts as N gifts. */
  incGiftSent(category: string, coins: number): void {
    this.giftsSentC.inc({ category });
    this.giftCoinsC.inc({ category }, coins);
  }

  observeGiftSendLatency(seconds: number): void {
    this.giftSendLatencyH.observe(seconds);
  }

  observeGiftWalletLatency(seconds: number): void {
    this.giftWalletLatencyH.observe(seconds);
  }

  setGiftQueueDepth(depth: number): void {
    this.giftQueueDepthG.set(depth);
  }

  setGiftAnimationQueueDepth(depth: number): void {
    this.giftAnimationQueueDepthG.set(depth);
  }

  incGiftFailure(): void {
    this.giftFailuresC.inc();
  }

  incGiftRecovery(result: 'success' | 'failure'): void {
    this.giftRecoveryC.inc({ result });
  }

  incGiftCombo(phase: 'started' | 'updated' | 'ended'): void {
    this.giftCombosC.inc({ phase });
  }

  // ---- VR-11 treasure helpers ----

  setTreasureProgress(roomId: string, level: number, progress: number): void {
    this.treasureProgressG.set({ room: roomId, level: String(level) }, progress);
  }

  incTreasureUnlock(level: number, algorithm: string): void {
    this.treasureUnlocksC.inc({ level: String(level), algorithm });
  }

  observeTreasureDistribution(level: number, seconds: number): void {
    this.treasureDistributionSecondsH.observe({ level: String(level) }, seconds);
  }

  /** Labelled by pipeline stage so an alert names where the failure happened. */
  incTreasureFailure(stage: string): void {
    this.treasureFailuresC.inc({ stage });
  }

  setTreasureQueueDepth(depth: number): void {
    this.treasureQueueDepthG.set(depth);
  }

  setTreasureInFlight(count: number): void {
    this.treasureInFlightG.set(count);
  }

  /** GOLD minted to winners — the treasure-revenue counter. */
  incTreasureMinted(level: number, strategy: string, amount: number): void {
    this.treasureMintedC.inc({ level: String(level), strategy }, amount);
  }

  /** Wallet credit time inside an unlock, separate from end-to-end duration. */
  observeTreasureWalletLatency(seconds: number): void {
    this.treasureWalletLatencyH.observe(seconds);
  }

  // ---- VR-12 PK battle helpers ----

  /**
   * Non-terminal PK battle count. Set by `VideoRoomPkRecoveryService`'s
   * periodic gauge read (Task 20), not by this module's event listeners — the
   * recovery sweep already computes the same query result it needs for its
   * own repair decisions, so re-deriving it from events here would be a
   * second, drifting source of the same number.
   */
  setPkActive(count: number): void {
    this.pkActiveG.set(count);
  }

  observePkBattleDuration(seconds: number): void {
    this.pkBattleDurationH.observe(seconds);
  }

  incPkGiftThroughput(): void {
    this.pkGiftThroughputC.inc();
  }

  observePkScoreLatency(seconds: number): void {
    this.pkScoreLatencyH.observe(seconds);
  }

  incPkRecovery(reason: string): void {
    this.pkRecoveriesC.inc({ reason });
  }

  incPkInvitationOutcome(outcome: string): void {
    this.pkInvitationOutcomesC.inc({ outcome });
  }

  observePkWinnerCalculation(seconds: number): void {
    this.pkWinnerCalculationH.observe(seconds);
  }

  observePkRewardDistribution(seconds: number): void {
    this.pkRewardDistributionH.observe(seconds);
  }

  incPkRedisSync(result: string): void {
    this.pkRedisSyncC.inc({ result });
  }

  /** Same "read every tick, act only when enabled" rationale as `setPkActive`. */
  setPkRecoveryQueueDepth(count: number): void {
    this.pkRecoveryQueueDepthG.set(count);
  }
}
