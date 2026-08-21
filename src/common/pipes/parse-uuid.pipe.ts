import { ParseUUIDPipe } from '@nestjs/common';

/**
 * Validates a route/query param is a v4 UUID (all primary keys are UUIDs).
 * Usage: `@Param('id', ParseUuidPipe) id: string`.
 */
export class ParseUuidPipe extends ParseUUIDPipe {
  constructor() {
    super();
  }
}
