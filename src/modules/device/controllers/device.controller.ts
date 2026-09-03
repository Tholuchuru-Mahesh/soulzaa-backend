import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { RegisterDeviceDto, RenameDeviceDto, UpdatePushTokenDto } from '../dto';
import { DEVICE_SERVICE, type IDeviceService } from '../interfaces/device.interface';

/**
 * Device Management HTTP surface. All routes require a valid access token and
 * operate on the caller's own devices (ownership enforced in the service).
 */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DeviceController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: IDeviceService) {}

  @Get()
  @ApiOperation({ summary: 'List my devices' })
  list(@CurrentUser('id') userId: string) {
    return this.devices.listDevices(userId);
  }

  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register / update the current device (push token, metadata)' })
  register(
    @CurrentUser('id') userId: string,
    @Body() dto: RegisterDeviceDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.devices.registerDevice(userId, dto, { ip: meta.ip, userAgent: meta.userAgent });
  }

  @Post('push-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update or clear a device push token' })
  async updatePushToken(@CurrentUser('id') userId: string, @Body() dto: UpdatePushTokenDto) {
    await this.devices.updatePushToken(
      userId,
      dto.deviceId,
      dto.pushToken ?? null,
      dto.tokenType,
    );
    return { updated: true };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a device' })
  async rename(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RenameDeviceDto,
  ) {
    await this.devices.renameDevice(userId, id, dto.deviceName);
    return { renamed: true };
  }

  @Post(':id/trust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trust a device' })
  async trust(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    await this.devices.trustDevice(userId, id, meta.ip);
    return { trusted: true };
  }

  @Post(':id/untrust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Untrust a device' })
  async untrust(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    await this.devices.untrustDevice(userId, id);
    return { trusted: false };
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a device' })
  async verify(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    await this.devices.verifyDevice(userId, id);
    return { verified: true };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a device' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    await this.devices.removeDevice(userId, id);
    return { removed: true };
  }
}
