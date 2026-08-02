import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

/**
 * Deliberately narrower than the full AccountStatus enum: provisioning may
 * suspend or restore an Admin, but DELETED and BANNED belong to the account
 * lifecycle the users module owns, not to staff administration.
 */
const ALLOWED: AccountStatus[] = ['ACTIVE', 'SUSPENDED', 'INACTIVE'];

export class SetAdminStatusDto {
  @ApiProperty({ enum: ALLOWED, example: 'SUSPENDED' })
  @IsIn(ALLOWED)
  status!: AccountStatus;
}
