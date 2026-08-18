import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OtpPurpose } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { JwtRefreshGuard } from 'src/common/guards/jwt-refresh.guard';
import type { RefreshTokenUser } from 'src/infra/auth/refresh.strategy';
import {
  ChangePasswordDto,
  DeviceInfoDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  RequestOtpDto,
  ResetPasswordDto,
  SocialLoginDto,
  FirebaseLoginDto,
  VerifyOtpDto,
} from '../dto';
import { AUTH_SERVICE, type AuthContext, type IAuthService } from '../interfaces/auth.interface';
import { OTP_SERVICE, type IOtpService } from 'src/modules/otp/interfaces/otp.interface';

/**
 * HTTP surface for the auth domain. Pre-auth routes are @Public() (they bypass
 * the global JwtAuthGuard); the rest require a valid access token. The concrete
 * flows live in AuthService (resolved via AUTH_SERVICE) — the controller only
 * adapts HTTP ⇄ commands and threads per-request context. OTP issuance/resend
 * is delegated to the OTP module via OTP_SERVICE.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: IAuthService,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
  ) {}

  private context(meta: RequestMetadata, device?: DeviceInfoDto): AuthContext {
    return { ip: meta.ip, userAgent: meta.userAgent, device };
  }

  // ---- Registration ----

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new account (email+password; mobile verified via OTP)' })
  register(@Body() dto: RegisterDto, @RequestMeta() meta: RequestMetadata) {
    return this.auth.register(dto, this.context(meta, dto.device));
  }

  // ---- OTP ----

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request an OTP for a mobile number or email' })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.otp.generate({ destination: dto.destination, purpose: dto.purpose });
  }

  @Public()
  @Post('otp/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend an OTP (cooldown + resend-limit enforced)' })
  resendOtp(@Body() dto: RequestOtpDto) {
    return this.otp.resend({ destination: dto.destination, purpose: dto.purpose });
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an OTP for account verification (email/mobile)' })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    if (dto.purpose === OtpPurpose.EMAIL_VERIFY || dto.purpose === OtpPurpose.EMAIL_CHANGE) {
      await this.auth.verifyEmail({ destination: dto.destination, code: dto.code });
    } else if (
      dto.purpose === OtpPurpose.MOBILE_VERIFY ||
      dto.purpose === OtpPurpose.MOBILE_CHANGE
    ) {
      await this.auth.verifyMobile({ destination: dto.destination, code: dto.code });
    } else {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Use /auth/login/mobile for login OTP verification',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { verified: true };
  }

  // ---- Login ----

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email + password' })
  login(@Body() dto: LoginDto, @RequestMeta() meta: RequestMetadata) {
    return this.auth.loginWithPassword(dto, this.context(meta, dto.device));
  }

  @Public()
  @Post('login/firebase-mobile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login via verified Firebase Phone Authentication ID token' })
  loginWithFirebaseMobile(@Body() dto: FirebaseLoginDto, @RequestMeta() meta: RequestMetadata) {
    return this.auth.loginWithFirebaseMobile(dto.idToken, this.context(meta, dto.device));
  }

  @Public()
  @Post('login/social')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with Google, Apple or Facebook' })
  loginSocial(@Body() dto: SocialLoginDto, @RequestMeta() meta: RequestMetadata) {
    return this.auth.loginWithSocial(
      { provider: dto.provider, idToken: dto.idToken },
      this.context(meta, dto.device),
    );
  }

  // ---- Session ----

  @Public()
  @UseGuards(JwtRefreshGuard)
  @ApiBearerAuth()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new token pair' })
  refresh(
    @Body() _dto: RefreshTokenDto,
    @CurrentUser() user: RefreshTokenUser,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.auth.refresh(user.id, user.sid, user.refreshToken, this.context(meta));
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout the current session' })
  async logout(@CurrentUser() user: AuthenticatedUser) {
    if (user.sid) await this.auth.logout(user.id, user.sid);
    return { message: 'Logged out' };
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force-logout from all devices' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser) {
    await this.auth.logoutAllDevices(user.id);
    return { message: 'Logged out from all devices' };
  }

  // ---- Verification aliases ----

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with an OTP' })
  async verifyEmail(@Body() dto: VerifyOtpDto) {
    await this.auth.verifyEmail({ destination: dto.destination, code: dto.code });
    return { verified: true };
  }

  @Public()
  @Post('verify-mobile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify mobile number with an OTP' })
  async verifyMobile(@Body() dto: VerifyOtpDto) {
    await this.auth.verifyMobile({ destination: dto.destination, code: dto.code });
    return { verified: true };
  }

  // ---- Password recovery / change ----

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start password recovery' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.identifier);
    // Always success — never reveals whether the identifier exists.
    return { message: 'If the account exists, a reset code has been sent' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete password recovery with a reset token' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { message: 'Password has been reset' };
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password (authenticated)' })
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
    return { message: 'Password changed' };
  }

  // ---- Session identity ----

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Current account identity from the access token' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }
}
