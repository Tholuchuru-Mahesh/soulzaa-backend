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

/** Highest rank among a role set; 0 when the set is empty or wholly unknown. */
const maxRank = (roles: string[]): number =>
  roles.reduce((highest, role) => Math.max(highest, ROLE_RANKS[role] ?? 0), 0);

/**
 * Built-in Policy Rule: an actor may only act on a target of strictly lower role
 * rank. A moderator cannot touch an admin; peers of equal rank cannot touch each
 * other; SUPER_ADMIN is exempt.
 *
 * The check applies to every action that names a target rather than to an
 * allow-list of "punitive" action codes. An allow-list is fail-open — a new
 * privileged action is unprotected until someone remembers to register it — so
 * the default is inverted: declaring `targetRoles` opts an action in, and callers
 * that genuinely need no rank check simply omit it.
 */
@Injectable()
export class RoleRankPolicyRule implements IPolicyRule {
  readonly name = 'RoleRankPolicyRule';

  async evaluate(context: PolicyContext): Promise<boolean> {
    // No declared target — nothing to outrank.
    if (!context.targetRoles) {
      return true;
    }

    // SUPER_ADMIN can act on anyone
    if (context.actorRoles.includes('SUPER_ADMIN')) {
      return true;
    }

    return maxRank(context.actorRoles) > maxRank(context.targetRoles);
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
