import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReportPostDto {
  @ApiProperty({ description: 'Reason for reporting this post' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
