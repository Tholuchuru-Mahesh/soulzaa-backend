import { Injectable } from '@nestjs/common';
import { AdminCredential, AdminTrustedDevice } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Prisma access to the staff second-factor tables. Owned by admin-identity —
 * no other module reads or writes them, because a staff TOTP secret leaking
 * into a user-facing query would defeat the factor entirely.
 */
@Injectable()
export class AdminCredentialRepository {
  constructor(private readonly prisma: PrismaService) {}

  getCredential(userId: string): Promise<AdminCredential | null> {
    return this.prisma.adminCredential.findUnique({ where: { userId } });
  }

  /**
   * Upsert rather than create: a restarted enrolment should replace the unused
   * secret instead of colliding on the unique userId.
   */
  async saveSecret(userId: string, totpSecret: string): Promise<void> {
    await this.prisma.adminCredential.upsert({
      where: { userId },
      create: { userId, totpSecret },
      update: { totpSecret, enrolledAt: null },
    });
  }

  async markEnrolled(userId: string): Promise<void> {
    await this.prisma.adminCredential.update({
      where: { userId },
      data: { enrolledAt: new Date() },
    });
  }

  /** Clears the factor entirely, so the operator can enrol a new device. */
  async resetCredential(userId: string): Promise<void> {
    await this.prisma.adminCredential.deleteMany({ where: { userId } });
  }

  // ---- Trusted devices ----

  findTrustedDevice(userId: string, deviceHash: string): Promise<AdminTrustedDevice | null> {
    return this.prisma.adminTrustedDevice.findUnique({
      where: { userId_deviceHash: { userId, deviceHash } },
    });
  }

  /** Records a successful sign-in from this device, refreshing lastSeenAt. */
  async trustDevice(userId: string, deviceHash: string, ipAddress?: string | null): Promise<void> {
    await this.prisma.adminTrustedDevice.upsert({
      where: { userId_deviceHash: { userId, deviceHash } },
      create: { userId, deviceHash, ipAddress: ipAddress ?? null },
      update: { lastSeenAt: new Date(), ipAddress: ipAddress ?? null },
    });
  }
}
