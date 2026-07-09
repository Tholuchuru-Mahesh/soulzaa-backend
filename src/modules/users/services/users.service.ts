import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, User } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { UsersRepository } from '../repositories/users.repository';
import type {
  CreateIdentityInput,
  IUsersService,
  PromoteGuestInput,
  UserIdentity,
} from '../interfaces/users.service.interface';

/**
 * System of record for account identity. Enforces the platform's identity
 * rules — unique username/email/mobile and the 18+ minimum age — and exposes
 * only the IUsersService contract to other modules (auth). Uniqueness is
 * enforced both by pre-checks and by catching the DB unique violation (P2002),
 * so concurrent registrations still fail cleanly and idempotently.
 */
@Injectable()
export class UsersService implements IUsersService {
  private readonly minAge: number;

  constructor(
    private readonly repo: UsersRepository,
    config: ConfigService,
  ) {
    this.minAge = Number(config.get('security', { infer: true })!.minUserAge);
  }

  // ---- Queries ----

  async findById(id: string): Promise<UserIdentity | null> {
    return this.toIdentity(await this.repo.findById(id));
  }

  async findByEmail(email: string): Promise<UserIdentity | null> {
    return this.toIdentity(await this.repo.findByEmail(email.toLowerCase()));
  }

  async findByMobile(mobile: string): Promise<UserIdentity | null> {
    return this.toIdentity(await this.repo.findByMobile(mobile));
  }

  async findByUsername(username: string): Promise<UserIdentity | null> {
    return this.toIdentity(await this.repo.findByUsername(username));
  }

  async isEmailTaken(email: string): Promise<boolean> {
    return (await this.repo.findByEmail(email.toLowerCase())) !== null;
  }

  async isMobileTaken(mobile: string): Promise<boolean> {
    return (await this.repo.findByMobile(mobile)) !== null;
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    return (await this.repo.findByUsername(username)) !== null;
  }

  // ---- Commands ----

  async createIdentity(input: CreateIdentityInput): Promise<UserIdentity> {
    if (input.dateOfBirth) this.assertMinimumAge(input.dateOfBirth);

    try {
      // Creates the identity row + default profile/statistics/verification rows
      // atomically (all users-module-owned tables).
      const user = await this.repo.createWithProfile({
        username: input.username,
        email: input.email ? input.email.toLowerCase() : null,
        mobile: input.mobile ?? null,
        fullName: input.fullName ?? null,
        gender: input.gender ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        country: input.country ?? null,
        preferredLanguage: input.preferredLanguage ?? null,
        roles: input.roles ?? ['USER'],
        isGuest: input.isGuest ?? false,
      });
      return this.toIdentity(user)!;
    } catch (err) {
      throw this.mapUniqueViolation(err);
    }
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.repo.update(id, { emailVerifiedAt: new Date() });
  }

  async markMobileVerified(id: string): Promise<void> {
    await this.repo.update(id, { mobileVerifiedAt: new Date() });
  }

  async promoteGuest(id: string, input: PromoteGuestInput): Promise<UserIdentity> {
    if (input.dateOfBirth) this.assertMinimumAge(input.dateOfBirth);
    try {
      const user = await this.repo.update(id, {
        isGuest: false,
        ...(input.username !== undefined && { username: input.username }),
        ...(input.email !== undefined && { email: input.email ? input.email.toLowerCase() : null }),
        ...(input.mobile !== undefined && { mobile: input.mobile }),
        ...(input.fullName !== undefined && { fullName: input.fullName }),
        ...(input.gender !== undefined && { gender: input.gender }),
        ...(input.dateOfBirth !== undefined && { dateOfBirth: input.dateOfBirth }),
        ...(input.country !== undefined && { country: input.country }),
        ...(input.preferredLanguage !== undefined && {
          preferredLanguage: input.preferredLanguage,
        }),
        updatedBy: id,
      });
      return this.toIdentity(user)!;
    } catch (err) {
      throw this.mapUniqueViolation(err);
    }
  }

  async updateContact(
    id: string,
    contact: { email?: string; mobile?: string },
  ): Promise<UserIdentity> {
    try {
      const user = await this.repo.update(id, {
        ...(contact.email !== undefined && { email: contact.email.toLowerCase() }),
        ...(contact.mobile !== undefined && { mobile: contact.mobile }),
        updatedBy: id,
      });
      return this.toIdentity(user)!;
    } catch (err) {
      throw this.mapUniqueViolation(err);
    }
  }

  // ---- Helpers ----

  /** Throw UNDERAGE if the DOB implies an age below the platform minimum. */
  private assertMinimumAge(dob: Date): void {
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const monthDiff = now.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age--;
    if (age < this.minAge) {
      throw new BusinessException(
        ERROR_CODES.UNDERAGE,
        `Minimum age is ${this.minAge} years`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Map a Prisma unique-constraint violation to a field-specific CONFLICT. */
  private mapUniqueViolation(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined) ?? [];
      if (target.includes('mobile')) {
        return new BusinessException(
          ERROR_CODES.DUPLICATE_MOBILE,
          'Mobile number already exists',
          HttpStatus.CONFLICT,
        );
      }
      if (target.includes('email')) {
        return new BusinessException(
          ERROR_CODES.DUPLICATE_EMAIL,
          'Email already exists',
          HttpStatus.CONFLICT,
        );
      }
      if (target.includes('username')) {
        return new BusinessException(
          ERROR_CODES.DUPLICATE_USERNAME,
          'Username already taken',
          HttpStatus.CONFLICT,
        );
      }
      return new BusinessException(
        ERROR_CODES.CONFLICT,
        'Account already exists',
        HttpStatus.CONFLICT,
      );
    }
    return err;
  }

  private toIdentity(user: User | null): UserIdentity | null {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      mobile: user.mobile,
      fullName: user.fullName,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      country: user.country,
      preferredLanguage: user.preferredLanguage,
      roles: user.roles,
      isGuest: user.isGuest,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      mobileVerifiedAt: user.mobileVerifiedAt,
      createdAt: user.createdAt,
    };
  }
}
