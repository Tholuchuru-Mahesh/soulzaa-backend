import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VipLevel } from 'src/common/enums/vip-level.enum';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** One VIP benefit (a granted cosmetic or a descriptive perk). */
export class VipBenefitDto {
  @ApiProperty({ enum: ['COSMETIC', 'PERK'] })
  @IsEnum({ COSMETIC: 'COSMETIC', PERK: 'PERK' })
  kind!: 'COSMETIC' | 'PERK';

  @ApiPropertyOptional({ description: 'Catalog cosmetic id (kind=COSMETIC).' })
  @ValidateIf((o: VipBenefitDto) => o.kind === 'COSMETIC')
  @IsUUID()
  cosmeticId?: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Perk description (kind=PERK).' })
  @ValidateIf((o: VipBenefitDto) => o.kind === 'PERK')
  @IsString()
  @MaxLength(200)
  description?: string;
}

/** Admin: create/replace a VIP tier config. */
export class VipConfigDto {
  @ApiProperty({ enum: VipLevel })
  @IsEnum(VipLevel)
  level!: VipLevel;

  @ApiProperty({ minimum: 0, description: 'Lifetime Gold recharge to reach this tier.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minRecharge!: number;

  @ApiPropertyOptional({ type: [VipBenefitDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VipBenefitDto)
  benefits?: VipBenefitDto[];
}
