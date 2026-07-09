import { Global, Module } from '@nestjs/common';
import { ZegoTokenService } from './zego-token.service';

/**
 * ZEGOCLOUD voice/RTC token issuance. @Global so the audio-room voice layer
 * resolves ZegoTokenService without importing this module (mirrors AgoraModule).
 */
@Global()
@Module({
  providers: [ZegoTokenService],
  exports: [ZegoTokenService],
})
export class ZegoModule {}
