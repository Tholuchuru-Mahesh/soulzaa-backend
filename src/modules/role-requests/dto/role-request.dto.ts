import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RoleRequestDocumentSlot,
  RoleRequestDocumentStatus,
  RoleRequestType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsMimeType,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SubmitRoleRequestDocumentDto {
  @ApiProperty({ enum: RoleRequestDocumentSlot, description: 'Which document this fills' })
  @IsEnum(RoleRequestDocumentSlot)
  slot!: RoleRequestDocumentSlot;

  @ApiProperty({
    description: 'Key returned by POST /storage/presign with the kyc-documents category',
    example: 'kyc-documents/6f1e.../9b2c....pdf',
  })
  @IsString()
  @MaxLength(512)
  storageKey!: string;

  @ApiProperty({ description: 'Original filename, shown to the reviewer', example: 'aadhaar.pdf' })
  @IsString()
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ description: 'Declared content type; re-checked against the bytes on submit' })
  @IsMimeType()
  contentType!: string;
}

export class SubmitRoleRequestDto {
  @ApiProperty({ enum: RoleRequestType, description: 'Role being requested' })
  @IsEnum(RoleRequestType)
  type!: RoleRequestType;

  @ApiProperty({ description: 'The user the role would be granted to' })
  @IsUUID()
  subjectUserId!: string;

  @ApiPropertyOptional({ description: 'Application form payload' })
  @IsOptional()
  @IsObject()
  formData?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Uploaded supporting documents, one per slot',
    type: [SubmitRoleRequestDocumentDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubmitRoleRequestDocumentDto)
  documents?: SubmitRoleRequestDocumentDto[];

  @ApiPropertyOptional({
    description: 'Deprecated untyped key list. Prefer `documents`.',
    type: [String],
    deprecated: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  documentKeys?: string[];
}

export class ReviewDocumentDto {
  @ApiProperty({ enum: [RoleRequestDocumentStatus.ACCEPTED, RoleRequestDocumentStatus.REJECTED] })
  @IsEnum(RoleRequestDocumentStatus)
  status!: RoleRequestDocumentStatus;

  @ApiPropertyOptional({ description: 'Required when rejecting; shown to the applicant' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class StageActionDto {
  @ApiPropertyOptional({ description: 'Reviewer notes recorded on the audit trail' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Checklist state captured at decision time' })
  @IsOptional()
  @IsObject()
  checklistSnapshot?: Record<string, unknown>;
}

export class RejectRoleRequestDto extends StageActionDto {
  @ApiProperty({ description: 'Why the request was rejected; shown to the subject' })
  @IsString()
  reason!: string;
}
