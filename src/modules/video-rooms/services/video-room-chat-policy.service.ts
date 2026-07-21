import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlatformRole,
  VideoRoom,
  VideoRoomChatMode,
  VideoRoomMemberRole,
  VideoRoomMessage,
  VideoRoomMessageType,
  VideoRoomSettings,
  VideoRoomStatus,
} from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH } from '../constants/video-room-chat.constants';
import { ELEVATED_VIDEO_ROOM_ROLES } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';

export interface SendPolicyInput {
  type: VideoRoomMessageType;
  contentLength: number;
  attachmentCount: number;
}

export interface SendPolicyResult {
  room: VideoRoom;
  settings: VideoRoomSettings;
  role: VideoRoomMemberRole | null;
}

/** Seat-derived roles — allowed to talk in PARTICIPANTS_ONLY. */
const SEATED_ROLES: readonly VideoRoomMemberRole[] = [
  VideoRoomMemberRole.HOST,
  VideoRoomMemberRole.PARTICIPANT,
];

/**
 * THE authorization decision point for VR-9 chat. Every gate — room state,
 * membership, chat enablement, chat mode, block, mute, length, type, attachments
 * — is asked here and nowhere else.
 *
 * This service exists because of what VR-7's post-mortem found: when video-room
 * authorization was spread across services, a coarse gate sat beside the fine
 * permission matrix, won wherever the two overlapped, and the PRD's admin
 * restrictions went unenforced for six phases. Chat has more gates than RBAC did,
 * so they get one service and one exhaustively enumerated test matrix.
 *
 * `chatMode` is the ONLY source of truth for who may send. The deprecated
 * `allowViewerChat` column is never read here — see the schema doc comment.
 */
@Injectable()
export class VideoRoomChatPolicyService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly config: ConfigService,
  ) {}

  async assertCanSend(
    actor: RoomActor,
    roomId: string,
    input: SendPolicyInput,
  ): Promise<SendPolicyResult> {
    const room = await this.loadLiveRoom(roomId);
    await this.assertActiveMember(roomId, actor.id);

    const settings = await this.rooms.getSettings(roomId);
    if (settings && !settings.allowChat) {
      throw new BusinessException(
        ERROR_CODES.CHAT_DISABLED,
        'Chat is disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.assertNotBlockedOrMuted(roomId, actor.id);

    const role = await this.permissions.resolveEffectiveRole(room, actor.id);
    this.assertContent(input, settings);
    this.assertMode(actor, input.type, role, settings?.chatMode ?? VideoRoomChatMode.NORMAL);

    return { room, settings: settings as VideoRoomSettings, role };
  }

  /** Edit: author only, inside the window, on a live text-ish message. */
  async assertCanEdit(actor: RoomActor, roomId: string, message: VideoRoomMessage): Promise<void> {
    if (message.senderId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'You can only edit your own messages.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (message.deletedAt || message.recalledAt || message.type === VideoRoomMessageType.SYSTEM) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MESSAGE_NOT_EDITABLE,
        'This message cannot be edited.',
        HttpStatus.CONFLICT,
      );
    }
    const { editWindowSeconds } = loadVideoRoomChatConfig(this.config);
    if (this.ageSeconds(message.createdAt) > editWindowSeconds) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED,
        'The edit window for this message has closed.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Delete: the author, or anyone holding moderator authority. */
  async assertCanDelete(
    actor: RoomActor,
    roomId: string,
    message: VideoRoomMessage,
  ): Promise<{ byModerator: boolean }> {
    if (message.senderId === actor.id) return { byModerator: false };

    const room = await this.loadRoom(roomId);
    if (this.isPlatformAdmin(actor)) return { byModerator: true };

    const role = await this.permissions.resolveEffectiveRole(room, actor.id);
    if (role && ELEVATED_VIDEO_ROOM_ROLES.includes(role)) return { byModerator: true };

    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      'You do not have permission to delete this message.',
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Recall: the author alone, inside the window. Moderators are deliberately
   * excluded — recall withdraws a message from everyone, so letting a moderator
   * recall would erase evidence rather than moderate it. Moderators delete.
   */
  async assertCanRecall(
    actor: RoomActor,
    _roomId: string,
    message: VideoRoomMessage,
  ): Promise<void> {
    if (message.senderId !== actor.id) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'Only the sender may recall a message.',
        HttpStatus.FORBIDDEN,
      );
    }
    const { recallWindowSeconds } = loadVideoRoomChatConfig(this.config);
    if (this.ageSeconds(message.createdAt) > recallWindowSeconds) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED,
        'The recall window for this message has closed.',
        HttpStatus.CONFLICT,
      );
    }
  }

  async assertActiveMember(roomId: string, userId: string): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You are not a member of this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // ---- Internals ----

  private async loadRoom(roomId: string): Promise<VideoRoom> {
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

  private async loadLiveRoom(roomId: string): Promise<VideoRoom> {
    const room = await this.loadRoom(roomId);
    if (room.status !== VideoRoomStatus.LIVE) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ENDED,
        'This room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    return room;
  }

  private async assertNotBlockedOrMuted(roomId: string, userId: string): Promise<void> {
    if (await this.moderation.findActiveBlock(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_BLOCKED,
        'You are blocked from this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (await this.moderation.findActiveMute(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.MEMBER_MUTED,
        'You are muted in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertContent(input: SendPolicyInput, settings: VideoRoomSettings | null): void {
    const max =
      input.type === VideoRoomMessageType.EMOJI
        ? VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH
        : (settings?.chatMaxMessageLength ?? loadVideoRoomChatConfig(this.config).messageMaxLength);

    if (input.contentLength === 0 || input.contentLength > max) {
      throw new BusinessException(
        ERROR_CODES.MESSAGE_TOO_LONG,
        `Message must be between 1 and ${max} characters.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.attachmentCount > (settings?.chatMaxAttachments ?? 1)) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_ATTACHMENT_LIMIT,
        'Too many attachments on this message.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * The mode × role matrix. Platform staff bypass entirely; SYSTEM rows are
   * platform-minted and never accepted from a client (otherwise any member could
   * forge an "Owner changed" notice).
   */
  private assertMode(
    actor: RoomActor,
    type: VideoRoomMessageType,
    role: VideoRoomMemberRole | null,
    mode: VideoRoomChatMode,
  ): void {
    if (type === VideoRoomMessageType.SYSTEM) {
      throw this.modeError('System messages cannot be sent by clients.');
    }
    if (this.isPlatformAdmin(actor)) return;

    const elevated = role !== null && ELEVATED_VIDEO_ROOM_ROLES.includes(role);
    const seated = role !== null && SEATED_ROLES.includes(role);

    switch (mode) {
      case VideoRoomChatMode.NORMAL:
        return;
      case VideoRoomChatMode.PARTICIPANTS_ONLY:
        if (elevated || seated) return;
        throw this.modeError('Only participants may chat in this room right now.');
      case VideoRoomChatMode.READ_ONLY:
        if (elevated) return;
        throw this.modeError('This room is in read-only mode.');
      case VideoRoomChatMode.ANNOUNCEMENT_ONLY:
        if (elevated && type === VideoRoomMessageType.ANNOUNCEMENT) return;
        throw this.modeError('Only announcements may be posted in this room right now.');
    }
  }

  private modeError(message: string): BusinessException {
    return new BusinessException(
      ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED,
      message,
      HttpStatus.FORBIDDEN,
    );
  }

  private isPlatformAdmin(actor: RoomActor): boolean {
    return (
      actor.roles.includes(PlatformRole.ADMIN) || actor.roles.includes(PlatformRole.SUPER_ADMIN)
    );
  }

  private ageSeconds(at: Date): number {
    return (Date.now() - at.getTime()) / 1000;
  }
}
