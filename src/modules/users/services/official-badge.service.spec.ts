import { VerificationStatus, VerificationType } from '@prisma/client';
import { OfficialBadgeService } from './official-badge.service';

/**
 * The profile badge reads `user_verification.type`, but granting the OFFICIAL
 * role only writes the RBAC store. These cover the projection that keeps the
 * two in step.
 */
describe('OfficialBadgeService.syncOfficialBadge', () => {
  const profiles = { getVerification: jest.fn(), setOfficialBadge: jest.fn() } as any;
  const roles = {
    getDirectRoleNames: jest.fn(),
    getRoleNames: jest.fn(),
    getUserIdsWithAnyRole: jest.fn(),
  } as any;
  const profileService = { invalidateProfile: jest.fn() } as any;
  let service: OfficialBadgeService;

  const verification = (over: Record<string, unknown> = {}) => ({
    userId: 'u-1',
    verified: false,
    status: VerificationStatus.NONE,
    type: null,
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OfficialBadgeService(profiles, roles, profileService);
  });

  it('grants the badge when the account holds OFFICIAL', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['OFFICIAL', 'USER']);
    profiles.getVerification.mockResolvedValue(verification());

    await service.syncOfficialBadge('u-1');

    expect(profiles.setOfficialBadge).toHaveBeenCalledWith('u-1', true);
  });

  it('clears the badge when the OFFICIAL role is revoked', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['USER']);
    profiles.getVerification.mockResolvedValue(
      verification({
        verified: true,
        status: VerificationStatus.APPROVED,
        type: VerificationType.OFFICIAL,
      }),
    );

    await service.syncOfficialBadge('u-1');

    expect(profiles.setOfficialBadge).toHaveBeenCalledWith('u-1', false);
  });

  it('leaves a verification of another type alone when the account is not an official', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['USER']);
    profiles.getVerification.mockResolvedValue(
      verification({
        verified: true,
        status: VerificationStatus.APPROVED,
        type: VerificationType.CREATOR,
      }),
    );

    await service.syncOfficialBadge('u-1');

    expect(profiles.setOfficialBadge).not.toHaveBeenCalled();
  });

  it('takes precedence over a pending request of another type', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['OFFICIAL']);
    profiles.getVerification.mockResolvedValue(
      verification({ status: VerificationStatus.PENDING, type: VerificationType.CREATOR }),
    );

    await service.syncOfficialBadge('u-1');

    expect(profiles.setOfficialBadge).toHaveBeenCalledWith('u-1', true);
  });

  it('writes nothing when the badge already matches the role', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['OFFICIAL']);
    profiles.getVerification.mockResolvedValue(
      verification({
        verified: true,
        status: VerificationStatus.APPROVED,
        type: VerificationType.OFFICIAL,
      }),
    );

    await service.syncOfficialBadge('u-1');

    expect(profiles.setOfficialBadge).not.toHaveBeenCalled();
  });

  it('invalidates the cached profile so the badge appears without waiting for the TTL', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['OFFICIAL']);
    profiles.getVerification.mockResolvedValue(verification());

    await service.syncOfficialBadge('u-1');

    expect(profileService.invalidateProfile).toHaveBeenCalledWith('u-1');
  });

  it('does not invalidate the cached profile when nothing changed', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['USER']);
    profiles.getVerification.mockResolvedValue(verification());

    await service.syncOfficialBadge('u-1');

    expect(profileService.invalidateProfile).not.toHaveBeenCalled();
  });

  it('does not badge an account that only inherits OFFICIAL through the hierarchy', async () => {
    // The RBAC hierarchy runs ADMIN → COUNTRY_MANAGER → OFFICIAL, so an admin's
    // effective roles contain OFFICIAL. The badge states who the account *is*,
    // not what it may do, so only a direct appointment earns it.
    roles.getDirectRoleNames.mockResolvedValue(['ADMIN']);
    roles.getRoleNames.mockResolvedValue(['ADMIN', 'COUNTRY_MANAGER', 'OFFICIAL', 'MODERATOR']);
    profiles.getVerification.mockResolvedValue(verification());

    await service.syncOfficialBadge('u-1');

    expect(profiles.setOfficialBadge).not.toHaveBeenCalled();
  });

  it('ignores an account with no verification row', async () => {
    roles.getDirectRoleNames.mockResolvedValue(['OFFICIAL']);
    profiles.getVerification.mockResolvedValue(null);

    await service.syncOfficialBadge('u-1');

    expect(profiles.setOfficialBadge).not.toHaveBeenCalled();
  });
});
