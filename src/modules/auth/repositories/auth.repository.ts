import { Injectable } from '@nestjs/common';
import { AuthProviderType, Prisma, UserAuthProvider, UserCredential } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Prisma access for the auth-owned tables (credentials, providers, password
 * resets). Thin data layer — flow logic and business rules live in the services.
 * Writes are idempotent where the schema allows (upserts keyed on unique
 * constraints) so retried operations converge.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Credentials ----

  getCredential(userId: string): Promise<UserCredential | null> {
    return this.prisma.userCredential.findUnique({ where: { userId } });
  }

  upsertCredential(userId: string, passwordHash: string | null): Promise<UserCredential> {
    return this.prisma.userCredential.upsert({
      where: { userId },
      create: { userId, passwordHash, passwordUpdatedAt: passwordHash ? new Date() : null },
      update: { passwordHash, passwordUpdatedAt: passwordHash ? new Date() : null },
    });
  }

  // ---- Auth providers ----

  findProvider(
    provider: AuthProviderType,
    providerUserId: string,
  ): Promise<UserAuthProvider | null> {
    return this.prisma.userAuthProvider.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
    });
  }

  upsertProvider(input: {
    userId: string;
    provider: AuthProviderType;
    providerUserId?: string | null;
    email?: string | null;
  }): Promise<UserAuthProvider> {
    const { userId, provider, providerUserId = null, email = null } = input;
    // Social providers have a unique (provider, providerUserId); PASSWORD/MOBILE_OTP
    // markers may not, so fall back to create when there is no providerUserId.
    if (providerUserId) {
      return this.prisma.userAuthProvider.upsert({
        where: { provider_providerUserId: { provider, providerUserId } },
        create: { userId, provider, providerUserId, email },
        update: { email },
      });
    }
    return this.prisma.userAuthProvider.create({
      data: { userId, provider, providerUserId, email },
    });
  }

  async ensureProviderMarker(userId: string, provider: AuthProviderType): Promise<void> {
    const existing = await this.prisma.userAuthProvider.findFirst({ where: { userId, provider } });
    if (!existing) {
      await this.prisma.userAuthProvider.create({ data: { userId, provider } });
    }
  }

  // ---- Password reset tokens ----

  createPasswordResetToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    return this.prisma.passwordResetToken.create({ data: input }).then(() => undefined);
  }

  findPasswordResetToken(tokenHash: string) {
    return this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  }

  consumePasswordResetToken(id: string): Promise<Prisma.BatchPayload> {
    return this.prisma.passwordResetToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  invalidateUserResetTokens(userId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}
