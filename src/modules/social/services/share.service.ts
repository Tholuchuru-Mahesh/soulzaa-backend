import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';

/** Backend-owned share/QR content. `payload` is what the client encodes into a
 * QR image; `deepLink` opens the app; `shareUrl` is the web fallback. */
export interface ShareTarget {
  resourceType: 'user' | 'room' | 'video-room';
  resourceId: string;
  shareUrl: string;
  deepLink: string;
  payload: string;
}

/**
 * Produces canonical, deterministic share links + QR payloads for users and
 * rooms, reusing the same `SHARE_BASE_URL` / `APP_DEEPLINK_SCHEME` config as the
 * existing profile share. QR *images* are rendered client-side from `payload`.
 */
@Injectable()
export class ShareService {
  private readonly shareBase: string;
  private readonly scheme: string;

  constructor(
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    config: ConfigService,
  ) {
    const cfg = config.get('profile', { infer: true })!;
    this.shareBase = cfg.shareBaseUrl;
    this.scheme = cfg.deeplinkScheme;
  }

  private base(): string {
    return this.shareBase.replace(/\/$/, '');
  }

  async userQr(username: string): Promise<ShareTarget> {
    const user = await this.users.findByUsername(username);
    if (!user) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    }
    const deepLink = `${this.scheme}user/${username}`;
    return {
      resourceType: 'user',
      resourceId: user.id,
      shareUrl: `${this.base()}/u/${username}`,
      deepLink,
      payload: deepLink,
    };
  }

  roomShare(roomId: string): ShareTarget {
    const deepLink = `${this.scheme}room/${roomId}`;
    return {
      resourceType: 'room',
      resourceId: roomId,
      shareUrl: `${this.base()}/r/${roomId}`,
      deepLink,
      payload: deepLink,
    };
  }

  /** Room QR content is the room share content; the client renders the image. */
  roomQr(roomId: string): ShareTarget {
    return this.roomShare(roomId);
  }

  /**
   * Video rooms need their OWN link shape, not `roomShare`'s.
   *
   * `roomShare` formats an id into `room/<id>`, which the app resolves to the
   * audio-room screen — so sharing a video room through it hands the recipient
   * a link that opens the wrong surface (or nothing). The client route is
   * `/video-room/:id`, and these links mirror it exactly.
   */
  videoRoomShare(roomId: string): ShareTarget {
    const deepLink = `${this.scheme}video-room/${roomId}`;
    return {
      resourceType: 'video-room',
      resourceId: roomId,
      shareUrl: `${this.base()}/vr/${roomId}`,
      deepLink,
      payload: deepLink,
    };
  }

  /** Video-room QR content is its share content; the client renders the image. */
  videoRoomQr(roomId: string): ShareTarget {
    return this.videoRoomShare(roomId);
  }
}
