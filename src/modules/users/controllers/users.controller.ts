import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  MediaConfirmDto,
  MediaPresignDto,
  ReviewVerificationDto,
  SearchUserDto,
  UpdateProfileDto,
  UsernameQueryDto,
  VerificationRequestDto,
} from '../dto';
import { ProfileService } from '../services/profile.service';

/**
 * User Domain HTTP surface. Authenticated routes manage the caller's own profile;
 * `/users/:username` is a @Public() read. The admin verification routes are gated
 * by @Roles (global RolesGuard). Static paths are declared before the `:username`
 * param route so they take precedence in matching.
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly profile: ProfileService) {}

  // ---- Self ----

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Get my full profile' })
  async me(@CurrentUser('id') userId: string) {
    const view = await this.profile.getProfileView(userId);
    if (!view) throw new NotFoundException('Profile not found');
    return view;
  }

  @ApiBearerAuth()
  @Patch('me')
  @ApiOperation({ summary: 'Update my profile' })
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.profile.updateProfile(userId, dto);
  }

  // ---- Avatar / cover ----

  @ApiBearerAuth()
  @Post('me/avatar/presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a presigned URL to upload an avatar' })
  presignAvatar(@CurrentUser('id') userId: string, @Body() dto: MediaPresignDto) {
    return this.profile.requestMediaUpload(userId, dto);
  }

  @ApiBearerAuth()
  @Post('me/avatar/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an uploaded avatar' })
  confirmAvatar(@CurrentUser('id') userId: string, @Body() dto: MediaConfirmDto) {
    return this.profile.confirmMedia(userId, 'avatar', dto.key);
  }

  @ApiBearerAuth()
  @Post('me/cover/presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a presigned URL to upload a cover image' })
  presignCover(@CurrentUser('id') userId: string, @Body() dto: MediaPresignDto) {
    return this.profile.requestMediaUpload(userId, dto);
  }

  @ApiBearerAuth()
  @Post('me/cover/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an uploaded cover image' })
  confirmCover(@CurrentUser('id') userId: string, @Body() dto: MediaConfirmDto) {
    return this.profile.confirmMedia(userId, 'cover', dto.key);
  }

  // ---- Verification (self submit) ----

  @ApiBearerAuth()
  @Post('me/verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit an account-verification request' })
  submitVerification(@CurrentUser('id') userId: string, @Body() dto: VerificationRequestDto) {
    return this.profile.submitVerification(userId, dto.type, dto.documentKey);
  }

  // ---- Search / username ----

  @ApiBearerAuth()
  @Get('search')
  @ApiOperation({ summary: 'Search users by username or full name' })
  search(@CurrentUser('id') userId: string, @Query() dto: SearchUserDto) {
    return this.profile.search(
      dto.q,
      { page: dto.page, limit: dto.limit, country: dto.country },
      userId,
    );
  }

  @Public()
  @Get('username-available')
  @ApiOperation({ summary: 'Check whether a username is available' })
  usernameAvailable(@Query() dto: UsernameQueryDto) {
    return this.profile.isUsernameAvailable(dto.username);
  }

  // ---- Admin verification review ----

  @ApiBearerAuth()
  @Roles('ADMIN', 'SUPER_ADMIN', 'MODERATOR')
  @Post('verification/:userId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: approve a verification request' })
  approveVerification(
    @CurrentUser('id') actorId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    return this.profile.reviewVerification(userId, { approve: true, reviewedBy: actorId });
  }

  @ApiBearerAuth()
  @Roles('ADMIN', 'SUPER_ADMIN', 'MODERATOR')
  @Post('verification/:userId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: reject a verification request' })
  rejectVerification(
    @CurrentUser('id') actorId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: ReviewVerificationDto,
  ) {
    return this.profile.reviewVerification(userId, {
      approve: false,
      reviewedBy: actorId,
      reason: dto.reason,
    });
  }

  // ---- Public profile by username (declared last: param route) ----

  @Public()
  @Get(':username/share')
  @ApiOperation({ summary: 'Get a shareable link for a profile' })
  share(@Param('username') username: string) {
    return this.profile.buildShare(username);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @Get(':username')
  @ApiOperation({ summary: 'View a profile by username (privacy-aware; auth optional)' })
  async byUsername(@Param('username') username: string, @CurrentUser('id') viewerId?: string) {
    const view = await this.profile.getProfileByUsername(username, viewerId);
    if (!view) throw new NotFoundException('User not found');
    return view;
  }
}
