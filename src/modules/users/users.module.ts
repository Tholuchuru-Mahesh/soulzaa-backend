import { Global, Module } from '@nestjs/common';
import { UsersController } from './controllers/users.controller';
import { PROFILE_SERVICE } from './interfaces/profile.interface';
import { USERS_SERVICE } from './interfaces/users.service.interface';
import { ProfileRepository } from './repositories/profile.repository';
import { UsersRepository } from './repositories/users.repository';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { ProfileService } from './services/profile.service';
import {
  PostgresUserSearchProvider,
  USER_SEARCH_PROVIDER,
} from './services/search/user-search.provider';
import { UsersService } from './services/users.service';

/**
 * Users domain — account identity (users) plus the profile aggregate
 * (user_profiles, user_statistics, user_verification): profile view/update,
 * avatar/cover upload, search, username availability, verification, sharing.
 *
 * @Global so consumers resolve USERS_SERVICE (identity) / PROFILE_SERVICE
 * (profile + statistics) by their interface tokens without importing this
 * module — respecting the boundary rule (cross-module access only via
 * `interfaces/`). Owns all four user tables.
 */
@Global()
@Module({
  controllers: [UsersController],
  providers: [
    UsersRepository,
    ProfileRepository,
    UsersService,
    ProfileService,
    MediaUrlResolver,
    PostgresUserSearchProvider,
    { provide: USERS_SERVICE, useExisting: UsersService },
    { provide: PROFILE_SERVICE, useExisting: ProfileService },
    { provide: USER_SEARCH_PROVIDER, useExisting: PostgresUserSearchProvider },
  ],
  exports: [USERS_SERVICE, PROFILE_SERVICE],
})
export class UsersModule {}
