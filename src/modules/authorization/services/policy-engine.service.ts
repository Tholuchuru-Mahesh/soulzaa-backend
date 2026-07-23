import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface PolicyContext {
  actorUserId: string;
  actorRoles: string[];
  action: string;
  targetUserId?: string;
  targetRoles?: string[];
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, any>;
}

export interface IPolicyRule {
  readonly name: string;
  evaluate(context: PolicyContext): Promise<boolean>;
}

// System Role Rank Precedence Mapping (Higher number = higher authority)
export const ROLE_RANKS: Record<string, number> = {
  SUPER_ADMIN: 100,
  ADMIN: 90,
  COUNTRY_MANAGER: 80,
  OFFICIAL: 70,
  MODERATOR: 60,
  BUSINESS_DEVELOPMENT: 50,
  AGENCY: 40,
  COIN_SELLER: 40,
  HOST: 30,
  USER: 10,
};

/**
 * Built-in Policy Rule: Enforces that actors cannot perform punitive or administrative actions against targets with equal or higher role rank.
 */
@Injectable()
export class RoleRankPolicyRule implements IPolicyRule {
  readonly name = 'RoleRankPolicyRule';

  async evaluate(context: PolicyContext): Promise<boolean> {
    if (!context.targetRoles || context.targetRoles.length === 0) {
      return true;
    }

    const actorMaxRank = Math.max(...context.actorRoles.map((r) => ROLE_RANKS[r] ?? 0));
    const targetMaxRank = Math.max(...context.targetRoles.map((r) => ROLE_RANKS[r] ?? 0));

    // SUPER_ADMIN can act on anyone
    if (context.actorRoles.includes('SUPER_ADMIN')) {
      return true;
    }

    // Actor must have strictly higher rank than target for administrative actions
    const isPunitiveAction = [
      'user.ban',
      'user.mute',
      'user.delete',
      'user.update',
      'room.mute',
      'room.close',
    ].includes(context.action);

    if (isPunitiveAction) {
      return actorMaxRank > targetMaxRank;
    }

    return true;
  }
}

@Injectable()
export class PolicyEngineService implements OnModuleInit {
  private readonly logger = new Logger(PolicyEngineService.name);
  private readonly rules: IPolicyRule[] = [];

  constructor(private readonly roleRankPolicyRule: RoleRankPolicyRule) {}

  onModuleInit() {
    this.registerRule(this.roleRankPolicyRule);
  }

  /**
   * Registers a reusable policy rule into the policy evaluation engine.
   */
  registerRule(rule: IPolicyRule): void {
    this.rules.push(rule);
    this.logger.log(`Registered policy evaluation rule: '${rule.name}'`);
  }

  /**
   * Evaluates all registered policy rules against the target context.
   * Returns true if all applicable policy rules pass, false if any rule denies access.
   */
  async evaluate(context: PolicyContext): Promise<boolean> {
    for (const rule of this.rules) {
      const allowed = await rule.evaluate(context);
      if (!allowed) {
        this.logger.debug(
          `Policy rule '${rule.name}' denied action '${context.action}' for actor '${context.actorUserId}'`,
        );
        return false;
      }
    }
    return true;
  }
}
