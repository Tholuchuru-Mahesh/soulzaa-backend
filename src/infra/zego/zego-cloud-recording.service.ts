import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';

/**
 * ZEGOCLOUD Cloud Recording — the only ZEGO capability that records the real
 * server-side mixed audio of a room (every publisher combined), independent of
 * any single participant's device. This is distinct from the client SDK's
 * `startRecordingCapturedData`, which only records that one device's own
 * local mic/published stream.
 *
 * Requires "Cloud Recording" to be enabled for this AppID in the ZEGO Console
 * (a separate product from base RTC/voice — cannot be enabled from code). The
 * request signing below follows ZEGO's documented Server API "Public
 * Parameters" convention (AppId + ServerSecret + SignatureNonce + Timestamp,
 * MD5, SignatureVersion=2) used across their Server RESTful APIs. The
 * Cloud-Recording-specific action/parameter names were built from ZEGO's
 * published Cloud Recording API reference without live access to verify them
 * against this account's exact subscription — confirm `StartRecord`/
 * `StopRecord` request/response shapes against the ZEGO Console's API
 * reference for this AppID before relying on this in production. A wrong
 * signature or action name fails the HTTP call loudly (logged, task marked
 * FAILED) rather than silently producing wrong audio, which is why this is
 * safe to ship ahead of that verification.
 */
export interface StartCloudRecordingInput {
  roomId: string;
  taskId: string;
  /** Called by ZEGO when a recording segment/task update is ready. */
  notifyUrl?: string;
}

export interface CloudRecordingSegmentNotification {
  taskId: string;
  roomId: string;
  fileUrl: string;
  startedAt: string;
  endedAt: string;
}

@Injectable()
export class ZegoCloudRecordingService {
  private readonly logger = new Logger(ZegoCloudRecordingService.name);

  constructor(private readonly config: ConfigService) {}

  private creds(): { appId: number; serverSecret: string } {
    const cfg = this.config.get('zego') as { appId: number | string; serverSecret: string };
    const appId = Number(cfg?.appId);
    if (!appId || !cfg?.serverSecret) {
      throw new InternalServerErrorException('ZEGOCLOUD credentials are not configured');
    }
    return { appId, serverSecret: cfg.serverSecret };
  }

  private sign(appId: number, serverSecret: string, nonce: string, timestamp: number): string {
    return createHash('md5').update(`${appId}${serverSecret}${nonce}${timestamp}`).digest('hex');
  }

  private async call<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const { appId, serverSecret } = this.creds();
    const cfg = this.config.get('zego') as { cloudRecordApiBaseUrl: string };
    const nonce = randomUUID().replace(/-/g, '');
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign(appId, serverSecret, nonce, timestamp);

    const query = new URLSearchParams({
      Action: action,
      AppId: String(appId),
      SignatureNonce: nonce,
      Timestamp: String(timestamp),
      Signature: signature,
      SignatureVersion: '2',
    });

    const url = `${cfg.cloudRecordApiBaseUrl}/?${query.toString()}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = (await res.json().catch(() => null)) as {
      Code?: number;
      Message?: string;
      Data?: unknown;
    } | null;

    if (!res.ok || !payload || payload.Code !== 0) {
      const message = payload?.Message || `HTTP ${res.status}`;
      throw new Error(`ZEGO Cloud Recording ${action} failed: ${message}`);
    }

    return payload.Data as T;
  }

  /**
   * Starts continuous mixed-audio recording for a room. Intended to be called
   * once when the room's voice session begins (first participant), not at
   * report time — Cloud Recording only records forward from this call, so any
   * "pre-report" evidence window depends on this having already been running.
   */
  async startRecording(input: StartCloudRecordingInput): Promise<void> {
    const cfg = this.config.get('zego') as { cloudRecordSegmentIntervalSeconds: number };
    await this.call('StartRecord', {
      RoomId: input.roomId,
      TaskId: input.taskId,
      // Wildcard: mix every stream currently published in the room — the same
      // audio mix every participant's client hears — rather than a single
      // participant's stream.
      Inputs: [{ StreamId: '*' }],
      MixConfig: {
        AudioConfig: { Bitrate: 48, Channel: 1, SampleRate: 16000 },
      },
      // Segments the continuous recording into files roughly this long, so a
      // multi-hour room doesn't produce one unbounded file and evidence
      // extraction only has to download the segments overlapping the window.
      Interval: cfg.cloudRecordSegmentIntervalSeconds,
      NotifyUrl: input.notifyUrl,
    });
    this.logger.log(`Started ZEGO Cloud Recording task ${input.taskId} for room ${input.roomId}`);
  }

  async stopRecording(taskId: string): Promise<void> {
    await this.call('StopRecord', { TaskId: taskId });
    this.logger.log(`Stopped ZEGO Cloud Recording task ${taskId}`);
  }
}
