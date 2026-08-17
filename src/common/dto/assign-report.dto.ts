import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Assign a pending report to a moderator for investigation. Identical across
 * every room-type's moderation surface (audio/video rooms today), so it lives
 * here once rather than being redefined per domain.
 */
export class AssignReportDto {
  @ApiProperty({ description: 'The moderator to assign this report to for investigation' })
  @IsUUID()
  assigneeId!: string;
}
