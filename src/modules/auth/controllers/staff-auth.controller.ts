import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { Public } from 'src/common/decorators/public.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { AuthService } from '../services/auth.service';
import type { AuthContext } from '../interfaces/auth.interface';

export class StaffLoginDto {
  @ApiProperty({ description: 'Email address or username handle', example: 'admin@soulzaa.com' })
  @IsString()
  email!: string;

  @ApiPropertyOptional({ description: 'Optional username handle if email is not provided' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiProperty({ example: 'Secret123!' })
  @IsString()
  @Length(6, 128)
  password!: string;

  @ApiPropertyOptional({ description: 'TOTP 2FA code (required if enrolled)' })
  @IsOptional()
  @IsString()
  totpCode?: string;

  @ApiPropertyOptional({ description: 'Bound physical device identifier' })
  @IsOptional()
  @IsString()
  deviceIdentifier?: string;

  @ApiPropertyOptional({ description: 'Device model or name (e.g. OnePlus 11)' })
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional({ description: 'Client platform (ANDROID, IOS, WEB)' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({ description: 'OS version' })
  @IsOptional()
  @IsString()
  osVersion?: string;

  @ApiPropertyOptional({ description: 'App version' })
  @IsOptional()
  @IsString()
  appVersion?: string;
}

@ApiTags('staff-auth')
@Controller('staff/auth')
export class StaffAuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Staff Portal login (requires staff role, TOTP 2FA if enrolled, bound device, & IP validation)',
  })
  login(@Body() dto: StaffLoginDto, @RequestMeta() meta: RequestMetadata) {
    const ctx: AuthContext = {
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    return this.authService.staffLogin(
      {
        email: dto.email,
        password: dto.password,
        totpCode: dto.totpCode,
        deviceIdentifier: dto.deviceIdentifier,
        deviceName: dto.deviceName,
        platform: dto.platform,
        osVersion: dto.osVersion,
        appVersion: dto.appVersion,
      },
      ctx,
    );
  }
}
