import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreatePermissionDto {
  @ApiProperty({
    description: 'Permission code in resource:action or domain.action format',
    example: 'wallet.adjust',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Module/Domain name', example: 'wallet' })
  @IsString()
  @IsNotEmpty()
  module!: string;

  @ApiProperty({ description: 'Action name', example: 'adjust' })
  @IsString()
  @IsNotEmpty()
  action!: string;

  @ApiPropertyOptional({ description: 'Permission Category grouping', example: 'WALLET' })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({
    description: 'Human-readable display title',
    example: 'Adjust User Balance',
  })
  @IsString()
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Detailed explanation of permission',
    example: 'Allows manual credit or debit to user wallets',
  })
  @IsString()
  @IsOptional()
  description?: string;
}
