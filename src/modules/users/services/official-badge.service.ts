import { Inject, Injectable } from '@nestjs/common';
import { VerificationType } from '@prisma/client';
import { ROLE_SOURCE, type IRoleSource } from 'src/common/interfaces/role-source.interface';
import { ProfileRepository } from '../repositories/profile.repository';
import { ProfileService } from './profile.service';

/** The platform role that earns the Official badge. */
export const OFFICIAL_ROLE = 'OFFICIAL';

/**
 * Keeps `user_verification.type` true to the account's roles for OFFICIAL.
 *
 * The client renders the Official badge from the verification row, but an
 * Official is *appointed* through role management — which writes only the RBAC
 * store. Without this projection the badge never appears, however the role was
 * granted. Same shape as AdminIdentityService's `isHiddenAccount` sync: one
 * denormalised column, resynced on any role change.
 *
 * Deliberately unconditional on the role that changed — recomputing costs a
 * single cached role lookup and cannot leave a stale badge behind.
 */
@Injectable()
export class OfficialBadgeService {
  constructor(
    private readonly profiles: ProfileRepository,
    @Inject(ROLE_SOURCE) private readonly roles: IRoleSource,
    private readonly profileService: ProfileService,
  ) {}

  async syncOfficialBadge(userId: string): Promise<void> {
    const existing = await this.profiles.getVerification(userId);
    // No row means no profile aggregate yet; `ensureDefaults` will create one
    // with the badge resolved on first read.
    if (!existing) return;

    // Direct assignment only: the RBAC hierarchy runs ADMIN → COUNTRY_MANAGER →
    // OFFICIAL, so the inherited set would badge every admin as an Official.
    const isOfficial = (await this.roles.getDirectRoleNames(userId)).includes(OFFICIAL_ROLE);

    if (isOfficial) {
      // An appointment outranks a self-submitted request — with one
      // verification row per user, the badge the operator granted wins.
      if (existing.type === VerificationType.OFFICIAL && existing.verified) return;
      await this.profiles.setOfficialBadge(userId, true);
    } else {
      // Only reset what this projection owns. A CREATOR or IDENTITY
      // verification is the user's own approved request and must survive.
      if (existing.type !== VerificationType.OFFICIAL) return;
      await this.profiles.setOfficialBadge(userId, false);
    }

    // The profile snapshot is cached and carries the badge; without this the
    // change stays invisible until the TTL lapses.
    await this.profileService.invalidateProfile(userId);
  }
}
