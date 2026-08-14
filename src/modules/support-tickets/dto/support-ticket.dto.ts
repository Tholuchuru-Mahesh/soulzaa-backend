import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum SupportTicketStatusDto {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
  ESCALATED = 'ESCALATED',
}

export enum SupportTicketPriorityDto {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum SupportTicketCategoryDto {
  ACCOUNT = 'ACCOUNT',
  BILLING = 'BILLING',
  CONTENT = 'CONTENT',
  TECHNICAL = 'TECHNICAL',
  ABUSE = 'ABUSE',
  OTHER = 'OTHER',
}

export class CreateSupportTicketDto {
  @ApiProperty({ description: 'Short title describing the issue', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(200)
  declare title: string;

  @ApiProperty({ description: 'Full description of the issue', maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(5000)
  declare description: string;

  @ApiPropertyOptional({ enum: SupportTicketCategoryDto, default: SupportTicketCategoryDto.OTHER })
  @IsOptional()
  @IsEnum(SupportTicketCategoryDto)
  category?: SupportTicketCategoryDto;

  @ApiPropertyOptional({ enum: SupportTicketPriorityDto, default: SupportTicketPriorityDto.MEDIUM })
  @IsOptional()
  @IsEnum(SupportTicketPriorityDto)
  priority?: SupportTicketPriorityDto;
}

export class ReplyToTicketDto {
  @ApiProperty({ description: 'Reply message content', maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(5000)
  declare message: string;
}

export class UpdateTicketStatusDto {
  @ApiProperty({ enum: SupportTicketStatusDto })
  @IsEnum(SupportTicketStatusDto)
  declare status: SupportTicketStatusDto;
}

export class AssignTicketDto {
  @ApiProperty({ description: 'User ID of the Official to assign to' })
  @IsUUID()
  declare officialId: string;
}

export class EscalateTicketDto {
  @ApiPropertyOptional({ description: 'Reason for escalating to Admin' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
