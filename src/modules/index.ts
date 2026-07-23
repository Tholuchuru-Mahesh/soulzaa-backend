// Registry of all domain modules. AppModule imports this array so adding a
// module is a one-line change here.
import { AgenciesModule } from './agencies/agencies.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AudioRoomsModule } from './audio-rooms/audio-rooms.module';
import { AuthModule } from './auth/auth.module';
import { BackpackModule } from './backpack/backpack.module';
import { CallsModule } from './calls/calls.module';
import { CasinoModule } from './casino/casino.module';
import { CosmeticsModule } from './cosmetics/cosmetics.module';
import { ChatModule } from './chat/chat.module';
import { DeviceModule } from './device/device.module';
import { EventsModule } from './events/events.module';
import { ExpModule } from './exp/exp.module';
import { FamiliesModule } from './families/families.module';
import { GamesModule } from './games/games.module';
import { GiftsModule } from './gifts/gifts.module';
import { LiveStreamingModule } from './live-streaming/live-streaming.module';
import { LuckyPacketsModule } from './lucky-packets/lucky-packets.module';
import { NotificationModule } from './notification/notification.module';
import { RoomUtilitiesModule } from './room-utilities/room-utilities.module';
import { OtpModule } from './otp/otp.module';
import { SessionModule } from './session/session.module';
import { PaymentsModule } from './payments/payments.module';
import { PrivacyModule } from './privacy/privacy.module';
import { RankingsModule } from './rankings/rankings.module';
import { SocialModule } from './social/social.module';
import { TreasureBoxesModule } from './treasure-boxes/treasure-boxes.module';
import { UsersModule } from './users/users.module';
import { VideoRoomsModule } from './video-rooms/video-rooms.module';
import { VipModule } from './vip/vip.module';
import { WalletModule } from './wallet/wallet.module';

import { AuthorizationModule } from './authorization/authorization.module';
import { OrganizationModule } from './organization/organization.module';
import { PlatformConfigurationModule } from './platform-configuration/platform-configuration.module';
import { SuperAdminModule } from './super-admin/super-admin.module';
import { TreasuryModule } from './treasury/treasury.module';
import { RevenueModule } from './revenue/revenue.module';
import { CoinSellerSettlementModule } from './coin-seller-settlement/coin-seller-settlement.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { AchievementsModule } from './achievements/achievements.module';
import { EnterpriseRankingsModule } from './enterprise-rankings/enterprise-rankings.module';
import { EnterpriseEventsModule } from './enterprise-events/enterprise-events.module';
import { TasksModule } from './tasks/tasks.module';
import { ReferralsModule } from './referrals/referrals.module';
import { AdminDashboardModule } from './admin-dashboard/admin-dashboard.module';

export const DOMAIN_MODULES = [
  TreasuryModule,
  PlatformConfigurationModule,
  OrganizationModule,
  SuperAdminModule,
  AuthorizationModule,
  AuthModule,
  UsersModule,
  OtpModule,
  SessionModule,
  DeviceModule,
  PrivacyModule,
  WalletModule,
  PaymentsModule,
  ChatModule,
  CallsModule,
  AudioRoomsModule,
  GiftsModule,
  BackpackModule,
  CosmeticsModule,
  EventsModule,
  RankingsModule,
  TreasureBoxesModule,
  LuckyPacketsModule,
  RoomUtilitiesModule,
  VideoRoomsModule,
  LiveStreamingModule,
  VipModule,
  ExpModule,
  FamiliesModule,
  AgenciesModule,
  GamesModule,
  CasinoModule,
  NotificationModule,
  SocialModule,
  AnalyticsModule,
  RevenueModule,
  CoinSellerSettlementModule,
  WithdrawalsModule,
  AchievementsModule,
  EnterpriseRankingsModule,
  EnterpriseEventsModule,
  TasksModule,
  ReferralsModule,
  AdminDashboardModule,
];
