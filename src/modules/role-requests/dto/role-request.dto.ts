import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoleRequestType } from '@prisma/client';
import { IsArray, IsEnum, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

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

  @ApiPropertyOptional({ description: 'Storage keys for supporting documents', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  documentKeys?: string[];
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
