import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class AssignCountryManagerDto {
  @ApiProperty({
    description: 'Target User ID to assign as Country Manager',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;
}

export class TransferCountryManagerDto {
  @ApiProperty({
    description: 'User ID of current Country Manager being transferred',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    description: 'Target Country ID to transfer manager to',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  @IsUUID()
  @IsNotEmpty()
  targetCountryId!: string;
}
