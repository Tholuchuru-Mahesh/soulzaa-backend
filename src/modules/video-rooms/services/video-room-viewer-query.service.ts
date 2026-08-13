import { Inject, Injectable } from '@nestjs/common';
import { VIEWER_CAPABILITIES } from '../constants/video-room-viewer-permissions';
import { ViewerStatus } from '../enums';
import { VIEWER_PRESENCE, type IViewerPresence } from '../interfaces/viewer-presence.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { toViewerPresence } from './video-room-viewer-presence.projection';
import { VideoRoomMemberService } from './video-room-member.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

export interface ViewerCountBreakdown {
  audience: number;
  watching: number;
  background: number;
  reconnecting: number;
}

/**
 * The viewer-facing READ models (VR-6): audience page, count breakdown, and
 * "my" viewer status. Pure composition over the audience seam, member
 * presence/session views, and the permission resolver — no writes here.
 */
@Injectable()
export class VideoRoomViewerQueryService {
  constructor(
    @Inject(VIEWER_PRESENCE) private readonly presence: IViewerPresence,
    private readonly members: VideoRoomMemberService,
    private readonly permissions: VideoRoomPermissionService,
    private readonly repo: VideoRoomsRepository,
  ) {}

  listAudience(roomId: string, take: number, skip: number) {
    return this.presence.listAudience(roomId, take, skip);
  }

  async countAudience(roomId: string): Promise<ViewerCountBreakdown> {
    const presenceRows = await this.members.listPresence(roomId);
    let watching = 0,
      background = 0,
      reconnecting = 0;
    for (const row of presenceRows) {
      const s = toViewerPresence(row.state);
      if (s === ViewerStatus.WATCHING) watching++;
      else if (s === ViewerStatus.BACKGROUND) background++;
      else if (s === ViewerStatus.RECONNECTING) reconnecting++;
    }
    return { audience: presenceRows.length, watching, background, reconnecting };
  }

  async getMyViewer(userId: string, roomId: string) {
    const room = await this.repo.findById(roomId);
    const role = room ? await this.permissions.resolveEffectiveRole(room, userId) : null;
    const session = await this.members.getMySession(userId, roomId);
    const status = session ? toViewerPresence(session.presenceState) : ViewerStatus.OFFLINE;
    return {
      userId,
      roomId,
      effectiveRole: role, // null = audience viewer
      status,
      session,
      capabilities: VIEWER_CAPABILITIES,
    };
  }
}
