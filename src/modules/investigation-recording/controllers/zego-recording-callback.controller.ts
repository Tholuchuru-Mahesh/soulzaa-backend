import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';
import { RoomRecordingLifecycleService } from '../services/room-recording-lifecycle.service';

/**
 * ZEGO's Cloud Recording callback payload for a completed segment/task. Field
 * names here reflect ZEGO's documented Server API callback convention but
 * have not been verified live against this account's Cloud Recording
 * subscription — if segments never show up in `ZegoRoomRecordingTask.segments`
 * after enabling Cloud Recording, check the raw body logged below first and
 * adjust the field names this DTO reads.
 */
interface ZegoRecordCallbackBody {
  TaskId?: string;
  RoomId?: string;
  FileUrl?: string;
  Url?: string;
  StartTime?: number | string;
  EndTime?: number | string;
}

@Controller('investigation-recordings/zego')
export class ZegoRecordingCallbackController {
  private readonly logger = new Logger(ZegoRecordingCallbackController.name);

  constructor(
    private readonly lifecycle: RoomRecordingLifecycleService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Public — ZEGO's servers call this directly and cannot present a Soulzaa
   * JWT. Authenticated instead by the `token` query param this service itself
   * embedded in the NotifyUrl handed to ZEGO at StartRecord time (see
   * `RoomRecordingLifecycleService.notifyUrl`), so an unrelated caller cannot
   * inject fabricated "recording ready" segments into the evidence pipeline.
   */
  @Public()
  @ApiExcludeEndpoint()
  @Post('recording-callback')
  @HttpCode(HttpStatus.OK)
  async handleCallback(@Body() body: ZegoRecordCallbackBody, @Query('token') token?: string) {
    const cfg = this.config.get('zego') as { cloudRecordCallbackSecret?: string };
    if (cfg?.cloudRecordCallbackSecret && token !== cfg.cloudRecordCallbackSecret) {
      throw new UnauthorizedException('Invalid callback token');
    }

    const fileUrl = body.FileUrl || body.Url;
    if (!body.TaskId || !body.RoomId || !fileUrl || !body.StartTime || !body.EndTime) {
      this.logger.warn(`Recording callback missing expected fields: ${JSON.stringify(body)}`);
      return { received: true, handled: false };
    }

    await this.lifecycle.recordSegment({
      taskId: body.TaskId,
      roomId: body.RoomId,
      fileUrl,
      startedAt: toIsoString(body.StartTime),
      endedAt: toIsoString(body.EndTime),
    });

    return { received: true, handled: true };
  }
}

/** Accepts either a unix-seconds timestamp or an ISO 8601 string. */
function toIsoString(value: number | string): string {
  const asUnixSeconds = Number(value);
  const date =
    Number.isFinite(asUnixSeconds) && String(value).trim() !== '' && !String(value).includes('T')
      ? new Date(asUnixSeconds * 1000)
      : new Date(value);
  return date.toISOString();
}
