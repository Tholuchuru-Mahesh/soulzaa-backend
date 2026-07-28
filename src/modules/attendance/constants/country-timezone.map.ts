/**
 * Country → canonical IANA zone. The platform stores only a country on the
 * profile, so a multi-zone country resolves to one representative zone; users
 * elsewhere in that country see a boundary offset from their wall clock. The
 * zone used is recorded on every claim, so correcting an entry here is
 * auditable rather than a silent rewrite of history.
 */
export const COUNTRY_TIMEZONES: Readonly<Record<string, string>> = {
  IN: 'Asia/Kolkata',
  US: 'America/New_York',
  GB: 'Europe/London',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  PK: 'Asia/Karachi',
  BD: 'Asia/Dhaka',
  LK: 'Asia/Colombo',
  NP: 'Asia/Kathmandu',
  ID: 'Asia/Jakarta',
  MY: 'Asia/Kuala_Lumpur',
  SG: 'Asia/Singapore',
  PH: 'Asia/Manila',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  CN: 'Asia/Shanghai',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
  CA: 'America/Toronto',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  NL: 'Europe/Amsterdam',
  TR: 'Europe/Istanbul',
  RU: 'Europe/Moscow',
  EG: 'Africa/Cairo',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
  ZA: 'Africa/Johannesburg',
};

/** IANA zone for a profile country; UTC when unmapped, empty or unset. */
export function resolveTimezone(country: string | null | undefined): string {
  if (!country) return 'UTC';
  return COUNTRY_TIMEZONES[country.trim().toUpperCase()] ?? 'UTC';
}
