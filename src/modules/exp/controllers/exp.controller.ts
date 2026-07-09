import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ExpService } from '../services/exp.service';

/**
 * EXP & levels read surface (base `exp` + `rooms/:id/exp`). JWT-guarded. EXP is
 * awarded by platform activity, never by direct client calls.
 */
@ApiTags('exp')
@ApiBearerAuth()
@Controller()
export class ExpController {
  constructor(private readonly exp: ExpService) {}

  @Get('exp/me')
  @ApiOperation({ summary: 'My EXP + level' })
  me(@CurrentUser('id') userId: string) {
    return this.exp.getUserExp(userId);
  }

  @Get('exp/history')
  @ApiOperation({ summary: 'My EXP award history' })
  history(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.exp.history(userId, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Get('exp/users/:userId')
  @ApiOperation({ summary: "A user's EXP + level" })
  user(@Param('userId', ParseUuidPipe) userId: string) {
    return this.exp.getUserExp(userId);
  }

  @Get('rooms/:id/exp')
  @ApiOperation({ summary: "A room's EXP + level" })
  room(@Param('id', ParseUuidPipe) id: string) {
    return this.exp.getRoomExpView(id);
  }
}
