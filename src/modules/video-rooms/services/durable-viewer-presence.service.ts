import { Injectable } from '@nestjs/common';
import { VideoRoomSeatStatus } from '@prisma/client';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPresenceService } from './video-room-presence.service';
import { VideoRoomSeatStateService } from './video-room-seat-state.service';
import type { AudiencePage, IViewerPresence } from '../interfaces/viewer-presence.interface';

/**
 * Default IViewerPresence impl (VR-6): audience = active members not on a seat.
 * Presence writes reuse the VR-0 role sets; the audience read model subtracts
 * seat occupants (VR-4 snapshot authority) from the viewer set.
 */
@Injectable()
export class DurableViewerPresence implements IViewerPresence {
  constructor(
    private readonly presence: VideoRoomPresenceService,
    private readonly seatState: VideoRoomSeatStateService,
    private readonly repo: VideoRoomsRepository,
  ) {}

  markPresent(roomId: string, userId: string): Promise<void> {
    return this.presence.addViewer(roomId, userId);
  }

  markAbsent(roomId: string, userId: string): Promise<void> {
    return this.presence.removeViewer(roomId, userId);
  }

  isPresent(roomId: string, userId: string): Promise<boolean> {
    return this.presence.isViewer(roomId, userId);
  }

  async audienceCount(roomId: string): Promise<number> {
    const [viewers, occupied] = await Promise.all([
      this.presence.viewerCount(roomId),
      this.occupiedSeatCount(roomId),
    ]);
    return Math.max(0, viewers - occupied);
  }

  async listAudience(roomId: string, take: number, skip: number): Promise<AudiencePage> {
    const seated = [...(await this.seatedUserIds(roomId))];
    const [rows, total] = await Promise.all([
      this.repo.listActiveMembersExcluding(roomId, seated, take, skip),
      this.repo.countActiveMembersExcluding(roomId, seated),
    ]);
    return { items: rows.map((m) => ({ userId: m.userId })), total };
  }

  private async seatedUserIds(roomId: string): Promise<Set<string>> {
    const snap =
      (await this.seatState.getSnapshot(roomId)) ?? (await this.seatState.rebuild(roomId));
    const ids = new Set<string>();
    for (const s of snap.seats) {
      if (s.status === VideoRoomSeatStatus.OCCUPIED && s.occupantUserId) ids.add(s.occupantUserId);
    }
    return ids;
  }

  private async occupiedSeatCount(roomId: string): Promise<number> {
    return (await this.seatedUserIds(roomId)).size;
  }
}
