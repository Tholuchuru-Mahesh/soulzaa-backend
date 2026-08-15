import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequireRoles } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AgencyActivationService } from '../services/agency-activation.service';

export class StartActivationDto {
  @ApiProperty({ description: 'Stops a repeated tap opening a second payable page.' })
  @IsString()
  @MaxLength(120)
  idempotencyKey!: string;
}

/**
 * Paying to unlock the Coin Seller module.
 *
 * Requires only the AGENCY role — the whole point is that the caller does not
 * have COIN_SELLER yet. Scoped to the JWT caller, so an agency can only ever
 * activate itself.
 */
@ApiTags('agency-activation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard)
@RequireRoles('AGENCY')
@Controller('agencies/me/activation')
export class AgencyActivationController {
  constructor(private readonly activation: AgencyActivationService) {}

  @Get()
  @ApiOperation({ summary: 'Whether Coin Seller is active, and what it costs if not' })
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.activation.getStatus(user.id);
  }

  @Post('payment-link')
  @ApiOperation({ summary: 'Open a hosted Razorpay page for the activation fee' })
  start(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartActivationDto) {
    return this.activation.createPaymentLink(user.id, dto.idempotencyKey);
  }
}
