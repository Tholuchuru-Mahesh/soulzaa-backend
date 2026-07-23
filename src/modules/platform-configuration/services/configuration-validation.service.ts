import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingValueType } from '@prisma/client';

@Injectable()
export class ConfigurationValidationService {
  /**
   * Validates and serializes setting value according to expected SettingValueType
   */
  validateAndSerialize(key: string, value: any, valueType: SettingValueType): string {
    if (value === null || value === undefined) {
      throw new BadRequestException(`Value for setting '${key}' cannot be null or undefined`);
    }

    switch (valueType) {
      case SettingValueType.STRING:
        return String(value);

      case SettingValueType.NUMBER: {
        const num = Number(value);
        if (isNaN(num)) {
          throw new BadRequestException(
            `Setting '${key}' expects a valid number, received '${value}'`,
          );
        }
        return String(num);
      }

      case SettingValueType.BOOLEAN: {
        if (typeof value === 'boolean') {
          return String(value);
        }
        const strVal = String(value).trim().toLowerCase();
        if (strVal === 'true' || strVal === '1') return 'true';
        if (strVal === 'false' || strVal === '0') return 'false';
        throw new BadRequestException(
          `Setting '${key}' expects a boolean ('true' or 'false'), received '${value}'`,
        );
      }

      case SettingValueType.JSON: {
        try {
          if (typeof value === 'object') {
            return JSON.stringify(value);
          }
          const parsed = JSON.parse(String(value));
          return JSON.stringify(parsed);
        } catch {
          throw new BadRequestException(`Setting '${key}' expects a valid JSON string or object`);
        }
      }

      default:
        return String(value);
    }
  }

  /**
   * Deserializes stored string value to target TypeScript type
   */
  deserialize<T = any>(valueStr: string, valueType: SettingValueType): T {
    switch (valueType) {
      case SettingValueType.NUMBER:
        return Number(valueStr) as any;
      case SettingValueType.BOOLEAN:
        return (valueStr === 'true') as any;
      case SettingValueType.JSON:
        try {
          return JSON.parse(valueStr);
        } catch {
          return valueStr as any;
        }
      case SettingValueType.STRING:
      default:
        return valueStr as any;
    }
  }
}
