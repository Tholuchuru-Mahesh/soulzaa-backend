import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsObject,
  IsArray,
} from 'class-validator';

// ── Create Widget Dto ────────────────────────────────────────────────
export class CreateWidgetDto {
  @ApiProperty({ example: 'KPI Widget' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'NUMBER', enum: ['CHART', 'NUMBER', 'TABLE', 'LIST', 'STATE'] })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiProperty({ example: 'total_users' })
  @IsString()
  @IsNotEmpty()
  metricKey!: string;

  @ApiPropertyOptional({ type: [String], example: ['ADMIN'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  visibleToRoles?: string[];

  @ApiPropertyOptional({ type: Object })
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

// ── Update Widget Config Dto ─────────────────────────────────────────
export class UpdateWidgetConfigDto {
  @ApiProperty({ type: Object })
  @IsObject()
  config!: Record<string, unknown>;
}

// ── Create Layout Dto ────────────────────────────────────────────────
export class CreateLayoutDto {
  @ApiProperty({ example: 'My Custom View' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @ApiProperty({ type: Object })
  @IsObject()
  gridConfig!: Record<string, unknown>;
}

// ── Export Layout Dto ────────────────────────────────────────────────
export class ExportLayoutDto {
  @ApiProperty()
  @IsUUID()
  layoutId!: string;

  @ApiProperty({ example: 'CSV', enum: ['CSV', 'EXCEL', 'PDF', 'JSON'] })
  @IsString()
  @IsNotEmpty()
  format!: string;
}

// ── Update Config Dto ────────────────────────────────────────────────
export class UpdateConfigDto {
  @ApiProperty({ example: 'dashboard.refresh_interval' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ type: Object })
  value!: unknown;
}
