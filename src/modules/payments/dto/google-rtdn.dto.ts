import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

/** Play's DeveloperNotification, as published to the RTDN topic. */
export interface DeveloperNotification {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  voidedPurchaseNotification?: {
    purchaseToken: string;
    orderId: string;
    /** 1 = one-time product, 2 = subscription. */
    productType?: number;
    /** 1 = full refund, 2 = partial refund. */
    refundType?: number;
  };
  oneTimeProductNotification?: Record<string, unknown>;
  subscriptionNotification?: Record<string, unknown>;
  testNotification?: Record<string, unknown>;
}

/** The Pub/Sub push envelope. `message.data` is base64 DeveloperNotification JSON. */
export class PubSubPushDto {
  @ApiProperty({ description: 'Pub/Sub message envelope' })
  @IsObject()
  message!: { data?: string; messageId?: string; publishTime?: string };

  @ApiProperty({ description: 'Subscription that delivered the message', required: false })
  @IsString()
  @IsOptional()
  subscription?: string;
}
