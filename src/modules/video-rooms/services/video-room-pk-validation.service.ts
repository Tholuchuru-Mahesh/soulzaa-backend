import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoom, VideoRoomMemberRole, VideoRoomPkMode, VideoRoomStatus } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { loadVideoRoomPkConfig } from '../config/video-room-pk.config';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { CreatePKInvitationDto } from '../dto/video-room-pk.dto';
import { ConnectionStatus } from '../enums';
import { DuplicatePKException, PKBattleException } from '../exceptions/video-room-pk.exceptions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomMediaStateService } from './video-room-media-state.service';
import { VideoRoomPermissionService } from './video-room-permission.service';
import { VideoRoomPresenceService } from './video-room-presence.service';

/**
 * The 11 ordered gates a PK invitation must clear before a battle row may be
 * created (VR-12). `assertCanCreate` runs them in exactly this sequence,
 * cheapest and most-likely-to-fail first, so a request that was never going
 * to succeed does the least possible work — and, just as important, a caller
 * who fails an early gate (config, room state, permission) never causes a
 * read of participant/presence/media state they were not authorized to see:
 *
 *   1. PK enabled (config master switch)
 *   2. the effective duration is within the configured bounds
 *   3. room exists
 *   4. room is LIVE
 *   5. room settings allow PK
 *   6. actor holds START_PK
 *   7. participant shape (distinctness/cardinality) is well-formed
 *   8. every participant is an active, non-VIEWER member
 *   9. every participant is online
 *   10. every participant has active media
 *   11. no non-terminal battle already exists in the room
 *
 * Gate 11 is a pre-check, not the enforcement: the real "one battle per room"
 * rule is a partial unique index in the database
 * (`video_room_pk_battles_one_active_per_room`). This gate exists only so a
 * losing caller gets a clean `DuplicatePKException` instead of a raw
 * constraint-violation error; the database still wins any real race.
 */
@Injectable()
export class VideoRoomPkValidationService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly presence: VideoRoomPresenceService,
    private readonly mediaState: VideoRoomMediaStateService,
    private readonly pkRepo: VideoRoomPkRepository,
    private readonly config: ConfigService,
  ) {}

  async assertCanCreate(
    actor: RoomActor,
    roomId: string,
    dto: CreatePKInvitationDto,
  ): Promise<VideoRoom> {
    const cfg = loadVideoRoomPkConfig(this.config);

    // Gate 1: master switch. Cheapest possible check — no I/O at all.
    if (!cfg.enabled) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_PK_DISABLED,
        'The PK battle engine is disabled.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Gate 2: the effective duration — the DTO's value, or
    // `defaultDurationSeconds` when omitted (mirrors the fallback
    // `VideoRoomPkService.invite` applies when it actually creates the
    // battle) — must fall inside the CONFIGURED bounds. Still no I/O, so this
    // stays as early as gate 1. The DTO's own `@Min(60)`/`@Max(1800)` are only
    // a cheap first-pass guard against a malformed payload; this is the
    // authoritative check against whatever an operator has actually set
    // `VIDEO_ROOM_PK_MIN_DURATION_SECONDS`/`..._MAX_DURATION_SECONDS` to.
    const durationSeconds = dto.durationSeconds ?? cfg.defaultDurationSeconds;
    if (durationSeconds < cfg.minDurationSeconds || durationSeconds > cfg.maxDurationSeconds) {
      throw new PKBattleException(
        `durationSeconds must be between ${cfg.minDurationSeconds} and ${cfg.maxDurationSeconds} seconds (got ${durationSeconds}).`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Gate 3: room must exist.
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Gate 4: room must be LIVE. Checked before settings/permission so a
    // caller probing a dormant room never learns anything about its
    // configuration or their own authorization there.
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new PKBattleException('The room must be live to start a PK battle.');
    }

    // Gate 5: room settings may turn PK off even while the feature is
    // globally enabled. A room with no settings row is a data-integrity fault
    // and raises VIDEO_ROOM_SETTINGS_MISSING rather than defaulting to allowed.
    const settings = await this.rooms.requireSettings(roomId);
    if (!settings.allowPk) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_PK_DISABLED,
        'PK battles are disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Gate 6: the actor must hold START_PK in this room.
    await this.permissions.assertPermission(
      actor,
      { id: room.id, ownerId: room.ownerId },
      VideoRoomPermission.START_PK,
    );

    // Gate 7: the DTO's own shape — distinct sides, correct cardinality.
    this.assertParticipantsDistinct(dto);

    const participantIds = [...dto.red, ...dto.blue];

    // Gate 8: every participant must be an active, non-VIEWER member. A
    // VIEWER has no seat and no stream, so it can never be a PK side — the
    // role is checked explicitly rather than trusting `isActive` alone.
    for (const userId of participantIds) {
      const member = await this.rooms.getMember(roomId, userId);
      if (!member?.isActive || member.role === VideoRoomMemberRole.VIEWER) {
        throw new PKBattleException(
          `Participant ${userId} must be an active, non-viewer member of the room.`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // Gate 9: every participant must be online right now. This is a live
    // Redis signal, deliberately separate from gate 8's durable DB flag —
    // a member row can say `isActive` long after the socket dropped.
    // `VideoRoomPresenceService` tracks hosts and seat-holding participants
    // in TWO SEPARATE Redis sets, so a single membership check cannot cover
    // every role gate 8 admits. Gate 8 lets OWNER, ADMIN, HOST, and
    // PARTICIPANT through (only VIEWER is excluded) — but PARTICIPANT lives
    // exclusively in the participants set, never the hosts set. So a
    // contestant is "online" if they are present in EITHER set; `isHost` is
    // checked first and `isParticipant` only consulted when it is false, to
    // keep the common (host) path to a single Redis round trip.
    for (const userId of participantIds) {
      const online =
        (await this.presence.isHost(roomId, userId)) ||
        (await this.presence.isParticipant(roomId, userId));
      if (!online) {
        throw new PKBattleException(`Participant ${userId} is not currently online in the room.`);
      }
    }

    // Gate 10: every participant must be publishing media right now — the
    // battle scores gifts sent to a live stream, so a seated-but-not-
    // publishing participant cannot be a side.
    const snapshot = await this.mediaState.getSnapshot(roomId);
    for (const userId of participantIds) {
      const media = snapshot?.participants.find((p) => p.userId === userId);
      if (!media || media.connection !== ConnectionStatus.CONNECTED) {
        throw new PKBattleException(`Participant ${userId} has no active media stream.`);
      }
    }

    // Gate 11: pre-check only (see class doc) — the database's partial
    // unique index is the actual enforcement.
    if (await this.pkRepo.findCurrent(roomId)) {
      throw new DuplicatePKException('This room already has a PK battle in progress.');
    }

    return room;
  }

  /**
   * Second line of defence for the five management commands (`start`,
   * `pause`, `resume`, `cancel`, `end`) — `VideoRoomPkService` calls this as
   * the FIRST thing inside each, before the lifecycle lock and before any
   * state read, so a caller who fails authorization never learns whether a
   * battle even exists.
   *
   * Deliberately just gates 3 and 6 of `assertCanCreate`, mirrored: load the
   * room (404 if absent), then assert `START_PK`. The duration-bounds gate
   * (2) and the participant/presence/media gates (7-10) are creation-time
   * concerns only — they characterise a NEW battle's proposed length and its
   * two sides, and have nothing to check once one already exists. Gates
   * 1/4/5 (config switch, room LIVE, room settings) are also skipped on
   * purpose: a battle already in flight must still be pause/cancel/end-able
   * even if, say, the room settings later disable PK.
   *
   * `START_PK` is the same permission `assertCanCreate` uses — managing a
   * battle in progress requires the same authority as starting one. Per the
   * permission matrix, OWNER and ADMIN hold `START_PK`.
   */
  async assertCanManage(actor: RoomActor, roomId: string): Promise<VideoRoom> {
    // Room must exist.
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    // The actor must hold START_PK in this room.
    await this.permissions.assertPermission(
      actor,
      { id: room.id, ownerId: room.ownerId },
      VideoRoomPermission.START_PK,
    );

    return room;
  }

  /**
   * Cardinality and distinctness. Deliberately NOT a DTO rule: `mode` and the
   * two arrays only mean something together, and class-validator cannot express
   * a cross-field rule without a custom decorator that would be harder to read
   * than this.
   *
   * The "exactly one per side" check is the ONLY thing standing between today's
   * 2-side battles and the multi-host future — sides are rows, so relaxing this
   * method (plus new enum values) is the whole change.
   */
  assertParticipantsDistinct(dto: CreatePKInvitationDto): void {
    const overlap = dto.red.some((u) => dto.blue.includes(u));
    const dupRed = new Set(dto.red).size !== dto.red.length;
    const dupBlue = new Set(dto.blue).size !== dto.blue.length;
    if (overlap || dupRed || dupBlue) {
      throw new PKBattleException(
        'Participants must be distinct and cannot appear on both sides.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      dto.mode === VideoRoomPkMode.ONE_VS_ONE &&
      (dto.red.length !== 1 || dto.blue.length !== 1)
    ) {
      throw new PKBattleException(
        'A 1v1 battle needs exactly one participant per side.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
