import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class CreateCountryDto {
  @ApiProperty({ description: 'Country ISO Code (2-letter or 3-letter uppercase)', example: 'IN' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 5)
  code!: string;

  @ApiProperty({ description: 'Country name', example: 'India' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Optional country description or notes' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Initial active status', default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateCountryDto {
  @ApiPropertyOptional({ description: 'Updated country name', example: 'Republic of India' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Updated country description' })
  @IsString()
  @IsOptional()
  description?: string;
}
