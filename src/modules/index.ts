// Registry of all domain modules. AppModule imports this array so adding a
// module is a one-line change here.
import { AdminIdentityModule } from './admin-identity/admin-identity.module';
import { AgenciesModule } from './agencies/agencies.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AudioRoomsModule } from './audio-rooms/audio-rooms.module';
import { AuthModule } from './auth/auth.module';
import { BackpackModule } from './backpack/backpack.module';
import { CallsModule } from './calls/calls.module';
import { CasinoModule } from './casino/casino.module';
import { CosmeticsModule } from './cosmetics/cosmetics.module';
import { CreatorCenterModule } from './creator-center/creator-center.module';
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
import { DashboardFinancialModule } from './dashboard-financial/dashboard-financial.module';
import { DashboardOperationsModule } from './dashboard-operations/dashboard-operations.module';
import { DashboardEngagementModule } from './dashboard-engagement/dashboard-engagement.module';
import { DashboardModerationModule } from './dashboard-moderation/dashboard-moderation.module';
import { MobileWorkforceModule } from './mobile-workforce/mobile-workforce.module';
import { MobilePartnerModule } from './mobile-partner/mobile-partner.module';
import { RoleRequestsModule } from './role-requests/role-requests.module';

export const DOMAIN_MODULES = [
  TreasuryModule,
  PlatformConfigurationModule,
  OrganizationModule,
  SuperAdminModule,
  AuthorizationModule,
  AuthModule,
  UsersModule,
  // After UsersModule and AuthorizationModule: it orchestrates both.
  AdminIdentityModule,
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
  AttendanceModule,
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
  // Phase 21 web console sections (ADMIN / SUPER_ADMIN only).
  DashboardFinancialModule,
  DashboardOperationsModule,
  DashboardEngagementModule,
  DashboardModerationModule,
  // Mobile consoles for the non-staff roles (scope- and ownership-narrowed).
  MobileWorkforceModule,
  MobilePartnerModule,
  RoleRequestsModule,
  // Profile page's Creator Center — composes AudioRooms/Analytics/Gifts/Social,
  // owns no data of its own.
  CreatorCenterModule,
];
