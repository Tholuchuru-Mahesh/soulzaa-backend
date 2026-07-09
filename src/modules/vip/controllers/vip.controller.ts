import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { VipService } from '../services/vip.service';

/**
 * VIP read surface (base `vip`). JWT-guarded. VIP tier is driven by recharge and
 * never set directly by the client.
 */
@ApiTags('vip')
@ApiBearerAuth()
@Controller('vip')
export class VipController {
  constructor(private readonly vip: VipService) {}

  @Get('me')
  @ApiOperation({ summary: 'My VIP tier + lifetime recharge' })
  me(@CurrentUser('id') userId: string) {
    return this.vip.getStatus(userId);
  }

  @Get('users/:userId')
  @ApiOperation({ summary: "A user's VIP tier" })
  user(@Param('userId', ParseUuidPipe) userId: string) {
    return this.vip.getStatus(userId);
  }
}
