import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateStateDto {
  @ApiProperty({
    description: 'Parent Country UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  countryId!: string;

  @ApiProperty({ description: 'State Code unique within Country', example: 'KA' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 10)
  code!: string;

  @ApiProperty({ description: 'State / Province name', example: 'Karnataka' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Optional state description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Initial active status', default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateStateDto {
  @ApiPropertyOptional({ description: 'Updated state name', example: 'Karnataka State' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Updated state description' })
  @IsString()
  @IsOptional()
  description?: string;
}
