import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdateStatusDto {
  @ApiProperty({
    description: 'Active status flag (true = active, false = inactive)',
    example: true,
  })
  @IsBoolean()
  @IsNotEmpty()
  isActive!: boolean;
}
