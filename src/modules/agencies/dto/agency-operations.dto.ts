import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

const TASK_STATUSES = ['ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'] as const;

export class AgencyTaskQueryDto {
  @ApiPropertyOptional({ enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: (typeof TASK_STATUSES)[number];

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class DistributeRewardDto {
  @ApiProperty({ description: 'Which shelf row to send from.' })
  @IsUUID()
  inventoryId!: string;

  @ApiProperty({ description: 'Must be a member of the calling agency.' })
  @IsUUID()
  recipientId!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    enum: ['ASSIGNED', 'OWNED'],
    default: 'ASSIGNED',
    description:
      'ASSIGNED binds the reward to the recipient permanently; OWNED lets them gift it on.',
  })
  @IsOptional()
  @IsIn(['ASSIGNED', 'OWNED'])
  kind?: 'ASSIGNED' | 'OWNED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;

  @ApiProperty({ description: 'Stops a repeated tap sending the reward twice.' })
  @IsString()
  @MaxLength(120)
  idempotencyKey!: string;
}
