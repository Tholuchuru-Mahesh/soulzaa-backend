import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { RoomRecordingLifecycleService } from 'src/modules/investigation-recording/services/room-recording-lifecycle.service';
import {
  AUDIO_ROOM_EVENTS,
  type RoomDeletedEvent,
  type RoomEndedEvent,
} from '../events/audio-room.events';
import {
  AUDIO_ROOM_VOICE_EVENTS,
  type VoiceJoinedEvent,
  type VoiceLeftEvent,
} from '../events/audio-room-voice.events';

/**
 * Starts and stops the real, continuous evidence-recording capture for a
 * room's whole voice-session lifetime — required because Cloud Recording can
 * only record forward from when it starts, so a true "2 minutes before the
 * report" evidence window depends on recording already running by the time
 * anyone files a report, not started reactively at report time.
 *
 * Mirrors `VoiceLifecycleListener`'s one-directional coupling: this listens
 * on the event bus rather than VoiceService depending on the investigation-
 * recording module directly.
 */
@Injectable()
export class RoomRecordingLifecycleListener implements OnModuleInit {
  private readonly logger = new Logger(RoomRecordingLifecycleListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly recording: RoomRecordingLifecycleService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<VoiceJoinedEvent>(AUDIO_ROOM_VOICE_EVENTS.JOINED, (e) => {
      if (e.payload.participantCount !== 1) return;
      void this.recording.ensureRecordingStarted(e.payload.roomId, 'audio').catch((err) => {
        this.logger.error(
          `ensureRecordingStarted failed for room ${e.payload.roomId}: ${(err as Error).message}`,
        );
      });
    });

    this.bus.subscribe<VoiceLeftEvent>(AUDIO_ROOM_VOICE_EVENTS.LEFT, (e) => {
      if (e.payload.participantCount !== 0) return;
      void this.recording.stopRecording(e.payload.roomId).catch((err) => {
        this.logger.warn(
          `stopRecording failed for room ${e.payload.roomId}: ${(err as Error).message}`,
        );
      });
    });

    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) => {
      void this.recording.stopRecording(e.payload.roomId).catch(() => {});
    });
    this.bus.subscribe<RoomDeletedEvent>(AUDIO_ROOM_EVENTS.DELETED, (e) => {
      void this.recording.stopRecording(e.payload.roomId).catch(() => {});
    });
  }
}
