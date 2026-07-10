import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ShareService } from '../services/share.service';

/**
 * Sharing/QR surface. Returns backend-generated share URLs + deep links + QR
 * payloads for users and rooms; the client renders the QR image from `payload`.
 * The existing `GET /users/:username/share` (ProfileService) is left untouched.
 */
@ApiTags('social')
@ApiBearerAuth()
@Controller('social')
export class SocialShareController {
  constructor(private readonly share: ShareService) {}

  @Get('users/:username/qr')
  @ApiOperation({ summary: 'Share/QR content for a user profile' })
  userQr(@Param('username') username: string) {
    return this.share.userQr(username);
  }

  @Get('rooms/:roomId/share')
  @ApiOperation({ summary: 'Share content for an audio room' })
  roomShare(@Param('roomId', ParseUUIDPipe) roomId: string) {
    return this.share.roomShare(roomId);
  }

  @Get('rooms/:roomId/qr')
  @ApiOperation({ summary: 'QR content for an audio room' })
  roomQr(@Param('roomId', ParseUUIDPipe) roomId: string) {
    return this.share.roomQr(roomId);
  }
}
