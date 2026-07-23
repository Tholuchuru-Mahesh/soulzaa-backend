import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class ToggleFeatureFlagDto {
  @ApiPropertyOptional({
    description: 'Explicit enabled status (true/false). If omitted, status will be toggled.',
  })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Optional reason for toggling feature flag' })
  @IsString()
  @IsOptional()
  reason?: string;
}
