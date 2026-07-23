import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateRegionDto {
  @ApiProperty({
    description: 'Parent State UUID',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  @IsUUID()
  @IsNotEmpty()
  stateId!: string;

  @ApiProperty({ description: 'Region Code unique within State', example: 'BLR' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 10)
  code!: string;

  @ApiProperty({ description: 'Region name', example: 'Bengaluru Region' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Optional region description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Initial active status', default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateRegionDto {
  @ApiPropertyOptional({
    description: 'Updated region name',
    example: 'Greater Bengaluru Metropolitan',
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Updated region description' })
  @IsString()
  @IsOptional()
  description?: string;
}
