/** Per-request context (correlation id + client info), built from the request. */
export interface RequestMetadata {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  timestamp: string;
}
