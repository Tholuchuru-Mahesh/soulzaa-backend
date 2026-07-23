import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class AddExpDto {
  @ApiProperty({
    description: 'User ID receiving EXP',
    example: 'd3b07384-d113-424a-8742-e0279d0339d6',
  })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: 'Positive EXP amount to award', example: 500 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ description: 'Configurable EXP source code', example: 'GIFT_SENT' })
  @IsString()
  @IsNotEmpty()
  sourceCode!: string;

  @ApiProperty({
    description: 'Globally unique key for exact-once replay protection',
    example: 'gift_send_txn_99281',
  })
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Optional reference entity type', example: 'GIFT' })
  @IsOptional()
  @IsString()
  referenceType?: string;

  @ApiPropertyOptional({
    description: 'Optional reference entity ID',
    example: 'a1b2c3d4-0000-0000-0000-000000000000',
  })
  @IsOptional()
  @IsString()
  referenceId?: string;
}

export class RemoveExpDto {
  @ApiProperty({ description: 'User ID', example: 'd3b07384-d113-424a-8742-e0279d0339d6' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: 'EXP amount to remove', example: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ description: 'Reason for deduction', example: 'Fraudulent gift reversal' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class UpsertLevelDefinitionDto {
  @ApiProperty({ description: 'Target Level number', example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  level!: number;

  @ApiPropertyOptional({ description: 'Optional title/badge name', example: 'Gold Novice' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ description: 'Required cumulative EXP for level', example: 2500 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  requiredExp!: number;

  @ApiPropertyOptional({ description: 'Icon asset URL' })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({ description: 'Badge asset URL' })
  @IsOptional()
  @IsString()
  badgeUrl?: string;
}

export class UpdateLevelConfigurationDto {
  @ApiProperty({ description: 'Configuration Key', example: 'level.max' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration Value', example: 100 })
  value!: any;
}
