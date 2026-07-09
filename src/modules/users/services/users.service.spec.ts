import { ConfigService } from '@nestjs/config';
import { Prisma, User } from '@prisma/client';
import { UsersRepository } from '../repositories/users.repository';
import { UsersService } from './users.service';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    username: 'aditya',
    email: 'aditya@example.com',
    mobile: '+15551234567',
    fullName: 'Aditya',
    gender: null,
    dateOfBirth: new Date('2000-01-01'),
    country: 'IN',
    preferredLanguage: 'en',
    roles: ['USER'],
    isGuest: false,
    status: 'ACTIVE',
    emailVerifiedAt: null,
    mobileVerifiedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as User;
}

describe('UsersService', () => {
  let repo: jest.Mocked<
    Pick<
      UsersRepository,
      'createWithProfile' | 'update' | 'findByEmail' | 'findByMobile' | 'findByUsername'
    >
  >;
  let service: UsersService;

  beforeEach(() => {
    repo = {
      createWithProfile: jest.fn(),
      update: jest.fn(),
      findByEmail: jest.fn(),
      findByMobile: jest.fn(),
      findByUsername: jest.fn(),
    };
    const config = { get: () => ({ minUserAge: 18 }) } as unknown as ConfigService;
    service = new UsersService(repo as unknown as UsersRepository, config);
  });

  it('creates an identity and returns the read model', async () => {
    repo.createWithProfile.mockResolvedValue(makeUser());
    const result = await service.createIdentity({
      username: 'aditya',
      email: 'Aditya@Example.com',
      mobile: '+15551234567',
      dateOfBirth: new Date('2000-01-01'),
    });
    expect(result.id).toBe('u1');
    // Email is normalised to lowercase before persisting.
    expect(repo.createWithProfile.mock.calls[0][0].email).toBe('aditya@example.com');
  });

  it('rejects an underage date of birth', async () => {
    const recent = new Date();
    recent.setFullYear(recent.getFullYear() - 15);
    await expect(
      service.createIdentity({ username: 'kid', dateOfBirth: recent }),
    ).rejects.toMatchObject({ errorCode: 'UNDERAGE' });
    expect(repo.createWithProfile).not.toHaveBeenCalled();
  });

  it('maps a duplicate-mobile unique violation to DUPLICATE_MOBILE', async () => {
    repo.createWithProfile.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['mobile'] },
      }),
    );
    await expect(
      service.createIdentity({ username: 'aditya', mobile: '+15551234567' }),
    ).rejects.toMatchObject({ errorCode: 'DUPLICATE_MOBILE' });
  });

  it('reports whether an email is taken', async () => {
    repo.findByEmail.mockResolvedValueOnce(makeUser()).mockResolvedValueOnce(null);
    expect(await service.isEmailTaken('a@b.com')).toBe(true);
    expect(await service.isEmailTaken('a@b.com')).toBe(false);
  });
});
