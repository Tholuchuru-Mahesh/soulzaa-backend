import { Global, Module } from '@nestjs/common';
import { PrivacyController } from './controllers/privacy.controller';
import { PRIVACY_SERVICE } from './interfaces/privacy.interface';
import { PrivacySocketListener } from './listeners/privacy-socket.listener';
import { PrivacyRepository } from './repositories/privacy.repository';
import { PrivacyService } from './services/privacy.service';

/**
 * Privacy & Safety domain — the authoritative store for per-user visibility/
 * permission levels (privacy_settings), the block list (blocked_users) and
 * general preferences (user_preferences), plus a cached check engine, privacy
 * events, and realtime socket sync.
 *
 * @Global so consumers (profile, and later chat/calls) resolve PRIVACY_SERVICE
 * by the interface token without importing this module. RELATIONSHIP_SERVICE
 * (consumed by the check engine for FRIENDS_ONLY / FOLLOWERS_ONLY) is bound by
 * the @Global SocialModule to the real social graph; PrivacyService resolves it
 * ambiently from there.
 */
@Global()
@Module({
  controllers: [PrivacyController],
  providers: [
    PrivacyRepository,
    PrivacyService,
    PrivacySocketListener,
    { provide: PRIVACY_SERVICE, useExisting: PrivacyService },
  ],
  exports: [PRIVACY_SERVICE],
})
export class PrivacyModule {}
