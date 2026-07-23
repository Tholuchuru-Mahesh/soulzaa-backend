import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateWorkforceStatusDto {
  @ApiProperty({
    description: 'Active operational status (true = active, false = inactive)',
    example: true,
  })
  @IsBoolean()
  @IsNotEmpty()
  isActive!: boolean;

  @ApiPropertyOptional({ description: 'Reason for status update', example: 'Operational rotation' })
  @IsString()
  @IsOptional()
  reason?: string;
}
