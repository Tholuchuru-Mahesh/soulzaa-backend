import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Password policy: ≥8 chars, ≥1 upper, ≥1 lower, ≥1 number, ≥1 special. */
export const PASSWORD_MIN_LENGTH = 8;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const HAS_NUMBER = /[0-9]/;
const HAS_SPECIAL = /[^A-Za-z0-9]/;

@ValidatorConstraint({ name: 'isStrongPassword', async: false })
export class IsStrongPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return (
      value.length >= PASSWORD_MIN_LENGTH &&
      HAS_UPPER.test(value) &&
      HAS_LOWER.test(value) &&
      HAS_NUMBER.test(value) &&
      HAS_SPECIAL.test(value)
    );
  }

  defaultMessage(_args: ValidationArguments): string {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include an uppercase letter, a lowercase letter, a number, and a special character`;
  }
}

/** Class-validator decorator enforcing the platform password policy. */
export function IsStrongPassword(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      validator: IsStrongPasswordConstraint,
    });
  };
}
