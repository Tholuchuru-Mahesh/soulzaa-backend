import { Injectable, Logger } from '@nestjs/common';

export interface SpeakerActivityEvent {
  userId: string;
  name: string;
  seatNumber?: number | null;
  avatarUrl?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  isTargetUser?: boolean;
  isReporter?: boolean;
}

export interface SpeakerTimelineSegment {
  userId: string;
  name: string;
  seatNumber?: number | null;
  avatarUrl?: string | null;
  startSecond: number; // relative seconds (0.0 to duration)
  endSecond: number;
  isTargetUser?: boolean;
  isReporter?: boolean;
}

/**
 * Real-time speaker-turn tracker for evidence recordings. Fed by
 * `AudioRoomGateway.handleSpeakerActivity` off the `room:speaker_activity`
 * socket event as participants start/stop speaking, so the timeline shown
 * next to an evidence recording reflects who actually spoke and when —
 * synced to the same wall-clock window used to trim the real recorded audio
 * (`RoomRecordingLifecycleService`).
 *
 * Actual room media bytes are captured separately via ZEGO Cloud Recording
 * (see `RoomRecordingLifecycleService`) — this service only tracks *when*
 * each participant was speaking, not the audio itself.
 */
@Injectable()
export class RoomMediaBufferService {
  private readonly logger = new Logger(RoomMediaBufferService.name);
  private readonly speakerLogs = new Map<string, SpeakerActivityEvent[]>();
  private readonly activeSpeakers = new Map<string, Map<string, SpeakerActivityEvent>>();

  /**
   * Records real-time speaker state transitions off the `room:speaker_activity`
   * socket event.
   */
  recordSpeakerActivity(
    roomId: string,
    userId: string,
    name: string,
    seatNumber?: number | null,
    isSpeaking = true,
    avatarUrl?: string | null,
  ): void {
    let roomActive = this.activeSpeakers.get(roomId);
    if (!roomActive) {
      roomActive = new Map<string, SpeakerActivityEvent>();
      this.activeSpeakers.set(roomId, roomActive);
    }

    let roomLogs = this.speakerLogs.get(roomId);
    if (!roomLogs) {
      roomLogs = [];
      this.speakerLogs.set(roomId, roomLogs);
    }

    const now = new Date();

    if (isSpeaking) {
      if (!roomActive.has(userId)) {
        const event: SpeakerActivityEvent = {
          userId,
          name: name || `User ${userId.slice(0, 6)}`,
          seatNumber: seatNumber ?? 1,
          avatarUrl: avatarUrl ?? null,
          startedAt: now,
          endedAt: null,
        };
        roomActive.set(userId, event);
      }
    } else {
      const activeEvent = roomActive.get(userId);
      if (activeEvent) {
        activeEvent.endedAt = now;
        roomLogs.push(activeEvent);
        roomActive.delete(userId);
        this.trimSpeakerLogs(roomId);
      }
    }
  }

  /**
   * Slices the speaker timeline for an evidence window ([windowStart, windowEnd])
   * and normalizes timestamps to relative seconds [0.0, duration]. Returns an
   * empty array — never fabricated speaker turns — if no real speaker activity
   * was recorded for the window (e.g. the room had no participants, or
   * `AudioRoomGateway` never received a `room:speaker_activity` event for it).
   */
  getSpeakerTimelineSlice(
    roomId: string,
    windowStart: Date,
    windowEnd: Date,
    targetUserId?: string,
    reporterId?: string,
  ): SpeakerTimelineSegment[] {
    const startMs = windowStart.getTime();
    const endMs = windowEnd.getTime();
    const totalDurationSec = Math.max(1, (endMs - startMs) / 1000);

    const roomLogs = this.speakerLogs.get(roomId) || [];
    const activeMap = this.activeSpeakers.get(roomId);
    const activeEvents = activeMap ? Array.from(activeMap.values()) : [];

    const allEvents = [...roomLogs, ...activeEvents];
    const overlapping = allEvents.filter((ev) => {
      const evStart = ev.startedAt.getTime();
      const evEnd = ev.endedAt ? ev.endedAt.getTime() : endMs;
      return evStart < endMs && evEnd > startMs;
    });

    return overlapping
      .map((ev) => {
        const evStartMs = Math.max(startMs, ev.startedAt.getTime());
        const evEndMs = Math.min(endMs, ev.endedAt ? ev.endedAt.getTime() : endMs);
        const startSec = Math.max(0, Number(((evStartMs - startMs) / 1000).toFixed(1)));
        const endSec = Math.min(totalDurationSec, Number(((evEndMs - startMs) / 1000).toFixed(1)));

        return {
          userId: ev.userId,
          name: ev.name,
          seatNumber: ev.seatNumber ?? 1,
          avatarUrl: ev.avatarUrl ?? null,
          startSecond: startSec,
          endSecond: Math.max(startSec + 1, endSec),
          isTargetUser: ev.userId === targetUserId,
          isReporter: ev.userId === reporterId,
        };
      })
      .sort((a, b) => a.startSecond - b.startSecond);
  }

  private trimSpeakerLogs(roomId: string, maxAgeMinutes = 15): void {
    const logs = this.speakerLogs.get(roomId);
    if (!logs) return;
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
    const filtered = logs.filter((l) => (l.endedAt ? l.endedAt.getTime() >= cutoff : true));
    this.speakerLogs.set(roomId, filtered);
  }

  /**
   * Cleans up speaker logs when a room is ended or closed.
   */
  clearRoomBuffer(roomId: string): void {
    this.speakerLogs.delete(roomId);
    this.activeSpeakers.delete(roomId);
    this.logger.debug(`Cleared speaker activity logs for room ${roomId}`);
  }
}
