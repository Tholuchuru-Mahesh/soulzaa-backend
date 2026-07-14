import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { FailCallDto, InitiateCallDto, ListCallsDto } from '../dto/calls.dto';
import { CallsService } from '../services/calls.service';

/**
 * Private 1:1 calling (base `calls`). JWT-guarded globally; the privacy gate
 * (`PrivacyAction.CALL`), the block list, the busy rule and participation are all
 * enforced in the service.
 *
 * Every mutation is an HTTP route by design — the `/call` socket namespace is a
 * pure fan-out channel and accepts no client commands, matching the platform
 * convention. Signalling over REST keeps auth, validation, rate limiting and the
 * error envelope uniform, and costs nothing that matters: the round trip is on the
 * *signalling* path, not the media path, where ZEGO carries the audio directly
 * between the peers.
 *
 * Guests cannot call (`@NotGuest`).
 */
@ApiTags('calls')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  // ---- Lifecycle ----

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({
    summary: 'Place a call. Idempotent on `clientId` — a double-tap rings once.',
  })
  initiate(@CurrentUser('id') userId: string, @Body() dto: InitiateCallDto) {
    return this.calls.initiate(userId, {
      calleeId: dto.calleeId,
      type: dto.type,
      clientId: dto.clientId,
    });
  }

  // ---- Static routes first: `:id` would otherwise swallow them ----

  @Get('active')
  @ApiOperation({
    summary:
      'The live call this user is in, if any. Call recovery: an app killed mid-call ' +
      'asks this on launch and rejoins rather than silently dropping the peer.',
  })
  active(@CurrentUser('id') userId: string) {
    return this.calls.active(userId);
  }

  @Get()
  @ApiOperation({ summary: 'Call history (ALL | INCOMING | OUTGOING | MISSED)' })
  history(@CurrentUser('id') userId: string, @Query() q: ListCallsDto) {
    return this.calls.history(userId, {
      page: q.page,
      limit: q.limit,
      filter: q.filter,
      search: q.search,
    });
  }

  @Get('permissions/:userId')
  @ApiOperation({
    summary: 'Whether this user may call the target — so the client can disable the button',
  })
  canCall(@CurrentUser('id') userId: string, @Param('userId', ParseUuidPipe) targetId: string) {
    return this.calls.canCall(userId, targetId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Call detail' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.calls.get(userId, id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Answer a ringing call. Returns the credentials to join the room.' })
  accept(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.calls.accept(userId, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Decline a ringing call (callee only)' })
  reject(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.calls.reject(userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Withdraw a call before it is answered (caller only)' })
  cancel(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.calls.cancel(userId, id);
  }

  @Post(':id/connected')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Report that media is flowing. Starts the duration clock.',
  })
  connected(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.calls.markConnected(userId, id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Hang up. Safe to call twice, and safe while still ringing (routes to cancel/reject).',
  })
  end(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.calls.end(userId, id);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Report that the RTC session could not be held up' })
  fail(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: FailCallDto,
  ) {
    return this.calls.fail(userId, id, dto.reason);
  }

  @Post(':id/token')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Re-issue the ZEGO token for a live call, before the current one expires',
  })
  renewToken(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.calls.renewToken(userId, id);
  }
}
