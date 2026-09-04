import { IsUUID } from 'class-validator';

/** Enable-gift-lock request body: the catalog gift id required to enter. */
export class GiftLockVideoRoomDto {
  @IsUUID()
  giftId!: string;
}
