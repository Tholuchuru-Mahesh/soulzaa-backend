import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/** Apply an owned THEME cosmetic as the room background/theme. */
export class ApplyThemeDto {
  @ApiProperty({ description: 'A THEME cosmetic id the caller owns.' })
  @IsUUID()
  cosmeticId!: string;
}

/** Replace the room's DECORATION set with owned decoration cosmetics. */
export class SetDecorationsDto {
  @ApiProperty({ type: [String], description: 'DECORATION cosmetic ids the caller owns.' })
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  cosmeticIds!: string[];
}
