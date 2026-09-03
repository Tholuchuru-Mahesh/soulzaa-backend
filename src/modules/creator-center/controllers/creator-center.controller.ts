import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { LiveHistoryQueryDto } from '../dto/live-history-query.dto';
import { PkHistoryQueryDto } from '../dto/pk-history-query.dto';
import { RequestSettlementDto } from '../dto/request-settlement.dto';
import { TopFansQueryDto } from '../dto/top-fans-query.dto';
import { ActiveAccountGuard } from '../guards/active-account.guard';
import { CreatorCenterService } from '../services/creator-center.service';

/**
 * Creator Center REST surface (`creators/me`). The global JwtAuthGuard already
 * secures every route app-wide; `ActiveAccountGuard` additionally re-checks the
 * account is still ACTIVE on every request (a long-lived token for a
 * since-banned account must not keep granting creator actions). Every query is
 * scoped to the JWT-derived caller id — a creatorId/userId is never accepted
 * from the client.
 */
@ApiTags('creator-center')
@ApiBearerAuth()
@UseGuards(ActiveAccountGuard)
@Controller('creators/me')
export class CreatorCenterController {
  constructor(private readonly creatorCenter: CreatorCenterService) {}

  @Get('live-history')
  @ApiOperation({ summary: "List the caller's own past broadcast sessions" })
  liveHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LiveHistoryQueryDto,
  ) {
    return this.creatorCenter.getLiveHistory(
      user.id,
      query.page,
      query.limit,
      query.skip,
      query.roomId,
      query.roomType,
    );
  }

  @Get('live-history/:sessionId')
  @ApiOperation({ summary: "Detail for one of the caller's own broadcast sessions" })
  liveHistoryDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseUuidPipe) sessionId: string,
  ) {
    return this.creatorCenter.getLiveHistoryDetail(user.id, sessionId);
  }

  @Get('pk-history')
  @ApiOperation({ summary: "List the caller's own PK battles across all rooms" })
  pkHistory(@CurrentUser() user: AuthenticatedUser, @Query() query: PkHistoryQueryDto) {
    return this.creatorCenter.getPkHistory(
      user.id,
      query.page,
      query.limit,
      query.skip,
      query.filter,
    );
  }

  @Get('pk-history/:pkId')
  @ApiOperation({ summary: "Detail for one of the caller's own PK battles" })
  pkHistoryDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('pkId', ParseUuidPipe) pkId: string,
  ) {
    return this.creatorCenter.getPkHistoryDetail(user.id, pkId);
  }

  @Get('top-fans')
  @ApiOperation({ summary: "Ranked list of the caller's biggest fans" })
  topFans(@CurrentUser() user: AuthenticatedUser, @Query() query: TopFansQueryDto) {
    return this.creatorCenter.getTopFans(user.id, query.period, query.limit);
  }

  @Post('settlements')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Request a settlement (withdrawal) from the caller's own earnings" })
  requestSettlement(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestSettlementDto) {
    return this.creatorCenter.requestSettlement(user.id, dto);
  }

  @Get('settlements/config')
  @ApiOperation({ summary: 'Settlement rules: minimum/maximum amount, fee, limits' })
  settlementConfig() {
    return this.creatorCenter.getSettlementConfig();
  }

  @Get('settlements')
  @ApiOperation({ summary: "The caller's own settlement history" })
  settlementHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto & { status?: string },
  ) {
    return this.creatorCenter.getSettlementHistory(user.id, query.page, query.limit, query.status);
  }

  @Get('settlements/:id')
  @ApiOperation({ summary: "Detail for one of the caller's own settlement requests" })
  settlementDetail(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.creatorCenter.getSettlementDetail(user.id, id);
  }

  @Post('settlements/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel one of the caller's own pending settlement requests" })
  cancelSettlement(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.creatorCenter.cancelSettlement(user.id, id);
  }
}
