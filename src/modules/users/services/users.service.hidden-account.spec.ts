import { UsersService } from './users.service';

/**
 * `isHiddenAccount` is the denormalised projection of "this account holds a
 * hidden staff role". The users module owns the column; the admin-identity
 * module is its only writer, and reaches it through this method.
 */
describe('UsersService.setHiddenAccount', () => {
  const repo = { setHiddenAccount: jest.fn() } as any;
  // Real signature is (repo: UsersRepository, config: ConfigService); the
  // constructor reads security.minUserAge eagerly, so the stub must supply it.
  const config = { get: () => ({ minUserAge: 18 }) } as any;
  let service: UsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsersService(repo, config);
  });

  it('marks an account hidden', async () => {
    await service.setHiddenAccount('u-1', true);
    expect(repo.setHiddenAccount).toHaveBeenCalledWith('u-1', true);
  });

  it('clears the hidden flag', async () => {
    await service.setHiddenAccount('u-1', false);
    expect(repo.setHiddenAccount).toHaveBeenCalledWith('u-1', false);
  });
});
