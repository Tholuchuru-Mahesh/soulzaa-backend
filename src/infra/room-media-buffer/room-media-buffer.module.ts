import { Global, Module } from '@nestjs/common';
import { RoomMediaBufferService } from 'src/modules/investigation-recording/services/room-media-buffer.service';

/**
 * Registers `RoomMediaBufferService` (the real-time speaker-activity tracker
 * used to sync evidence-recording timelines) at the infra layer so both
 * `SocketModule` (AudioRoomGateway, which records live speaker turns off the
 * `room:speaker_activity` socket event) and `InvestigationRecordingModule`
 * (which reads the timeline back when packaging evidence) resolve the same
 * singleton without a cross-feature-module import between them.
 *
 * Before this module existed, AudioRoomGateway declared the service as
 * `@Optional()` and nothing provided it in SocketModule's scope, so it was
 * always `undefined` at runtime — every recorded speaker activity event was
 * silently dropped and evidence timelines always fell back to a synthesized
 * placeholder instead of real speaker turns.
 */
@Global()
@Module({
  providers: [RoomMediaBufferService],
  exports: [RoomMediaBufferService],
})
export class RoomMediaBufferModule {}
