import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FamilyRequestStatus, FamilyRole } from '@prisma/client';
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

  @ApiPropertyOptional({ description: 'S3 object key for the family logo' })
  @IsString()
  @IsOptional()
  logoKey?: string;
}

export class UpdateFamilyDto {
  @ApiPropertyOptional({ description: 'Updated description', maxLength: 200 })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ description: 'Updated S3 logo key' })
  @IsString()
  @IsOptional()
  logoKey?: string;

  @ApiPropertyOptional({ description: 'Whether requests are auto-accepted' })
  @IsBoolean()
  @IsOptional()
  autoAccept?: boolean;
}

export class ManageRequestDto {
  @ApiProperty({ description: 'Decision status', enum: ['APPROVED', 'REJECTED'] })
  @IsEnum(FamilyRequestStatus)
  status!: FamilyRequestStatus;
}

export class PromoteMemberDto {
  @ApiProperty({ description: 'Target user ID to promote or demote' })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({ description: 'New role for the member', enum: ['CO_LEADER', 'ELDER', 'MEMBER'] })
  @IsEnum([FamilyRole.CO_LEADER, FamilyRole.ELDER, FamilyRole.MEMBER])
  role!: FamilyRole;
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
