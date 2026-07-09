import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { NOT_GUEST_KEY } from '../constants';
import { GuestGuard } from '../guards/guest.guard';

/**
 * Denies guest accounts access to a route (PRD: guests cannot create rooms,
 * recharge coins, or buy VIP). Sets the metadata GuestGuard reads and attaches
 * the guard in one step, so consuming modules just write `@NotGuest()`.
 */
export const NotGuest = () =>
  applyDecorators(SetMetadata(NOT_GUEST_KEY, true), UseGuards(GuestGuard));
