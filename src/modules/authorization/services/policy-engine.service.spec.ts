import { Test, TestingModule } from '@nestjs/testing';

import { PolicyEngineService, RoleRankPolicyRule } from './policy-engine.service';
import {
  ResourceOwnershipService,
  UserProfileOwnershipProvider,
} from './resource-ownership.service';

describe('Policy Engine & Resource Ownership Services', () => {
  let policyEngine: PolicyEngineService;
  let _roleRankRule: RoleRankPolicyRule;
  let ownershipService: ResourceOwnershipService;
  let _userProfileProvider: UserProfileOwnershipProvider;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyEngineService,
        RoleRankPolicyRule,
        ResourceOwnershipService,
        UserProfileOwnershipProvider,
      ],
    }).compile();

    policyEngine = module.get<PolicyEngineService>(PolicyEngineService);
    _roleRankRule = module.get<RoleRankPolicyRule>(RoleRankPolicyRule);
    ownershipService = module.get<ResourceOwnershipService>(ResourceOwnershipService);
    _userProfileProvider = module.get<UserProfileOwnershipProvider>(UserProfileOwnershipProvider);

    // Trigger onModuleInit lifecycle
    ownershipService.onModuleInit();
    policyEngine.onModuleInit();
  });

  describe('RoleRankPolicyRule', () => {
    it('should deny MODERATOR from muting ADMIN', async () => {
      const allowed = await policyEngine.evaluate({
        actorUserId: 'mod-1',
        actorRoles: ['MODERATOR'],
        action: 'user.mute',
        targetUserId: 'admin-1',
        targetRoles: ['ADMIN'],
      });

      expect(allowed).toBe(false);
    });

    it('should allow ADMIN to mute MODERATOR', async () => {
      const allowed = await policyEngine.evaluate({
        actorUserId: 'admin-1',
        actorRoles: ['ADMIN'],
        action: 'user.mute',
        targetUserId: 'mod-1',
        targetRoles: ['MODERATOR'],
      });

      expect(allowed).toBe(true);
    });

    it('should allow SUPER_ADMIN to act against anyone', async () => {
      const allowed = await policyEngine.evaluate({
        actorUserId: 'sa-1',
        actorRoles: ['SUPER_ADMIN'],
        action: 'user.ban',
        targetUserId: 'admin-1',
        targetRoles: ['ADMIN'],
      });

      expect(allowed).toBe(true);
    });
  });

  describe('ResourceOwnershipService', () => {
    it('should verify self-ownership for user profile resource', async () => {
      const isOwner = await ownershipService.checkOwnership('user', 'user-123', 'user-123');
      const isNotOwner = await ownershipService.checkOwnership('user', 'user-123', 'user-999');

      expect(isOwner).toBe(true);
      expect(isNotOwner).toBe(false);
    });

    it('should return false for unregistered resource types', async () => {
      const isOwner = await ownershipService.checkOwnership('unknown_type', 'user-1', 'res-1');
      expect(isOwner).toBe(false);
    });
  });
});
