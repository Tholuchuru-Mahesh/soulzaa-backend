import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Logout the current session. The session is identified from the access token
 * (`sid`), so no field is required; `deviceIdentifier` may be sent to also drop
 * the device's push token.
 */
export class LogoutDto {
  @ApiPropertyOptional({ description: 'Device to unregister the push token for' })
  @IsOptional()
  @IsString()
  deviceIdentifier?: string;
}
