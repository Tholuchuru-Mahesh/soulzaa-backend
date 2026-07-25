import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsInt,
  IsDateString,
  IsObject,
  Min,
} from 'class-validator';

// ── Create Referral Code ──────────────────────────────────────────────
export class CreateReferralCodeDto {
  @ApiProperty({ description: 'UUID of the referrer user' })
  @IsUUID()
  referrerId!: string;

  @ApiPropertyOptional({ description: 'Campaign ID to link this code to' })
  @IsUUID()
  @IsOptional()
  campaignId?: string;

  @ApiPropertyOptional({ description: 'Maximum number of uses for this code' })
  @IsInt()
  @Min(1)
  @IsOptional()
  maxUses?: number;

  @ApiPropertyOptional({ description: 'Expiry date for this code (ISO8601)' })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}

// ── Register Referral ─────────────────────────────────────────────────
export class RegisterReferralDto {
  @ApiProperty({ description: 'Referral code string entered or scanned by the referee' })
  @IsString()
  @IsNotEmpty()
  referralCode!: string;

  @ApiProperty({ description: 'UUID of the user being referred (referee)' })
  @IsUUID()
  refereeId!: string;
}

// ── Qualify Referral ──────────────────────────────────────────────────
export class QualifyReferralDto {
  @ApiProperty({ description: 'Referral relationship ID' })
  @IsUUID()
  relationshipId!: string;

  @ApiPropertyOptional({ description: 'Optional JSON qualification rule overrides' })
  @IsObject()
  @IsOptional()
  rules?: Record<string, unknown>;
}

// ── Cancel Referral ───────────────────────────────────────────────────
export class CancelReferralDto {
  @ApiProperty({ description: 'Referral relationship ID' })
  @IsUUID()
  relationshipId!: string;

  @ApiPropertyOptional({ description: 'Actor ID performing the cancellation' })
  @IsUUID()
  @IsOptional()
  actorId?: string;
}

// ── Create Campaign ───────────────────────────────────────────────────
export class CreateCampaignDto {
  @ApiProperty({ example: 'SUMMER_2026' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ example: 'Summer 2026 Referral Campaign' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    enum: [
      'USER',
      'VIP',
      'CREATOR',
      'AGENCY',
      'SELLER',
      'CAMPAIGN',
      'EVENT',
      'FAMILY',
      'PROMOTIONAL',
      'INVITE_LINK',
      'QR_CODE',
      'CUSTOM',
    ],
  })
  @IsString()
  @IsNotEmpty()
  category!: string;

  @ApiPropertyOptional({ description: 'JSON qualification rules', type: Object })
  @IsObject()
  @IsOptional()
  qualificationRules?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'JSON reward definition', type: Object })
  @IsObject()
  @IsOptional()
  rewardDefinition?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  maxUses?: number;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  startTime?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  endTime?: string;
}

// ── Dispatch Reward ───────────────────────────────────────────────────
export class DispatchRewardDto {
  @ApiProperty()
  @IsUUID()
  relationshipId!: string;

  @ApiProperty()
  @IsUUID()
  referrerId!: string;

  @ApiProperty()
  @IsUUID()
  refereeId!: string;

  @ApiProperty({ description: 'JSON reward definition', type: Object })
  @IsObject()
  rewardDefinition!: Record<string, unknown>;
}

// ── Update Configuration ──────────────────────────────────────────────
export class UpdateConfigDto {
  @ApiProperty({ example: 'referral.default_expiry_days' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ description: 'Configuration value (JSON)', type: Object })
  value!: unknown;
}
