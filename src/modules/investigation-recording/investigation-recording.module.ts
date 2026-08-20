import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { WorkforceScopeModule } from 'src/modules/mobile-workforce/workforce-scope.module';
import { ZegoRecordingCallbackController } from './controllers/zego-recording-callback.controller';
import { InvestigationRecordingController } from './controllers/investigation-recording.controller';
import { InvestigationRecordingExpiryScheduler } from './services/investigation-recording-expiry.scheduler';
import { InvestigationRecordingService } from './services/investigation-recording.service';
import { EvidenceRecordingProcessorService } from './services/evidence-recording-processor.service';
import { RoomRecordingLifecycleService } from './services/room-recording-lifecycle.service';

// RoomMediaBufferService is provided globally by RoomMediaBufferModule
// (src/infra/room-media-buffer) so AudioRoomGateway and this module resolve
// the same singleton without a cross-module import between them.
@Module({
  imports: [PrismaModule, WorkforceScopeModule],
  controllers: [InvestigationRecordingController, ZegoRecordingCallbackController],
  providers: [
    InvestigationRecordingService,
    InvestigationRecordingExpiryScheduler,
    EvidenceRecordingProcessorService,
    RoomRecordingLifecycleService,
  ],
  exports: [
    InvestigationRecordingService,
    EvidenceRecordingProcessorService,
    RoomRecordingLifecycleService,
  ],
})
export class InvestigationRecordingModule {}
