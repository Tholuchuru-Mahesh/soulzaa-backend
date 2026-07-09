/**
 * Module boundary enforcement. The core rule: a domain module under
 * src/modules/<A> may depend on another module src/modules/<B> ONLY through
 * B's public surface — its `interfaces/` (service contract + DI token) or its
 * published `events/` — never B's entities/repositories/services/controllers.
 * Cross-domain communication otherwise goes through the EVENT_BUS
 * (src/common/events). Modules may freely use src/common and src/infra.
 *
 * Run with: pnpm boundaries
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-imports',
      severity: 'error',
      comment:
        "Access another domain module only through its public 'interfaces/' (service contract + DI token) or published 'events/', or via the EVENT_BUS (src/common/events) — never its entities/repositories/services/controllers.",
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/$1/', // same module is fine
          '^src/modules/index\\.ts$', // the aggregate registry is allowed
          '^src/modules/[^/]+/interfaces/', // another module's public service contract
          '^src/modules/[^/]+/events/', // another module's published domain events
        ],
      },
    },
    {
      name: 'infra-independent-of-modules',
      severity: 'error',
      comment: 'Infrastructure must not depend on domain modules.',
      from: { path: '^src/infra/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'common-independent-of-modules',
      severity: 'error',
      comment: 'The common layer must not depend on domain modules.',
      from: { path: '^src/common/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are not allowed.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan module (not imported anywhere) — likely dead code.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          'main\\.ts$',
          '(^|/)index\\.ts$',
          // Phase-0 extension points not yet consumed by domain logic.
          '\\.constants\\.ts$',
          '\\.interface\\.ts$', // module public-contract stubs (unconsumed until built)
          'base\\.gateway\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.spec\\.ts$|node_modules|dist)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts'],
    },
  },
};
