import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface IOwnershipProvider {
  readonly resourceType: string;
  isOwner(userId: string, resourceId: string): Promise<boolean>;
}

/**
 * Built-in default ownership provider for User Profile resource ('user')
 */
@Injectable()
export class UserProfileOwnershipProvider implements IOwnershipProvider {
  readonly resourceType = 'user';

  async isOwner(userId: string, resourceId: string): Promise<boolean> {
    return userId === resourceId;
  }
}

@Injectable()
export class ResourceOwnershipService implements OnModuleInit {
  private readonly logger = new Logger(ResourceOwnershipService.name);
  private readonly providers = new Map<string, IOwnershipProvider>();

  constructor(private readonly userProfileProvider: UserProfileOwnershipProvider) {}

  onModuleInit() {
    this.registerProvider(this.userProfileProvider);
  }

  /**
   * Registers a domain-specific ownership provider.
   * Future modules (e.g. AudioRooms, VideoRooms, Agency) can register their ownership logic during bootstrap.
   */
  registerProvider(provider: IOwnershipProvider): void {
    if (this.providers.has(provider.resourceType)) {
      this.logger.warn(`Overwriting ownership provider for resourceType: ${provider.resourceType}`);
    }
    this.providers.set(provider.resourceType, provider);
    this.logger.log(`Registered ownership provider for resourceType: '${provider.resourceType}'`);
  }

  /**
   * Evaluates if a user owns or holds resource-level authority over a specific resource ID.
   */
  async checkOwnership(resourceType: string, userId: string, resourceId: string): Promise<boolean> {
    const provider = this.providers.get(resourceType);
    if (!provider) {
      this.logger.debug(
        `No ownership provider registered for resourceType '${resourceType}'. Defaulting to false.`,
      );
      return false;
    }
    return provider.isOwner(userId, resourceId);
  }
}
