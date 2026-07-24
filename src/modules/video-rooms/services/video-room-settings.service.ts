import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, VideoRoomSettings } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { UpdateVideoRoomSettingsDto } from '../dto/update-video-room-settings.dto';
import { ChatModeChangedEvent } from '../events/video-room-chat.events';
import { RoomSettingsUpdatedEvent } from '../events/video-room.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { toSettingsView } from '../mappers/video-room-detail.mapper';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';

/**
 * The settings fields this endpoint may write. Everything else is rejected.
 *
 * VR-17: `allowScreenShare` and `allowRecording` are deliberately absent. Neither
 * column has an enforcing service method or route — there is no screen-share or
 * recording capability anywhere in `video-room-media.service.ts` — so leaving
 * them writable would ship two UI toggles that persist, broadcast to every
 * participant, and gate nothing: exactly the placeholder-control problem this
 * phase exists to close. They are deferred until a screen-share / recording
 * feature is actually built with a matching enforcement guard; do not re-add
 * them here without one.
 */
export const WRITABLE_SETTINGS_FIELDS = [
  'allowChat',
  'slowModeSeconds',
  'allowAnnouncements',
  'seatApprovalRequired',
  'allowPk',
  'allowGifts',
  'allowTreasure',
  'allowInvite',
  'allowReporting',
  'allowBeauty',
  'allowCameraSwitch',
] as const;

export type SettingsField = (typeof WRITABLE_SETTINGS_FIELDS)[number];

/**
 * Field → permission required to write it (VR-17).
 *
 * A single request-level gate would be wrong: `VideoRoomChatSettingsService`
 * gates the whole patch on the owner-only `MANAGE_ROOM`, which would 403 Admins
 * on seats/gifts/PK — permissions they legitimately hold. So authorization is
 * resolved per field.
 *
 * `MANAGE_MEDIA` deliberately does not exist. The two media gate flags reuse
 * `MANAGE_PARTICIPANTS`, which already resolves to {OWNER, ADMIN} — the exact
 * intended access, with zero change to the shared permission enum or matrix.
 */
export const SETTINGS_FIELD_PERMISSION: Record<SettingsField, VideoRoomPermission> = {
  allowChat: VideoRoomPermission.ROOM_MUTE,
  slowModeSeconds: VideoRoomPermission.ROOM_MUTE,
  allowAnnouncements: VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
  seatApprovalRequired: VideoRoomPermission.MANAGE_SEATS,
  allowPk: VideoRoomPermission.START_PK,
  allowGifts: VideoRoomPermission.MANAGE_TREASURE,
  allowTreasure: VideoRoomPermission.MANAGE_TREASURE,
  allowInvite: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowReporting: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowBeauty: VideoRoomPermission.MANAGE_PARTICIPANTS,
  allowCameraSwitch: VideoRoomPermission.MANAGE_PARTICIPANTS,
};

const WRITABLE = new Set<string>(WRITABLE_SETTINGS_FIELDS);

/** Fields that also require the chat surface to be told — see `publish` below. */
const CHAT_POLICY_FIELDS = new Set<string>(['allowChat', 'slowModeSeconds']);

@Injectable()
export class VideoRoomSettingsService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async update(
    actor: RoomActor,
    roomId: string,
    dto: UpdateVideoRoomSettingsDto,
  ): Promise<VideoRoomSettings> {
    const submitted = Object.keys(dto).filter(
      (key) => (dto as Record<string, unknown>)[key] !== undefined,
    );

    const rejected = submitted.filter((key) => !WRITABLE.has(key));
    if (rejected.length > 0) {
      // VALIDATION_ERROR, not VIDEO_ROOM_FORBIDDEN: an unwritable field name is a
      // bad request, not an authorization failure. This keeps 403 reserved for
      // "your role changed" — the signal the mobile client keys its permission
      // refetch on. Collapsing the two would make a client-side field-name bug
      // present to the user as a permission change.
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        `These settings cannot be changed here: ${rejected.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const room = await this.loadRoom(roomId);

    if (submitted.length === 0) {
      // The settings row is guaranteed to exist — created transactionally
      // alongside the room.
      return (await this.rooms.getSettings(roomId)) as VideoRoomSettings;
    }

    // FAIL WHOLE: assert every distinct permission BEFORE any write, so a
    // partially-authorized patch applies nothing rather than applying in part.
    const required = new Set(
      submitted.map((field) => SETTINGS_FIELD_PERMISSION[field as SettingsField]),
    );
    for (const permission of required) {
      await this.permissions.assertPermission(actor, room, permission);
    }

    const data: Prisma.VideoRoomSettingsUpdateInput = {};
    for (const field of submitted) {
      (data as Record<string, unknown>)[field] = (dto as Record<string, unknown>)[field];
    }

    const settings = await this.rooms.updateSettings(roomId, data);

    await this.bus.publish(
      new RoomSettingsUpdatedEvent({
        roomId,
        actorId: actor.id,
        changed: submitted,
        settings: toSettingsView(settings) as NonNullable<ReturnType<typeof toSettingsView>>,
      }),
    );

    // THE SECOND PUBLISH is not optional. `allowChat` / `slowModeSeconds` are
    // also owned by VideoRoomChatSettingsService, which we deliberately bypass
    // (it gates on owner-only MANAGE_ROOM and would wrongly 403 ADMIN/MODERATOR
    // — the same reason VideoRoomModerationService.muteAll bypasses it). Having
    // bypassed the service we inherit its duty to announce, exactly as muteAll
    // does via publishChatModeChanged. Skip this and chat clients never learn
    // slow mode turned on, while every persistence test still passes.
    if (submitted.some((field) => CHAT_POLICY_FIELDS.has(field))) {
      await this.bus.publish(
        new ChatModeChangedEvent({
          roomId,
          chatMode: settings.chatMode,
          allowChat: settings.allowChat,
          slowModeSeconds: settings.slowModeSeconds,
          actorId: actor.id,
        }),
      );
    }

    return settings;
  }

  private async loadRoom(roomId: string) {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        'Room not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return room;
  }
}
