import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ExtendBanDto {
  @ApiProperty({ description: "Hours to add to the ban's current expiry.", minimum: 1 })
  @IsInt()
  @Min(1)
  additionalHours!: number;
}
