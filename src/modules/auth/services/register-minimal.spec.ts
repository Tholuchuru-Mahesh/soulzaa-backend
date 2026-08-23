jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
  getApps: jest.fn(() => []),
  cert: jest.fn(),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));

import { AuthService } from './auth.service';

/**
 * Sign-up collects an email and a password and nothing else; name, gender,
 * date of birth and country are gathered after login by the profile-completion
 * gate. Registration therefore has to succeed without them — and, critically,
 * must not attach a mobile number, because the router forces OTP verification
 * on any account whose mobile is set but unverified, and phone login is off.
 */
describe('AuthService.register — email + password only', () => {
  const makeService = () => {
    const users = {
      createIdentity: jest.fn().mockResolvedValue({
        id: 'u-1',
        username: 'vasu',
        email: 'vasu@soulzaa.com',
        mobile: null,
      }),
      findByUsername: jest.fn().mockResolvedValue(null),
    };
    const repo = {
      upsertCredential: jest.fn(),
      ensureProviderMarker: jest.fn(),
    };
    const otp = { generate: jest.fn() };
    const passwords = { hash: jest.fn().mockResolvedValue('hashed') };
    const bus = { publish: jest.fn() };

    const service = Object.create(AuthService.prototype) as AuthService;
    Object.assign(service, {
      users,
      repo,
      otp,
      passwords,
      bus,
      // `issue` mints tokens and touches sessions; the contract under test is
      // what register writes, so it is stubbed out.
      issue: jest.fn().mockResolvedValue({ user: { id: 'u-1' }, tokens: {} }),
    });
    return { service, users, repo, otp };
  };

  const minimal = {
    email: 'vasu@soulzaa.com',
    password: 'Str0ng@Pass',
  } as never;

  it('creates the account without a name, date of birth or country', async () => {
    const { service, users } = makeService();

    await service.register(minimal, {} as never);

    expect(users.createIdentity).toHaveBeenCalledTimes(1);
    const arg = users.createIdentity.mock.calls[0][0];
    expect(arg.email).toBe('vasu@soulzaa.com');
    expect(arg.fullName ?? null).toBeNull();
    expect(arg.dateOfBirth ?? null).toBeNull();
    expect(arg.country ?? null).toBeNull();
  });

  it('mints a username from the email', async () => {
    const { service, users } = makeService();

    await service.register(minimal, {} as never);

    expect(users.createIdentity.mock.calls[0][0].username).toBe('vasu');
  });

  it('leaves mobile unset so the OTP gate never triggers', async () => {
    const { service, users, otp } = makeService();

    await service.register(minimal, {} as never);

    expect(users.createIdentity.mock.calls[0][0].mobile ?? null).toBeNull();
    expect(otp.generate).not.toHaveBeenCalled();
  });

  it('still stores the password', async () => {
    const { service, repo } = makeService();

    await service.register(minimal, {} as never);

    expect(repo.upsertCredential).toHaveBeenCalledWith('u-1', 'hashed');
  });

  it('still sends the OTP when a mobile is supplied', async () => {
    const { service, users, otp } = makeService();

    await service.register(
      { ...(minimal as object), mobile: '+919876543210' } as never,
      {} as never,
    );

    expect(users.createIdentity.mock.calls[0][0].mobile).toBe('+919876543210');
    expect(otp.generate).toHaveBeenCalledTimes(1);
  });
});
