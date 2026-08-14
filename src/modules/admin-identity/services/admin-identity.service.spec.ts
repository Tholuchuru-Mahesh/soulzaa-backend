import { HIDDEN_ROLES, AdminIdentityService } from './admin-identity.service';

describe('AdminIdentityService.syncHiddenState', () => {
  const users = { setHiddenAccount: jest.fn(), findById: jest.fn() } as any;
  const roles = { getRoleNames: jest.fn(), getUserIdsWithAnyRole: jest.fn() } as any;
  const profiles = { invalidateProfile: jest.fn() } as any;
  let service: AdminIdentityService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminIdentityService(users, roles, profiles);
  });

  it('hides an account holding ADMIN', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    await service.syncHiddenState('u-1');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-1', true);
  });

  it('hides an account holding SUPER_ADMIN', async () => {
    roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
    await service.syncHiddenState('u-2');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-2', true);
  });

  it('unhides an account whose privileged role was revoked', async () => {
    roles.getRoleNames.mockResolvedValue(['HOST']);
    await service.syncHiddenState('u-3');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-3', false);
  });

  it('hides a MODERATOR — moderator identities are anonymous too', async () => {
    roles.getRoleNames.mockResolvedValue(['MODERATOR']);
    await service.syncHiddenState('u-4');
    expect(users.setHiddenAccount).toHaveBeenCalledWith('u-4', true);
  });

  it('invalidates the cached profile so the change takes effect immediately', async () => {
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    await service.syncHiddenState('u-1');
    expect(profiles.invalidateProfile).toHaveBeenCalledWith('u-1');
  });
});

describe('AdminIdentityService.isHidden', () => {
  const users = { setHiddenAccount: jest.fn(), findById: jest.fn() } as any;
  const roles = { getRoleNames: jest.fn(), getUserIdsWithAnyRole: jest.fn() } as any;
  const profiles = { invalidateProfile: jest.fn() } as any;
  const service = new AdminIdentityService(users, roles, profiles);

  beforeEach(() => jest.clearAllMocks());

  it('reports the flag from the identity', async () => {
    users.findById.mockResolvedValue({ id: 'u-1', isHiddenAccount: true });
    await expect(service.isHidden('u-1')).resolves.toBe(true);
  });

  it('treats an unknown account as not hidden', async () => {
    users.findById.mockResolvedValue(null);
    await expect(service.isHidden('nope')).resolves.toBe(false);
  });
});

describe('AdminIdentityService.backfill', () => {
  const users = { setHiddenAccount: jest.fn(), findById: jest.fn() } as any;
  const roles = { getRoleNames: jest.fn(), getUserIdsWithAnyRole: jest.fn() } as any;
  const profiles = { invalidateProfile: jest.fn() } as any;
  const service = new AdminIdentityService(users, roles, profiles);

  beforeEach(() => jest.clearAllMocks());

  it('marks every existing privileged account hidden', async () => {
    roles.getUserIdsWithAnyRole.mockResolvedValue(['a-1', 'a-2']);

    const result = await service.backfill();

    // Asserted against the constant rather than a literal list, so adding a
    // role to HIDDEN_ROLES does not silently leave the backfill untested.
    expect(roles.getUserIdsWithAnyRole).toHaveBeenCalledWith([...HIDDEN_ROLES]);
    expect(users.setHiddenAccount).toHaveBeenCalledWith('a-1', true);
    expect(users.setHiddenAccount).toHaveBeenCalledWith('a-2', true);
    expect(result).toEqual({ scanned: 2, hidden: 2 });
  });
});
