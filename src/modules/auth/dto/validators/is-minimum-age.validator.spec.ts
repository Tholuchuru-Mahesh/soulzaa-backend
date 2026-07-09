import { ValidationArguments } from 'class-validator';
import { ageInYears, IsMinimumAgeConstraint } from './is-minimum-age.validator';

describe('ageInYears', () => {
  it('counts full years, accounting for month/day', () => {
    const now = new Date('2026-07-06');
    expect(ageInYears(new Date('2008-07-06'), now)).toBe(18);
    expect(ageInYears(new Date('2008-07-07'), now)).toBe(17); // birthday not yet reached
    expect(ageInYears(new Date('2008-06-30'), now)).toBe(18);
  });
});

describe('IsMinimumAgeConstraint', () => {
  const c = new IsMinimumAgeConstraint();
  const args = { constraints: [18] } as unknown as ValidationArguments;

  it('accepts an 18+ date of birth', () => {
    expect(c.validate('2000-01-01', args)).toBe(true);
  });

  it('rejects an under-18 date of birth', () => {
    const recent = new Date();
    recent.setFullYear(recent.getFullYear() - 10);
    expect(c.validate(recent.toISOString(), args)).toBe(false);
  });

  it('rejects an unparseable value', () => {
    expect(c.validate('not-a-date', args)).toBe(false);
  });
});
