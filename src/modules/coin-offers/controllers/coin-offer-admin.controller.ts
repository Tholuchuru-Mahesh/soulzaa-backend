import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { CoinOfferService } from '../services/coin-offer.service';
import { CreateCoinOfferDto, UpdateCoinOfferDto } from '../dto/coin-offer.dto';
import {
  AuditLogAction,
  CurrentUser,
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';

@Controller('admin/coin-offers')
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
export class CoinOfferAdminController {
  constructor(private readonly service: CoinOfferService) {}

  @Get()
  @RequirePermissions('coin_offers.manage')
  list() {
    return this.service.list();
  }

  @Post()
  @RequirePermissions('coin_offers.manage')
  @AuditLogAction('COIN_OFFER_CREATED', 'coin_offer')
  create(@CurrentUser('id') actorId: string, @Body() dto: CreateCoinOfferDto) {
    return this.service.create(actorId, dto);
  }

  @Put(':id')
  @RequirePermissions('coin_offers.manage')
  @AuditLogAction('COIN_OFFER_UPDATED', 'coin_offer')
  update(@Param('id') id: string, @Body() dto: UpdateCoinOfferDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/toggle')
  @RequirePermissions('coin_offers.manage')
  @AuditLogAction('COIN_OFFER_TOGGLED', 'coin_offer')
  toggle(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.service.toggle(id, isActive);
  }
}
