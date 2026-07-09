import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Transfer room ownership to another active member. */
export class TransferOwnershipDto {
  @ApiProperty({ description: 'User id of the new owner (must be an active member).' })
  @IsUUID()
  newOwnerId!: string;
}
