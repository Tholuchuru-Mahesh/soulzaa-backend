import { Global, Module } from '@nestjs/common';
import { PrivacyController } from './controllers/privacy.controller';
import { PRIVACY_SERVICE } from './interfaces/privacy.interface';
import { RELATIONSHIP_SERVICE } from './interfaces/relationship-provider.interface';
import { PrivacySocketListener } from './listeners/privacy-socket.listener';
import { PrivacyRepository } from './repositories/privacy.repository';
import { NullRelationshipProvider } from './services/null-relationship.provider';
import { PrivacyService } from './services/privacy.service';

/**
 * Privacy & Safety domain — the authoritative store for per-user visibility/
 * permission levels (privacy_settings), the block list (blocked_users) and
 * general preferences (user_preferences), plus a cached check engine, privacy
 * events, and realtime socket sync.
 *
 * @Global so consumers (profile, and later chat/calls) resolve PRIVACY_SERVICE
 * by the interface token without importing this module. RELATIONSHIP_SERVICE is
 * a null stub today (no social graph); a future friends/followers module
 * rebinds it.
 */
@Global()
@Module({
  controllers: [PrivacyController],
  providers: [
    PrivacyRepository,
    PrivacyService,
    NullRelationshipProvider,
    PrivacySocketListener,
    { provide: PRIVACY_SERVICE, useExisting: PrivacyService },
    { provide: RELATIONSHIP_SERVICE, useClass: NullRelationshipProvider },
  ],
  exports: [PRIVACY_SERVICE],
})
export class PrivacyModule {}
