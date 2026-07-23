import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsInt,
  IsDateString,
  IsObject,
  IsArray,
  Min,
} from 'class-validator';

// ── Generate Report Dto ──────────────────────────────────────────────
export class GenerateReportDto {
  @ApiProperty({ example: 'Platform overview weekly report' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'PLATFORM_OVERVIEW', description: 'Domain/Category key' })
  @IsString()
  @IsNotEmpty()
  domain!: string;

  @ApiPropertyOptional({ description: 'JSON dictionary parameter filters', type: Object })
  @IsObject()
  @IsOptional()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Actor UUID performing report compile' })
  @IsUUID()
  @IsOptional()
  actorId?: string;
}

// ── Export Report Dto ────────────────────────────────────────────────
export class ExportReportDto {
  @ApiProperty()
  @IsUUID()
  reportId!: string;

  @ApiProperty({ enum: ['CSV', 'EXCEL', 'PDF', 'JSON'] })
  @IsString()
  @IsNotEmpty()
  format!: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  actorId?: string;
}

// ── Create Dashboard Dto ─────────────────────────────────────────────
export class CreateDashboardDto {
  @ApiProperty({ example: 'Admin KPI Grid' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ type: Object })
  @IsObject()
  @IsOptional()
  layout?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsObject()
  @IsOptional()
  metrics?: Record<string, unknown>;
}

// ── Query Trend Dto ──────────────────────────────────────────────────
export class QueryTrendDto {
  @ApiProperty({ example: 'GROWTH' })
  @IsString()
  @IsNotEmpty()
  domain!: string;

  @ApiProperty({ example: 'total_users' })
  @IsString()
  @IsNotEmpty()
  metricKey!: string;

  @ApiProperty({ example: '2026-07-01T00:00:00Z' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-07-23T23:59:59Z' })
  @IsDateString()
  endDate!: string;
}

// ── Update Dashboard Layout Dto ──────────────────────────────────────
export class UpdateLayoutDto {
  @ApiProperty({ type: Object })
  @IsObject()
  layout!: Record<string, unknown>;
}

// ── Configuration Dto ────────────────────────────────────────────────
export class UpdateConfigDto {
  @ApiProperty({ example: 'analytics.retention_days' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration value (JSON)', type: Object })
  value!: unknown;
}
