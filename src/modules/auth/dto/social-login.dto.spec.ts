import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SocialLoginDto } from './social-login.dto';

/**
 * Guards the exact failure this file caused in production: the app sent
 * `provider: FACEBOOK` and the API answered
 *
 *   "provider must be one of the following values: GOOGLE, APPLE"
 *
 * That message comes from class-validator's `@IsIn`, so the accepted list is
 * part of the API contract and deserves a test rather than living only in a
 * decorator argument. Widening the enum elsewhere (Prisma, the verifier
 * registry, the command types) does nothing if this list is not widened too —
 * validation runs before any of that code is reached.
 */
describe('SocialLoginDto provider validation', () => {
  const errorsFor = (provider: unknown): string[] => {
    const dto = plainToInstance(SocialLoginDto, { provider, idToken: 'tok' });
    return validateSync(dto).flatMap((e) => Object.values(e.constraints ?? {}));
  };

  it.each(['GOOGLE', 'APPLE', 'FACEBOOK'])('accepts %s', (provider) => {
    expect(errorsFor(provider)).toEqual([]);
  });

  it('rejects a provider the backend has no verifier for', () => {
    expect(errorsFor('TWITTER').join(' ')).toContain('provider');
  });

  it('rejects META — the provider name is FACEBOOK throughout', () => {
    // The button says "continue with meta"; the wire value does not follow it.
    expect(errorsFor('META').join(' ')).toContain('provider');
  });

  it('is case-sensitive, so a lowercase provider is refused', () => {
    expect(errorsFor('facebook').join(' ')).toContain('provider');
  });
});
