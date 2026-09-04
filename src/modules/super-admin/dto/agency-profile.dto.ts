import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { AGENCY_ACTIVITY_TYPES, type AgencyActivityType } from '../services/agency-profile.service';

export class AgencyActivityQueryDto extends PaginationQueryDto {
  @ApiProperty({
    enum: AGENCY_ACTIVITY_TYPES,
    description:
      'Which ledger to page through: coin sales to users, inventory bought from the platform, ' +
      'the wallet ledger, agency settlements, or rewards distributed to members.',
  })
  @IsIn(AGENCY_ACTIVITY_TYPES as unknown as string[])
  type!: AgencyActivityType;
}
