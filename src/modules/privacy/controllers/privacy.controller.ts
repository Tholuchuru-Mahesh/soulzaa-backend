import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  BlockUserDto,
  CheckPrivacyDto,
  UnblockUserDto,
  UpdatePreferencesDto,
  UpdatePrivacySettingsDto,
} from '../dto';
import { PRIVACY_SERVICE, type IPrivacyService } from '../interfaces/privacy.interface';

/**
 * Privacy & Safety HTTP surface. All routes require a valid access token and
 * operate on the caller's own privacy state. Block/unblock accept a user id or
 * username (resolved via USERS_SERVICE).
 */
@ApiTags('privacy')
@ApiBearerAuth()
@Controller('privacy')
export class PrivacyController {
  constructor(
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Get my privacy settings' })
  getSettings(@CurrentUser('id') userId: string) {
    return this.privacy.getSettings(userId);
  }

  @Put('settings')
  @ApiOperation({ summary: 'Update my privacy settings' })
  updateSettings(@CurrentUser('id') userId: string, @Body() dto: UpdatePrivacySettingsDto) {
    return this.privacy.updateSettings(userId, dto);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get my preferences' })
  getPreferences(@CurrentUser('id') userId: string) {
    return this.privacy.getPreferences(userId);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update my preferences' })
  updatePreferences(@CurrentUser('id') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.privacy.updatePreferences(userId, dto);
  }

  @Get('blocked')
  @ApiOperation({ summary: 'List users I have blocked' })
  listBlocked(@CurrentUser('id') userId: string) {
    return this.privacy.listBlocked(userId);
  }

  @Post('block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a user (by id or username)' })
  async block(@CurrentUser('id') userId: string, @Body() dto: BlockUserDto) {
    const targetId = await this.resolveTarget(dto.userId, dto.username);
    await this.privacy.block(userId, targetId, dto.reason);
    return { blocked: true };
  }

  @Post('unblock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unblock a user (by id or username)' })
  async unblock(@CurrentUser('id') userId: string, @Body() dto: UnblockUserDto) {
    const targetId = await this.resolveTarget(dto.userId, dto.username);
    await this.privacy.unblock(userId, targetId);
    return { blocked: false };
  }

  @Get('check')
  @ApiOperation({ summary: 'Check whether I may perform an action against a target' })
  async check(@CurrentUser('id') userId: string, @Query() dto: CheckPrivacyDto) {
    return { allowed: await this.privacy.check(userId, dto.target, dto.action) };
  }

  /** Resolve a block/unblock target from either an id or a username. */
  private async resolveTarget(userId?: string, username?: string): Promise<string> {
    if (userId) return userId;
    if (username) {
      const user = await this.users.findByUsername(username);
      if (user) return user.id;
    }
    throw new BusinessException(
      ERROR_CODES.NOT_FOUND,
      'Provide a valid userId or username',
      HttpStatus.NOT_FOUND,
    );
  }
}
