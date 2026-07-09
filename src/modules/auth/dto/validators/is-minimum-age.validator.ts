import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Compute full years between a date-of-birth and now. */
export function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

@ValidatorConstraint({ name: 'isMinimumAge', async: false })
export class IsMinimumAgeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [minAge] = args.constraints as [number];
    if (typeof value !== 'string' && !(value instanceof Date)) return false;
    const dob = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dob.getTime())) return false;
    return ageInYears(dob) >= minAge;
  }

  defaultMessage(args: ValidationArguments): string {
    const [minAge] = args.constraints as [number];
    return `Minimum age is ${minAge} years`;
  }
}

/** Requires the ISO date value to be at least `minAge` years in the past. */
export function IsMinimumAge(minAge: number, options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      constraints: [minAge],
      options,
      validator: IsMinimumAgeConstraint,
    });
  };
}
