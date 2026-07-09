import { Global, Module } from '@nestjs/common';
import { AgoraTokenService } from './agora-token.service';

@Global()
@Module({
  providers: [AgoraTokenService],
  exports: [AgoraTokenService],
})
export class AgoraModule {}
