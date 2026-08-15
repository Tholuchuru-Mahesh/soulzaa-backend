import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AgencyMemberQueryDto } from '../dto/agency-member-query.dto';
import { AgencyDirectoryService } from '../services/agency-directory.service';

/**
 * Browsable list of agencies, for any signed-in member.
 *
 * Deliberately not role-gated: this is how an ordinary user finds an agency to
 * join. It exposes only what an agency advertises — trading name, owner,
 * avatar and member count — never settlement, coin or community data.
 */
@ApiTags('agency-directory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('agencies/directory')
export class AgencyDirectoryController {
  constructor(private readonly directory: AgencyDirectoryService) {}

  @Get()
  @ApiOperation({ summary: 'Approved agencies, newest first' })
  list(@Query() query: AgencyMemberQueryDto) {
    return this.directory.list({
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
  }
}
