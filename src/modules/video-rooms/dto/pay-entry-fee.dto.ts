import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class PayEntryFeeDto {
  @ApiProperty({
    description: 'Unique client-generated idempotency key to prevent double charges.',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID()
  idempotencyKey!: string;
}
