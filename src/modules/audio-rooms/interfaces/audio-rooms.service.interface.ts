import type { RoomMemberRole, RoomStatus, RoomVisibility } from '@prisma/client';
import type { RoomPermission } from '../constants/room-permissions';
import type { StageSnapshot } from '../repositories/audio-room-seats.repository';

/**
 * Public contract for the audio-rooms module — the ONLY surface other modules
 * (seats, chat, gifts, moderation, treasure boxes) may depend on. Internals
 * (entities, repositories, concrete services) stay private. Kept read/query
 * oriented so it is a stable seam for later phases; state mutations happen
 * through the REST controller or via EVENT_BUS reactions.
 */
export const AUDIO_ROOMS_SERVICE = Symbol('AUDIO_ROOMS_SERVICE');

/** A room read model — no password material. */
export interface RoomView {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  imageKey: string | null;
  /**
   * The room display picture, resolved from [imageKey] to a servable URL (CDN
   * when MEDIA_PUBLIC_BASE_URL is set, otherwise a presigned GET). Derived, not
   * stored — `imageKey` stays the single source of truth. Clients render this
   * directly so they never have to know how media is hosted.
   */
  imageUrl: string | null;
  categoryId: string | null;
  language: string | null;
  visibility: RoomVisibility;
  isLocked: boolean;
  isPasswordProtected: boolean;
  isDiscoverable: boolean;
  maxParticipants: number;
  status: RoomStatus;
  participantCount: number;
  agoraChannel: string;
  zegoRoomId: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

/** User's room participation history item. */
export interface RoomHistoryView {
  id: string;
  roomId: string;
  roomName: string;
  roomImageKey: string | null;
  roomImageUrl: string | null;
  ownerId: string;
  ownerName: string;
  role: RoomMemberRole;
  joinedAt: Date;
  leftAt: Date | null;
  durationSeconds: number;
  status: RoomStatus;
  participantCount: number;
}

/** User's microphone / speaker seat participation session item. */
export interface MicHistoryView {
  id: string;
  roomId: string;
  roomName: string;
  roomImageKey: string | null;
  roomImageUrl: string | null;
  ownerId: string;
  ownerName: string;
  seatIndex: number | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  status: RoomStatus;
}

export interface IAudioRoomsService {
  /** Full room read model, or null if not found / soft-deleted. */
  getRoom(roomId: string): Promise<RoomView | null>;

  /** True when the room exists and is currently LIVE. */
  isRoomLive(roomId: string): Promise<boolean>;

  /** Current owner's user id, or null if the room does not exist. */
  getOwnerId(roomId: string): Promise<string | null>;

  /** True when the user is an active member of the room. */
  isMember(roomId: string, userId: string): Promise<boolean>;

  /** The user's membership role, or null if not an active member. */
  getMemberRole(roomId: string, userId: string): Promise<RoomMemberRole | null>;

  /** Throws NOT_ROOM_MEMBER when the user is not an active member. */
  assertMember(roomId: string, userId: string): Promise<void>;

  /** Live participant count (authoritative Redis presence count). */
  participantCount(roomId: string): Promise<number>;

  // ---- Seats & roles (AR-1) — read seams for chat/gifts/PK/moderation ----

  /** Effective in-room role (grant → speaker seat → listener), or null if absent. */
  getEffectiveRole(roomId: string, userId: string): Promise<RoomMemberRole | null>;

  /** True when the user holds the given room permission (by effective role). */
  hasRoomPermission(roomId: string, userId: string, permission: RoomPermission): Promise<boolean>;

  /** True when the user currently occupies a stage seat. */
  isSpeaker(roomId: string, userId: string): Promise<boolean>;

  /** True when the whole room is muted. */
  isRoomMuted(roomId: string): Promise<boolean>;

  /** True when the user's current seat is muted (false if not seated). */
  isSeatMuted(roomId: string, userId: string): Promise<boolean>;

  /** Full stage snapshot: seats + queue + seat settings (read-through cache). */
  getStage(roomId: string): Promise<StageSnapshot>;

  // ---- Live sessions (Creator Center — Live History) ----

  /** Paginated broadcast sessions the caller has hosted (most recent first). */
  listMyLiveSessions(
    ownerId: string,
    skip: number,
    take: number,
  ): Promise<{ rows: LiveSessionView[]; total: number }>;

  /** One of the caller's own sessions by id, or null if missing/not theirs. */
  getMyLiveSession(ownerId: string, sessionId: string): Promise<LiveSessionView | null>;
}

/** A single "went live → ended" broadcast session. */
export interface LiveSessionView {
  id: string;
  roomId: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  status: 'LIVE' | 'ENDED';
}
