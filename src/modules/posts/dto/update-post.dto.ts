import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class UpdatePostDto {
  @ApiPropertyOptional({ description: 'Optional text description for the post' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Array of photo media keys or URLs to associate with the post',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaKeys?: string[];
}
