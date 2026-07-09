import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Query for the username-availability check. */
export class UsernameQueryDto {
  @ApiProperty({ example: 'aditya_r' })
  @IsString()
  @Length(1, 32)
  username!: string;
}
