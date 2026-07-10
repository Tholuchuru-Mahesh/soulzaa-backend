import { ApiPropertyOptional } from '@nestjs/swagger';
import { InvitationType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** List pending invitations, optionally filtered by type. */
export class ListInvitationsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: InvitationType })
  @IsOptional()
  @IsEnum(InvitationType)
  type?: InvitationType;
}
