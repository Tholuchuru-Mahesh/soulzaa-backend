import { Global, Module } from '@nestjs/common';
import { AuthController } from './controllers/auth.controller';
import { AUTH_SERVICE } from './interfaces/auth.interface';
import { SOCIAL_VERIFIER } from './interfaces/social-identity-verifier.interface';
import { AuthRepository } from './repositories/auth.repository';
import { AuthService } from './services/auth.service';
import { LoginSecurityService } from './services/login-security.service';
import { FirebaseService } from './services/firebase.service';
import { AppleVerifier } from './services/social/apple.verifier';
import { FacebookVerifier } from './services/social/facebook.verifier';
import { GoogleVerifier } from './services/social/google.verifier';
import { SocialVerifierRegistry } from './services/social/social-verifier.registry';

/**
 * Auth domain — registration, login (mobile+OTP / email+password / Google /
 * Apple), refresh rotation, logout, verification and password recovery.
 *
 * Depends on the Users identity service (USERS_SERVICE) and the OTP service
 * (OTP_SERVICE) via their interfaces only, plus global infra (Token/Password
 * from AuthInfraModule, Prisma, Redis, EVENT_BUS). Exposes AUTH_SERVICE; all
 * other cross-module coordination is via published events.
 *
 * @Global for the same reason UsersModule and AuthorizationModule are: consumers
 * in other domain modules (AdminProvisioningService) inject AUTH_SERVICE, and the
 * dependency-cruiser boundary rule forbids importing this module's `*.module.ts`
 * — only `interfaces/` and `events/` cross a module edge. Being global is the
 * only mechanism left that lets the exported token resolve.
 */
import { StaffAuthController } from './controllers/staff-auth.controller';
import { AdminIdentityModule } from 'src/modules/admin-identity/admin-identity.module';
import { DeviceModule } from 'src/modules/device/device.module';

@Global()
@Module({
  imports: [AdminIdentityModule, DeviceModule],
  controllers: [AuthController, StaffAuthController],
  providers: [
    AuthRepository,
    AuthService,
    LoginSecurityService,
    FirebaseService,
    GoogleVerifier,
    FacebookVerifier,
    AppleVerifier,
    SocialVerifierRegistry,
    { provide: AUTH_SERVICE, useExisting: AuthService },
    { provide: SOCIAL_VERIFIER, useExisting: SocialVerifierRegistry },
  ],
  exports: [AUTH_SERVICE],
})
export class AuthModule {}
