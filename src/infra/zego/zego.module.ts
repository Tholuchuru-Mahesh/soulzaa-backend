import { Global, Module } from '@nestjs/common';
import { ZegoCloudRecordingService } from './zego-cloud-recording.service';
import { ZegoTokenService } from './zego-token.service';

/**
 * ZEGOCLOUD voice/RTC token issuance and Cloud Recording. @Global so the
 * audio-room voice layer resolves ZegoTokenService without importing this
 * module (mirrors AgoraModule).
 */
@Global()
@Module({
  providers: [ZegoTokenService, ZegoCloudRecordingService],
  exports: [ZegoTokenService, ZegoCloudRecordingService],
})
export class ZegoModule {}
