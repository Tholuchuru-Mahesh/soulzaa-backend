import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcryptjs';

/**
 * Password hashing (bcrypt via bcryptjs — same $2 format, no native build).
 * Infrastructure only: the auth domain module calls hash() on register and
 * verify() on login.
 */
@Injectable()
export class PasswordService {
  private readonly saltRounds: number;

  constructor(config: ConfigService) {
    // configuration.ts surfaces raw process.env strings, so coerce to a number.
    this.saltRounds = Number(config.get('auth', { infer: true })!.bcryptSaltRounds);
  }

  hash(plain: string): Promise<string> {
    return hash(plain, this.saltRounds);
  }

  verify(plain: string, hashed: string): Promise<boolean> {
    return compare(plain, hashed);
  }
}
