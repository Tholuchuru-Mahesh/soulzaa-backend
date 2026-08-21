import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ContentRequestCategory, ContentRequestStatus } from '@prisma/client';

export class CreateContentRequestDto {
  @ApiPropertyOptional({ enum: ContentRequestCategory, default: 'OTHER' })
  @IsOptional()
  @IsEnum(ContentRequestCategory)
  category?: ContentRequestCategory;

  @ApiProperty({ description: 'Brief title for the content request' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Detailed description of the issue' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'ID of the subject user the request is about' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({
    description: 'Reference ID of the content item (roomId, streamId, postId, etc.)',
  })
  @IsOptional()
  @IsString()
  referenceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: Record<string, any>;
}

export class UpdateContentRequestDto {
  @ApiPropertyOptional({ enum: ContentRequestStatus })
  @IsOptional()
  @IsEnum(ContentRequestStatus)
  status?: ContentRequestStatus;

  @ApiPropertyOptional({ enum: ContentRequestCategory })
  @IsOptional()
  @IsEnum(ContentRequestCategory)
  category?: ContentRequestCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: Record<string, any>;
}
