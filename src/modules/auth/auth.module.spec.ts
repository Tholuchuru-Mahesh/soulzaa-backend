// This suite only reads module metadata; it never boots a provider. The mocks
// exist because importing AuthModule transitively pulls in firebase-admin,
// whose jwks-rsa dependency ships ESM that jest cannot parse.
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
  getApps: jest.fn(() => []),
  cert: jest.fn(),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { GLOBAL_MODULE_METADATA } from '@nestjs/common/constants';
import { AuthModule } from './auth.module';

/**
 * AuthModule exports AUTH_SERVICE, and AdminProvisioningService injects it from
 * a different module. The dependency-cruiser boundary rule forbids importing
 * another module's `*.module.ts` — only its `interfaces/` and `events/` are
 * reachable — so the consumer *cannot* fix this with `imports: [AuthModule]`.
 *
 * That leaves exactly one mechanism, the one UsersModule and AuthorizationModule
 * already use: be @Global. Without it Nest throws
 * `UnknownDependenciesException ... Symbol(AUTH_SERVICE)` at boot, which takes
 * the whole API down rather than degrading one route — that is how it reached
 * production and returned 502 on every request.
 */
describe('AuthModule', () => {
  it('is global so cross-module consumers can resolve AUTH_SERVICE', () => {
    expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, AuthModule)).toBe(true);
  });
});
