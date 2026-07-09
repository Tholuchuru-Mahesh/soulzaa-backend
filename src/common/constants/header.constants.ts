/** Canonical HTTP header names used across the platform (lowercase for Node). */
export const HEADERS = {
  REQUEST_ID: 'x-request-id',
  AUTHORIZATION: 'authorization',
  API_KEY: 'x-api-key',
  DEVICE_ID: 'x-device-id',
  PLATFORM: 'x-platform',
  APP_VERSION: 'x-app-version',
  IDEMPOTENCY_KEY: 'idempotency-key',
  ACCEPT_LANGUAGE: 'accept-language',
} as const;
