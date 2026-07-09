import { IsStrongPasswordConstraint } from './is-strong-password.validator';

describe('IsStrongPasswordConstraint', () => {
  const c = new IsStrongPasswordConstraint();

  it('accepts a password meeting every rule', () => {
    expect(c.validate('Str0ng@Pass')).toBe(true);
  });

  it.each([
    ['too short', 'Ab1@def'],
    ['no uppercase', 'str0ng@pass'],
    ['no lowercase', 'STR0NG@PASS'],
    ['no number', 'Strong@Pass'],
    ['no special char', 'Str0ngPass1'],
  ])('rejects %s', (_label, value) => {
    expect(c.validate(value)).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(c.validate(12345678)).toBe(false);
    expect(c.validate(undefined)).toBe(false);
  });
});
