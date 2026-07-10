import { Global, Module } from '@nestjs/common';
import { RELATIONSHIP_SERVICE } from 'src/modules/privacy/interfaces/relationship-provider.interface';
import { FollowController } from './controllers/follow.controller';
import { FriendsController } from './controllers/friends.controller';
import { InvitationsController } from './controllers/invitations.controller';
import { PresenceController } from './controllers/presence.controller';
import { RecommendationsController } from './controllers/recommendations.controller';
import { SocialShareController } from './controllers/social-share.controller';
import { SOCIAL_SERVICE } from './interfaces/social.interface';
import { InteractionListener } from './listeners/interaction.listener';
import { PresenceListener } from './listeners/presence.listener';
import { SocialSocketListener } from './listeners/social-socket.listener';
import { FollowRepository } from './repositories/follow.repository';
import { FriendRequestRepository } from './repositories/friend-request.repository';
import { FriendshipRepository } from './repositories/friendship.repository';
import { InvitationRepository } from './repositories/invitation.repository';
import { PresenceStateRepository } from './repositories/presence-state.repository';
import { CardResolver } from './services/card.resolver';
import { FollowService } from './services/follow.service';
import { FriendsService } from './services/friends.service';
import { InvitationsService } from './services/invitations.service';
import { RecommendationsService } from './services/recommendations.service';
import { SocialPresenceService } from './services/social-presence.service';
import { SocialRelationshipProvider } from './services/social-relationship.provider';
import { ShareService } from './services/share.service';
import { SocialExpiryScheduler } from './services/social-expiry.scheduler';
import { SocialService } from './services/social.service';
import { TrendingHostsStore } from './services/trending-hosts.store';

/**
 * Social Graph domain — friends, follows, presence, invitations and sharing.
 * Consumes PRIVACY_SERVICE (block/permission gating), PROFILE_SERVICE (card
 * resolution + counters) and SocketManager (per-user `/notifications` fan-out).
 *
 * @Global so consumers resolve SOCIAL_SERVICE by token, and — critically — so it
 * rebinds RELATIONSHIP_SERVICE (previously a null stub in PrivacyModule) to the
 * real graph, lighting up FRIENDS_ONLY / FOLLOWERS_ONLY privacy levels.
 */
@Global()
@Module({
  controllers: [
    FollowController,
    FriendsController,
    PresenceController,
    InvitationsController,
    RecommendationsController,
    SocialShareController,
  ],
  providers: [
    // repositories
    FollowRepository,
    FriendRequestRepository,
    FriendshipRepository,
    InvitationRepository,
    PresenceStateRepository,
    // services
    CardResolver,
    FollowService,
    FriendsService,
    InvitationsService,
    RecommendationsService,
    ShareService,
    SocialPresenceService,
    SocialService,
    SocialRelationshipProvider,
    TrendingHostsStore,
    // listeners
    SocialSocketListener,
    PresenceListener,
    InteractionListener,
    // housekeeping
    SocialExpiryScheduler,
    // public tokens
    { provide: SOCIAL_SERVICE, useExisting: SocialService },
    { provide: RELATIONSHIP_SERVICE, useExisting: SocialRelationshipProvider },
  ],
  exports: [SOCIAL_SERVICE, RELATIONSHIP_SERVICE],
})
export class SocialModule {}
