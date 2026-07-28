import { ApiProperty } from '@nestjs/swagger';

/**
 * One selectable geography node. Deliberately flat and stable — the dashboards
 * bind cascading selectors to this shape, so fields may be added but never
 * removed or renamed.
 */
export class GeographyOptionDto {
  @ApiProperty({ description: 'Stable identifier used for assignment' })
  id!: string;

  @ApiProperty({ description: 'Short code, e.g. IN or KA' })
  code!: string;

  @ApiProperty({ description: 'Display name' })
  name!: string;

  @ApiProperty({ description: 'Inactive nodes are shown but not selectable' })
  isActive!: boolean;
}
