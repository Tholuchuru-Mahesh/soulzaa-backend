// Registry of all domain modules. AppModule imports this array so adding a
// module is a one-line change here.
import { AgenciesModule } from './agencies/agencies.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AudioRoomsModule } from './audio-rooms/audio-rooms.module';
import { AuthModule } from './auth/auth.module';
import { BackpackModule } from './backpack/backpack.module';
import { CosmeticsModule } from './cosmetics/cosmetics.module';
import { ChatModule } from './chat/chat.module';
import { DeviceModule } from './device/device.module';
import { EventsModule } from './events/events.module';
import { ExpModule } from './exp/exp.module';
import { FamiliesModule } from './families/families.module';
import { GamesModule } from './games/games.module';
import { GiftsModule } from './gifts/gifts.module';
import { LiveStreamingModule } from './live-streaming/live-streaming.module';
import { NotificationModule } from './notification/notification.module';
import { OtpModule } from './otp/otp.module';
import { SessionModule } from './session/session.module';
import { PaymentsModule } from './payments/payments.module';
import { PrivacyModule } from './privacy/privacy.module';
import { RankingsModule } from './rankings/rankings.module';
import { TreasureBoxesModule } from './treasure-boxes/treasure-boxes.module';
import { UsersModule } from './users/users.module';
import { VideoRoomsModule } from './video-rooms/video-rooms.module';
import { VipModule } from './vip/vip.module';
import { WalletModule } from './wallet/wallet.module';

export const DOMAIN_MODULES = [
  AuthModule,
  UsersModule,
  OtpModule,
  SessionModule,
  DeviceModule,
  PrivacyModule,
  WalletModule,
  PaymentsModule,
  ChatModule,
  AudioRoomsModule,
  GiftsModule,
  BackpackModule,
  CosmeticsModule,
  EventsModule,
  RankingsModule,
  TreasureBoxesModule,
  VideoRoomsModule,
  LiveStreamingModule,
  VipModule,
  ExpModule,
  FamiliesModule,
  AgenciesModule,
  GamesModule,
  NotificationModule,
  AnalyticsModule,
];
