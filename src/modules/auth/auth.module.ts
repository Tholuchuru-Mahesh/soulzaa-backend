import { Module } from '@nestjs/common';
import { AuthController } from './controllers/auth.controller';
import { AUTH_SERVICE } from './interfaces/auth.interface';
import { SOCIAL_VERIFIER } from './interfaces/social-identity-verifier.interface';
import { AuthRepository } from './repositories/auth.repository';
import { AuthService } from './services/auth.service';
import { LoginSecurityService } from './services/login-security.service';
import { AppleVerifier } from './services/social/apple.verifier';
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
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthRepository,
    AuthService,
    LoginSecurityService,
    GoogleVerifier,
    AppleVerifier,
    SocialVerifierRegistry,
    { provide: AUTH_SERVICE, useExisting: AuthService },
    { provide: SOCIAL_VERIFIER, useExisting: SocialVerifierRegistry },
  ],
  exports: [AUTH_SERVICE],
})
export class AuthModule {}
