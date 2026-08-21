import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateFamilyDto {
  @ApiProperty({ description: 'The unique name of the family', minLength: 3, maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @Length(3, 30)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiPropertyOptional({ description: 'A short description of the family', maxLength: 200 })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ description: 'S3 object key or URL for the family logo' })
  @IsString()
  @IsOptional()
  logoKey?: string;

  @ApiPropertyOptional({ description: 'S3 object key or URL for the family logo (alias)' })
  @IsString()
  @IsOptional()
  logo?: string;

  @ApiPropertyOptional({ description: 'Whether anyone can join directly without approval' })
  @IsBoolean()
  @IsOptional()
  autoAccept?: boolean;
}

export class UpdateFamilyDto {
  @ApiPropertyOptional({ description: 'Updated family name', minLength: 3, maxLength: 30 })
  @IsString()
  @IsOptional()
  @Length(3, 30)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({ description: 'A short description of the family', maxLength: 200 })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ description: 'Updated S3 logo key or URL' })
  @IsString()
  @IsOptional()
  logoKey?: string;

  @ApiPropertyOptional({ description: 'Updated S3 logo key or URL (alias)' })
  @IsString()
  @IsOptional()
  logo?: string;

  @ApiPropertyOptional({ description: 'Whether requests are auto-accepted' })
  @IsBoolean()
  @IsOptional()
  autoAccept?: boolean;
}

export class ManageRequestDto {
  @ApiProperty({ description: 'Decision status', enum: ['APPROVED', 'REJECTED'] })
  @IsEnum(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';
}

export class PromoteMemberDto {
  @ApiProperty({ description: 'Target user ID to promote or demote' })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    description: 'New role for the member',
    enum: ['CO_FOUNDER', 'CO_LEADER', 'ELDER', 'MEMBER'],
  })
  @IsEnum(['CO_FOUNDER', 'CO_LEADER', 'ELDER', 'MEMBER', 'FOUNDER', 'LEADER'])
  role!: any;
}

export class KickMemberDto {
  @ApiProperty({ description: 'Member user ID to remove from family' })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;
}

export class TransferLeadershipDto {
  @ApiProperty({ description: 'Member user ID to transfer ownership/leadership to' })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;
}

export class SendFamilyMessageDto {
  @ApiPropertyOptional({ description: 'Message content text' })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  content?: string;

  @ApiPropertyOptional({
    description: 'Type of media attachment',
    enum: ['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO'],
  })
  @IsString()
  @IsOptional()
  mediaType?: string;

  @ApiPropertyOptional({ description: 'Media storage URL or direct link' })
  @IsString()
  @IsOptional()
  mediaUrl?: string;

  @ApiPropertyOptional({ description: 'Media file name' })
  @IsString()
  @IsOptional()
  mediaName?: string;

  @ApiPropertyOptional({ description: 'Media size in bytes' })
  @IsOptional()
  mediaSize?: number;
}

export class SearchFamiliesQueryDto {
  @ApiPropertyOptional({ description: 'Search keyword for family name or tag' })
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ description: 'Search keyword alias' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  limit?: number;
}
