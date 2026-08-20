import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Admin decision when turning down a submitted agency event. */
export class RejectAgencyEventDto {
  @ApiProperty({ example: 'The banner is unreadable at thumbnail size.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
