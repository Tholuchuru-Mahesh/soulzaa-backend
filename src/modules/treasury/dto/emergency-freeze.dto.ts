import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class EmergencyFreezeDto {
  @ApiPropertyOptional({
    description:
      'Target feature or economy scope to freeze (e.g. ALL, WALLET, GIFT, WITHDRAWAL, PURCHASE)',
    example: 'ALL',
  })
  @IsString()
  @IsOptional()
  scope?: string = 'ALL';

  @ApiPropertyOptional({ description: 'Reason for emergency freeze/resume action' })
  @IsString()
  @IsOptional()
  reason?: string;
}
