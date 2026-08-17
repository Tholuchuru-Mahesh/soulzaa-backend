# Moderator Mobile Login & Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a username/email + password login method to `soulzaa_mobile`'s login page that is gated to the RBAC `MODERATOR` role, and a Moderator Dashboard screen shown after a successful gated login, matching the provided mockups and using the assets in `assets/Moderator_UI/`.

**Architecture:** Reuse existing, already-implemented backend surface (`POST /staff/auth/login`, `GET /authorization/me`, `GET /mobile/workforce/me/dashboard`, the device-change-request and staff-IP-allowlist services) almost entirely as-is. The only backend change is making an unbound-device login rejection *file* a reviewable request instead of silently dropping it, plus two new error codes so the mobile client can distinguish failure cases it currently cannot. On mobile, the moderator login/session is a fully separate module (own token store, own Dio client, own session state) so it never touches the consumer `authControllerProvider`/`sessionProvider` state machine — a moderator account has no `gender`/`dateOfBirth` set, which would otherwise trip the app's existing profile-completion redirect. Two new admin-panel screens (Allowed IPs, Device Change Requests) close the loop so a human can actually action what the backend produces.

**Tech Stack:** NestJS + Prisma (backend), Flutter + Riverpod + go_router + Dio (mobile), React + TypeScript (admin panel).

**Spec:** `docs/superpowers/specs/2026-08-15-moderator-mobile-login-dashboard-design.md`

## Global Constraints

- Global API prefix is `api` — every backend path below is relative to that (e.g. `POST /staff/auth/login` is actually served at `POST /api/staff/auth/login`); mobile's `AppConfig.apiBaseUrl` already includes `/api`, so `ApiEndpoints` constants stay prefix-relative as they already are elsewhere in the file.
- Only the RBAC-resolved `assignedRoles` from `GET /authorization/me` may be used to decide "is this user a moderator" — never the `roles` field on the plain login response `user` object, which can be a stale legacy column (confirmed by `auth.service.spec.ts`'s existing "RBAC is the source of truth" test).
- The moderator login/session must never write to `authControllerProvider`, `sessionProvider`, or the consumer `SecureTokenStore` — those are exclusively for the consumer login flows already in this app.
- **Known, deliberate scope cut:** `GET /mobile/workforce/me/scope` (and the `scope` field embedded in the dashboard response) returns `regionCode`/`stateCode`/`countryCode` but no human-readable region *name* — the `Region` Prisma model has a `name` field, but nothing in the current scope-resolution service surfaces it. The dashboard in this plan displays `regionCode` for both the region label and the "Region ID" line rather than inventing an unverified backend join. Resolving readable region names is a small, separate backend enhancement, not part of this plan.
- Follow existing conventions per repo: Flutter screens use `context.colorScheme`/`context.textTheme`/`AppSpacing` (the newer convention in this codebase, not hardcoded hex); NestJS domain errors are `BusinessException(ERROR_CODES.X, message, status)`, never a bare Nest exception, when a client needs to branch on the outcome; React admin screens follow the `Panel`/`DataTable`/`useResource` pattern already used by `ModeratorManagementModule.tsx`.

---

## Task 1: Backend — new error codes

**Files:**
- Modify: `src/common/exceptions/error-codes.ts:45-47`

**Interfaces:**
- Produces: `ERROR_CODES.DEVICE_CHANGE_PENDING` (`'DEVICE_CHANGE_PENDING'`), `ERROR_CODES.STAFF_IP_NOT_ALLOWED` (`'STAFF_IP_NOT_ALLOWED'`) — consumed by Task 2's implementation and tests.

- [ ] **Step 1: Add the two new error codes**

In `src/common/exceptions/error-codes.ts`, find:

```ts
  // ---- Device domain ----
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_FORBIDDEN: 'DEVICE_FORBIDDEN',
```

Replace with:

```ts
  // ---- Device domain ----
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_FORBIDDEN: 'DEVICE_FORBIDDEN',
  DEVICE_CHANGE_PENDING: 'DEVICE_CHANGE_PENDING',
  STAFF_IP_NOT_ALLOWED: 'STAFF_IP_NOT_ALLOWED',
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p .` (from `c:\Users\soulz\Downloads\soulzaa-backend`)
Expected: no new errors. `ErrorCode` is derived automatically via `(typeof ERROR_CODES)[keyof typeof ERROR_CODES]`, so no other file needs a type update.

- [ ] **Step 3: Commit**

```bash
git add src/common/exceptions/error-codes.ts
git commit -m "feat: add DEVICE_CHANGE_PENDING and STAFF_IP_NOT_ALLOWED error codes"
```

---

## Task 2: Backend — `staffLogin` files a device-change request and distinguishes IP rejection

**Files:**
- Modify: `src/modules/auth/services/auth.service.ts:1` (import), `:251-282` (two branches)
- Test: `src/modules/auth/services/auth.service.spec.ts`

**Interfaces:**
- Consumes: `ERROR_CODES.DEVICE_CHANGE_PENDING`, `ERROR_CODES.STAFF_IP_NOT_ALLOWED` (Task 1); `ModeratorDeviceBindingService.requestDeviceChange({moderatorId, oldDeviceId?, newDeviceInfo, reason?})` (existing, throws `ConflictException` if a `PENDING` request already exists for that moderator).
- Produces: `staffLogin` now rejects an unbound device with `BusinessException(errorCode: 'DEVICE_CHANGE_PENDING', status: 409)` instead of a bare `ConflictException`, and rejects a disallowed IP with `errorCode: 'STAFF_IP_NOT_ALLOWED'` instead of the previously shared `'FORBIDDEN'`.

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/auth/services/auth.service.spec.ts`. First add two imports at the top of the file (alongside the existing imports):

```ts
import { ConflictException } from '@nestjs/common';
import type { ModeratorDeviceBindingService } from 'src/modules/device/services/moderator-device-binding.service';
import type { StaffIpAllowlistService } from 'src/modules/device/services/staff-ip-allowlist.service';
```

Then add this new `describe` block at the end of the file, inside the outer `describe('AuthService', () => { ... })`, as a sibling of the existing `describe` blocks (paste it just before the final closing `});` of the outer describe):

```ts
  describe('staffLogin', () => {
    function buildService(overrides: {
      deviceBinding?: jest.Mocked<
        Pick<ModeratorDeviceBindingService, 'assertSingleDevice' | 'requestDeviceChange'>
      >;
      staffIpAllowlist?: jest.Mocked<Pick<StaffIpAllowlistService, 'isIpAllowed'>>;
    }): AuthService {
      const config = { get: () => ({ passwordResetTtlSeconds: 900 }) } as unknown as ConfigService;
      return new AuthService(
        users,
        bus,
        social,
        otp,
        sessions as unknown as ISessionService,
        repo,
        passwords as unknown as PasswordService,
        security as unknown as LoginSecurityService,
        firebase as unknown as FirebaseService,
        config,
        roleSource,
        undefined,
        overrides.deviceBinding as unknown as ModeratorDeviceBindingService | undefined,
        overrides.staffIpAllowlist as unknown as StaffIpAllowlistService | undefined,
        undefined,
      );
    }

    beforeEach(() => {
      users.findByEmail.mockResolvedValue(makeIdentity({ id: 'mod1' }));
      repo.getCredential.mockResolvedValue({ passwordHash: 'HASH' } as never);
      passwords.verify.mockResolvedValue(true);
      roleSource.getRoleNames.mockResolvedValue(['MODERATOR']);
    });

    it('files a device-change request and rejects with DEVICE_CHANGE_PENDING on an unbound device', async () => {
      const deviceBinding = {
        assertSingleDevice: jest
          .fn()
          .mockRejectedValue(new ConflictException('Moderators are restricted to one active device.')),
        requestDeviceChange: jest.fn().mockResolvedValue({ id: 'req1' }),
      };
      const service = buildService({ deviceBinding });

      await expect(
        service.staffLogin(
          { email: 'mod@example.com', password: 'Str0ng@Pass', deviceIdentifier: 'device-new' },
          {},
        ),
      ).rejects.toMatchObject({ errorCode: 'DEVICE_CHANGE_PENDING' });

      expect(deviceBinding.requestDeviceChange).toHaveBeenCalledWith(
        expect.objectContaining({
          moderatorId: 'mod1',
          newDeviceInfo: expect.objectContaining({ deviceIdentifier: 'device-new' }),
        }),
      );
    });

    it('does not file a second request when one is already pending', async () => {
      const deviceBinding = {
        assertSingleDevice: jest
          .fn()
          .mockRejectedValue(new ConflictException('Moderators are restricted to one active device.')),
        requestDeviceChange: jest
          .fn()
          .mockRejectedValue(new ConflictException('A device change request is already pending review.')),
      };
      const service = buildService({ deviceBinding });

      await expect(
        service.staffLogin(
          { email: 'mod@example.com', password: 'Str0ng@Pass', deviceIdentifier: 'device-new' },
          {},
        ),
      ).rejects.toMatchObject({ errorCode: 'DEVICE_CHANGE_PENDING' });

      expect(deviceBinding.requestDeviceChange).toHaveBeenCalledTimes(1);
    });

    it('rejects a disallowed IP with STAFF_IP_NOT_ALLOWED, distinct from a non-staff role', async () => {
      const staffIpAllowlist = { isIpAllowed: jest.fn().mockResolvedValue(false) };
      const service = buildService({ staffIpAllowlist });

      await expect(
        service.staffLogin({ email: 'mod@example.com', password: 'Str0ng@Pass' }, { ip: '10.0.0.5' }),
      ).rejects.toMatchObject({ errorCode: 'STAFF_IP_NOT_ALLOWED' });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/auth/services/auth.service.spec.ts -t staffLogin` (from `c:\Users\soulz\Downloads\soulzaa-backend`)
Expected: FAIL — the first two tests fail because `errorCode` is currently absent (bare `ConflictException` has no `errorCode` property, so `toMatchObject({ errorCode: 'DEVICE_CHANGE_PENDING' })` fails, and `requestDeviceChange` is never called since the current code just rethrows). The third fails because the current code sends `errorCode: 'FORBIDDEN'`, not `'STAFF_IP_NOT_ALLOWED'`.

- [ ] **Step 3: Add the `ConflictException` import to `auth.service.ts`**

In `src/modules/auth/services/auth.service.ts`, change line 1 from:

```ts
import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
```

to:

```ts
import { ConflictException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
```

- [ ] **Step 4: Rewrite the device-binding branch**

In the same file, replace lines 251-264:

```ts
    // 3. Bound Device Verification (Task 11)
    if (this.deviceBinding && input.deviceIdentifier) {
      try {
        await this.deviceBinding.assertSingleDevice(user.id, input.deviceIdentifier);
      } catch (err) {
        await this.security.recordFailure(identifier, {
          userId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          reason: 'UNBOUND_DEVICE',
        });
        throw err;
      }
    }
```

with:

```ts
    // 3. Bound Device Verification (Task 11)
    if (this.deviceBinding && input.deviceIdentifier) {
      try {
        await this.deviceBinding.assertSingleDevice(user.id, input.deviceIdentifier);
      } catch (err) {
        await this.security.recordFailure(identifier, {
          userId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          reason: 'UNBOUND_DEVICE',
        });

        if (!(err instanceof ConflictException)) throw err;

        // The device is unrecognized. File a device-change request so an
        // admin has something to approve — the caller has no session yet
        // (this throw happens before `issue()`), so they cannot call the
        // authenticated `POST /moderator/device-change` endpoint themselves.
        try {
          await this.deviceBinding.requestDeviceChange({
            moderatorId: user.id,
            newDeviceInfo: {
              deviceIdentifier: input.deviceIdentifier,
              ip: ctx.ip ?? null,
            },
            reason: 'Automatic: rejected login from unbound device',
          });
        } catch (requestErr) {
          // A request is already pending from an earlier attempt — that is
          // the desired end state, not a new failure.
          if (!(requestErr instanceof ConflictException)) throw requestErr;
        }

        throw new BusinessException(
          ERROR_CODES.DEVICE_CHANGE_PENDING,
          "This device isn't recognized. A request has been sent for admin approval.",
          HttpStatus.CONFLICT,
        );
      }
    }
```

- [ ] **Step 5: Rewrite the IP-allowlist branch**

Replace lines 266-282 (now shifted down by the insertion above, but identified by content):

```ts
    // 4. Staff IP Allowlist Verification (Gap B1)
    if (this.staffIpAllowlist && ctx.ip) {
      const allowed = await this.staffIpAllowlist.isIpAllowed(user.id, ctx.ip);
      if (!allowed) {
        await this.security.recordFailure(identifier, {
          userId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          reason: 'UNAUTHORIZED_STAFF_IP',
        });
        throw new BusinessException(
          ERROR_CODES.FORBIDDEN,
          'Access denied: Login is restricted to approved IP addresses.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
```

with (only the `ERROR_CODES.FORBIDDEN` on the throw changes):

```ts
    // 4. Staff IP Allowlist Verification (Gap B1)
    if (this.staffIpAllowlist && ctx.ip) {
      const allowed = await this.staffIpAllowlist.isIpAllowed(user.id, ctx.ip);
      if (!allowed) {
        await this.security.recordFailure(identifier, {
          userId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          reason: 'UNAUTHORIZED_STAFF_IP',
        });
        throw new BusinessException(
          ERROR_CODES.STAFF_IP_NOT_ALLOWED,
          'Access denied: Login is restricted to approved IP addresses.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/modules/auth/services/auth.service.spec.ts` (whole file, to also confirm no existing test broke)
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/services/auth.service.ts src/modules/auth/services/auth.service.spec.ts
git commit -m "feat: file a device-change request on unbound-device staff login, distinguish IP rejection"
```

---

## Task 3: Mobile — preserve the backend `errorCode` through a 401 response

**Files:**
- Modify: `lib/core/error/app_exception.dart:58-61`
- Modify: `lib/core/error/error_mapper.dart:47-53`, `:128-129`
- Test: `test/core/error/error_mapper_test.dart` (new)

**Interfaces:**
- Produces: `AuthenticationException.errorCode` (`String?`), and `ErrorMapper.toFailure`'s `AuthenticationException` branch now returns `UnauthorizedFailure(message: <real backend message>, code: <real backend errorCode> ?? BackendErrorCode.unauthorized)` instead of a hardcoded generic pair. Every other `AppFailure` subtype and mapping branch is unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/core/error/error_mapper_test.dart`:

```dart
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/core/error/error_codes.dart';
import 'package:soulzaa_mobile/core/error/error_mapper.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';

DioException _dioError(int status, Map<String, dynamic>? body) {
  final RequestOptions options = RequestOptions(path: '/staff/auth/login');
  return DioException(
    requestOptions: options,
    response: Response<dynamic>(
      requestOptions: options,
      statusCode: status,
      data: body,
    ),
    type: DioExceptionType.badResponse,
  );
}

void main() {
  group('ErrorMapper 401 handling', () {
    test('preserves INVALID_CREDENTIALS as the failure code', () {
      final AppFailure failure = ErrorMapper.mapToFailure(
        _dioError(401, <String, dynamic>{
          'errorCode': 'INVALID_CREDENTIALS',
          'message': 'Invalid credentials',
        }),
      );

      expect(failure, isA<UnauthorizedFailure>());
      expect(failure.code, BackendErrorCode.invalidCredentials);
    });

    test('falls back to UNAUTHORIZED when the backend sends no errorCode', () {
      final AppFailure failure = ErrorMapper.mapToFailure(
        _dioError(401, <String, dynamic>{
          'message': 'Two-factor authentication failed',
        }),
      );

      expect(failure, isA<UnauthorizedFailure>());
      expect(failure.code, BackendErrorCode.unauthorized);
    });

    test('distinguishes invalid credentials from a 2FA rejection by code', () {
      final AppFailure badPassword = ErrorMapper.mapToFailure(
        _dioError(401, <String, dynamic>{'errorCode': 'INVALID_CREDENTIALS'}),
      );
      final AppFailure badTotp = ErrorMapper.mapToFailure(
        _dioError(401, <String, dynamic>{'errorCode': 'UNAUTHORIZED'}),
      );

      expect(badPassword.code, BackendErrorCode.invalidCredentials);
      expect(badTotp.code, BackendErrorCode.unauthorized);
      expect(badPassword.code, isNot(equals(badTotp.code)));
    });
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/core/error/error_mapper_test.dart` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: FAIL on the first and third tests — `failure.code` is currently always the hardcoded `BackendErrorCode.unauthorized` regardless of what the backend sent, so `expect(failure.code, BackendErrorCode.invalidCredentials)` fails.

- [ ] **Step 3: Add `errorCode` to `AuthenticationException`**

In `lib/core/error/app_exception.dart`, replace lines 58-61:

```dart
/// Authentication failed or the session is no longer valid (401).
class AuthenticationException extends AppException {
  const AuthenticationException(super.message, {super.cause, super.stackTrace});
}
```

with:

```dart
/// Authentication failed or the session is no longer valid (401). Carries the
/// backend `errorCode` (when present) so call sites can distinguish e.g.
/// `INVALID_CREDENTIALS` from a 2FA rejection rather than treating every 401
/// identically — mirrors [ForbiddenException]'s pattern.
class AuthenticationException extends AppException {
  const AuthenticationException(
    super.message, {
    this.errorCode,
    super.cause,
    super.stackTrace,
  });

  final String? errorCode;
}
```

- [ ] **Step 4: Populate it in `_fromResponse` and use it in `toFailure`**

In `lib/core/error/error_mapper.dart`, replace line 129:

```dart
      case 401:
        return AuthenticationException(message, cause: e);
```

with:

```dart
      case 401:
        return AuthenticationException(
          message,
          errorCode: apiError?.errorCode,
          cause: e,
        );
```

Then replace lines 47-53:

```dart
      case AuthenticationException():
        return UnauthorizedFailure(
          message:
              ErrorMessages.forCode(BackendErrorCode.unauthorized) ??
              ErrorMessages.unauthorized,
          code: BackendErrorCode.unauthorized,
        );
```

with:

```dart
      case AuthenticationException(:final errorCode):
        return UnauthorizedFailure(
          message: exception.message,
          code: errorCode ?? BackendErrorCode.unauthorized,
        );
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `flutter test test/core/error/error_mapper_test.dart`
Expected: PASS.

- [ ] **Step 6: Confirm no other call site depended on the old hardcoded 401 message**

Run: `grep -rn "UnauthorizedFailure" lib/` (from `c:\Users\soulz\Downloads\soulzaa-mobile`) and read each result. This step is a check, not a code change — every 401 across the app previously produced the exact same generic message regardless of cause; after this fix it carries the backend's real message and code. Confirm no call site pattern-matches on that old generic text (e.g. `if (failure.message == 'Session expired')`) rather than on `failure is UnauthorizedFailure` or `failure.code`. If one does, note it — do not silently change it as part of this task.

- [ ] **Step 7: Run the full test suite**

Run: `flutter test` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add lib/core/error/app_exception.dart lib/core/error/error_mapper.dart test/core/error/error_mapper_test.dart
git commit -m "fix: preserve backend errorCode through 401 responses instead of a hardcoded generic"
```

---

## Task 4: Mobile — new error-code and endpoint constants

**Files:**
- Modify: `lib/core/error/error_codes.dart`
- Modify: `lib/core/constants/api_endpoints.dart:32`

**Interfaces:**
- Produces: `BackendErrorCode.staffIpNotAllowed`, `BackendErrorCode.deviceChangePending`, `ApiEndpoints.staffLogin`, `ApiEndpoints.authorizationMe` — consumed by Task 6 and Task 9.

- [ ] **Step 1: Add the new backend error codes**

In `lib/core/error/error_codes.dart`, find:

```dart
  // Auth / OTP
  static const String invalidCredentials = 'INVALID_CREDENTIALS';
  static const String otpInvalid = 'OTP_INVALID';
  static const String otpExpired = 'OTP_EXPIRED';
  static const String otpMaxAttempts = 'OTP_MAX_ATTEMPTS';
```

Replace with:

```dart
  // Auth / OTP
  static const String invalidCredentials = 'INVALID_CREDENTIALS';
  static const String otpInvalid = 'OTP_INVALID';
  static const String otpExpired = 'OTP_EXPIRED';
  static const String otpMaxAttempts = 'OTP_MAX_ATTEMPTS';

  // Staff / moderator portal
  static const String staffIpNotAllowed = 'STAFF_IP_NOT_ALLOWED';
  static const String deviceChangePending = 'DEVICE_CHANGE_PENDING';
```

- [ ] **Step 2: Add the new endpoint constants**

In `lib/core/constants/api_endpoints.dart`, find:

```dart
  static const String authMe = '/auth/me';
```

Replace with:

```dart
  static const String authMe = '/auth/me';
  static const String staffLogin = '/staff/auth/login';
  static const String authorizationMe = '/authorization/me';
```

- [ ] **Step 3: Verify it compiles**

Run: `flutter analyze lib/core/error/error_codes.dart lib/core/constants/api_endpoints.dart` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: No issues.

- [ ] **Step 4: Commit**

```bash
git add lib/core/error/error_codes.dart lib/core/constants/api_endpoints.dart
git commit -m "feat: add staff-login/authorization-me endpoints and their error codes"
```

---

## Task 5: Mobile — separate token store and Dio client for the moderator session

**Files:**
- Create: `lib/features/moderator/data/moderator_token_store.dart`
- Modify: `lib/core/constants/storage_keys.dart:13`
- Modify: `lib/core/providers/core_providers.dart` (append new providers)
- Test: `test/features/moderator/moderator_token_store_test.dart` (new)

**Interfaces:**
- Produces: `ModeratorTokenStore implements AuthTokenStore` with an added `Future<bool> hasSession()`; `moderatorTokenStoreProvider: Provider<ModeratorTokenStore>`; `moderatorTokenRefresherProvider: Provider<TokenRefresherImpl>`. This task deliberately stops short of `moderatorDioClientProvider` — that provider's `onSessionExpired` callback needs `moderatorSessionProvider`, which doesn't exist until Task 7, and adding it here would leave `core_providers.dart` non-compiling between tasks. Task 7 adds `moderatorDioClientProvider` alongside the session provider it depends on, once both are resolvable in the same task.

- [ ] **Step 1: Write the failing test**

Create `test/features/moderator/moderator_token_store_test.dart`:

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/core/constants/storage_keys.dart';
import 'package:soulzaa_mobile/core/services/storage/secure_storage_service.dart';
import 'package:soulzaa_mobile/features/moderator/data/moderator_token_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  FlutterSecureStorage.setMockInitialValues(<String, String>{});

  test('saves, reads, and clears tokens under moderator-specific keys', () async {
    final ModeratorTokenStore store = ModeratorTokenStore(SecureStorageService());

    expect(await store.hasSession(), isFalse);

    await store.saveTokens(accessToken: 'acc-1', refreshToken: 'ref-1');
    expect(await store.readAccessToken(), 'acc-1');
    expect(await store.readRefreshToken(), 'ref-1');
    expect(await store.hasSession(), isTrue);

    await store.clear();
    expect(await store.readAccessToken(), isNull);
    expect(await store.hasSession(), isFalse);
  });

  test('storage keys are distinct from the consumer token store', () {
    expect(StorageKeys.moderatorAccessToken, isNot(equals(StorageKeys.accessToken)));
    expect(StorageKeys.moderatorRefreshToken, isNot(equals(StorageKeys.refreshToken)));
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/features/moderator/moderator_token_store_test.dart` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: FAIL — `moderator_token_store.dart` and `StorageKeys.moderatorAccessToken`/`moderatorRefreshToken` don't exist yet.

- [ ] **Step 3: Add the new storage keys**

In `lib/core/constants/storage_keys.dart`, find:

```dart
  static const String accessToken = 'sz_access_token';
  static const String refreshToken = 'sz_refresh_token';
  static const String tokenType = 'sz_token_type';
  static const String userId = 'sz_user_id';
  static const String userIdentity = 'sz_user_identity';
  static const String deviceId = 'sz_device_id';
```

Replace with:

```dart
  static const String accessToken = 'sz_access_token';
  static const String refreshToken = 'sz_refresh_token';
  static const String tokenType = 'sz_token_type';
  static const String userId = 'sz_user_id';
  static const String userIdentity = 'sz_user_identity';
  static const String deviceId = 'sz_device_id';

  /// Kept entirely separate from the consumer token keys above so a
  /// moderator login on a device that already has a consumer session logged
  /// in never overwrites it, and vice versa.
  static const String moderatorAccessToken = 'sz_moderator_access_token';
  static const String moderatorRefreshToken = 'sz_moderator_refresh_token';
  static const String moderatorTokenType = 'sz_moderator_token_type';
```

- [ ] **Step 4: Create `ModeratorTokenStore`**

Create `lib/features/moderator/data/moderator_token_store.dart`:

```dart
import 'package:soulzaa_mobile/core/constants/storage_keys.dart';
import 'package:soulzaa_mobile/core/network/token_provider.dart';
import 'package:soulzaa_mobile/core/services/storage/secure_storage_service.dart';

/// Token storage for a moderator's staff-portal session. Deliberately not
/// [SecureTokenStore]: keeping the two token stores separate means logging in
/// as a moderator can never clobber a consumer session already active on the
/// same device (or vice versa).
class ModeratorTokenStore implements AuthTokenStore {
  ModeratorTokenStore(this._storage);

  final SecureStorageService _storage;

  @override
  Future<String?> readAccessToken() =>
      _storage.read(StorageKeys.moderatorAccessToken);

  @override
  Future<String?> readRefreshToken() =>
      _storage.read(StorageKeys.moderatorRefreshToken);

  @override
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
    String tokenType = 'Bearer',
  }) async {
    await _storage.write(StorageKeys.moderatorAccessToken, accessToken);
    await _storage.write(StorageKeys.moderatorRefreshToken, refreshToken);
    await _storage.write(StorageKeys.moderatorTokenType, tokenType);
  }

  @override
  Future<void> clear() async {
    await _storage.delete(StorageKeys.moderatorAccessToken);
    await _storage.delete(StorageKeys.moderatorRefreshToken);
    await _storage.delete(StorageKeys.moderatorTokenType);
  }

  Future<bool> hasSession() async {
    final String? token = await readAccessToken();
    return token != null && token.isNotEmpty;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `flutter test test/features/moderator/moderator_token_store_test.dart`
Expected: PASS.

- [ ] **Step 6: Add the moderator token store and refresher providers**

Append to `lib/core/providers/core_providers.dart` (after the existing `dioClientProvider` block, before `socketManagerProvider`):

```dart
final Provider<ModeratorTokenStore> moderatorTokenStoreProvider =
    Provider<ModeratorTokenStore>(
      (Ref ref) => ModeratorTokenStore(ref.watch(secureStorageServiceProvider)),
    );

final Provider<TokenRefresherImpl> moderatorTokenRefresherProvider =
    Provider<TokenRefresherImpl>(
      (Ref ref) => TokenRefresherImpl(
        config: ref.watch(appConfigProvider),
        tokenStore: ref.watch(moderatorTokenStoreProvider),
        logger: ref.watch(loggerProvider),
      ),
    );
```

Add the matching import near the top of the file, alongside the existing imports:

```dart
import 'package:soulzaa_mobile/features/moderator/data/moderator_token_store.dart';
```

`moderatorDioClientProvider` (which needs both of the providers above, plus `moderatorSessionProvider`) is deliberately not added here — it is Task 7's Step 6, once `moderatorSessionProvider` exists to satisfy its `onSessionExpired` callback. Adding it now would leave this shared file unable to compile between tasks.

- [ ] **Step 7: Verify it compiles**

Run: `flutter analyze lib/features/moderator/data/moderator_token_store.dart lib/core/providers/core_providers.dart` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: No issues — every symbol this step added or referenced (`ModeratorTokenStore`, `moderatorTokenStoreProvider`, `moderatorTokenRefresherProvider`, `TokenRefresherImpl`, `appConfigProvider`, `loggerProvider`, `secureStorageServiceProvider`) already exists.

- [ ] **Step 8: Commit**

```bash
git add lib/features/moderator/data/moderator_token_store.dart lib/core/constants/storage_keys.dart lib/core/providers/core_providers.dart test/features/moderator/moderator_token_store_test.dart
git commit -m "feat: add a separate token store and Dio client for the moderator session"
```

---

## Task 6: Mobile — moderator remote data source (staff login, role profile, dashboard)

**Files:**
- Create: `lib/features/moderator/data/models/moderator_authorization_profile.dart`
- Create: `lib/features/moderator/data/models/moderator_dashboard.dart`
- Create: `lib/features/moderator/data/moderator_remote_data_source.dart`
- Test: `test/features/moderator/moderator_remote_data_source_test.dart` (new)

**Interfaces:**
- Consumes: `AuthResultModel.fromJson` (existing, reused as-is — a staff login response is `{user, tokens, isNewUser}`, identical to a consumer login response); `DioClient`/`ApiEndpoints.staffLogin`/`.authorizationMe` (Task 4); `GET /mobile/workforce/me/dashboard` (existing backend endpoint, no path constant existed for it yet).
- Produces: `ModeratorAuthorizationProfile{userId, assignedRoles, inheritedRoles, isModerator}`; `ModeratorDashboard` (shift/region/stats, field list below); `ModeratorRemoteDataSource{staffLogin(), getAuthorizationProfile(), getDashboard()}` — consumed by Task 7 and Task 10.

- [ ] **Step 1: Write the failing tests**

Create `test/features/moderator/moderator_remote_data_source_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_authorization_profile.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_dashboard.dart';

void main() {
  group('ModeratorAuthorizationProfile', () {
    test('isModerator is true only when MODERATOR is in assignedRoles', () {
      final ModeratorAuthorizationProfile moderator =
          ModeratorAuthorizationProfile.fromJson(<String, dynamic>{
            'userId': 'u1',
            'assignedRoles': <String>['MODERATOR'],
            'inheritedRoles': <String>[],
          });
      expect(moderator.isModerator, isTrue);

      final ModeratorAuthorizationProfile official =
          ModeratorAuthorizationProfile.fromJson(<String, dynamic>{
            'userId': 'u2',
            'assignedRoles': <String>['OFFICIAL'],
            'inheritedRoles': <String>['MODERATOR'],
          });
      expect(
        official.isModerator,
        isFalse,
        reason: 'MODERATOR must be a direct assignment, not merely inherited',
      );
    });
  });

  group('ModeratorDashboard', () {
    test('parses a full payload', () {
      final ModeratorDashboard dashboard = ModeratorDashboard.fromJson(<String, dynamic>{
        'scope': <String, dynamic>{
          'assignments': <Map<String, dynamic>>[
            <String, dynamic>{
              'role': 'MODERATOR',
              'scopeType': 'REGION',
              'countryCode': 'IN',
              'stateCode': 'S',
              'regionCode': 'IN-S-04',
            },
          ],
        },
        'shift': <String, dynamic>{
          'startHour': 8,
          'startMinute': 0,
          'endHour': 16,
          'endMinute': 0,
        },
        'shiftActive': true,
        'nextShiftStartsInSeconds': null,
        'todayStats': <String, dynamic>{
          'reportsReviewed': 18,
          'reportsResolved': 46,
          'reportsEscalated': 6,
          'warningsIssued': 3,
          'avgResolutionMinutes': 18.0,
          'performanceScore': 92.0,
          'taskCompletionRate': 89.0,
        },
        // Deliberately different from todayStats.warningsIssued above —
        // warningsReceivedCount is a *different* metric (disciplinary
        // warnings against this moderator, from a separate top-level field)
        // and must never be the source for the "Warnings issued" stat.
        // A shared value here would let the two fields silently swap without
        // failing this test.
        'warningsReceivedCount': 99,
        'assignedReportsCount': 32,
      });

      expect(dashboard.regionCode, 'IN-S-04');
      expect(dashboard.shiftActive, isTrue);
      expect(dashboard.shiftStartHour, 8);
      expect(dashboard.shiftEndHour, 16);
      expect(dashboard.shiftEndMinute, 0);
      expect(dashboard.nextShiftStartsInSeconds, isNull);
      expect(dashboard.reportsAssigned, 32);
      expect(dashboard.reportsUnderReview, 18);
      expect(dashboard.reportsSolved, 46);
      expect(dashboard.reportsEscalated, 6);
      expect(dashboard.warningsIssued, 3);
      expect(dashboard.performanceScore, 92.0);
      expect(dashboard.avgResolutionMinutes, 18.0);
      expect(dashboard.taskCompletionRate, 89.0);
    });

    test('parses a payload with no shift and no stats yet', () {
      final ModeratorDashboard dashboard = ModeratorDashboard.fromJson(<String, dynamic>{
        'scope': <String, dynamic>{'assignments': <Map<String, dynamic>>[]},
        'shift': null,
        'shiftActive': false,
        'nextShiftStartsInSeconds': 3600,
        'todayStats': null,
        'warningsReceivedCount': 0,
        'assignedReportsCount': 0,
      });

      expect(dashboard.regionCode, isNull);
      expect(dashboard.shiftActive, isFalse);
      expect(dashboard.shiftStartHour, isNull);
      expect(dashboard.shiftEndHour, isNull);
      expect(dashboard.shiftEndMinute, isNull);
      expect(dashboard.nextShiftStartsInSeconds, 3600);
      expect(dashboard.reportsAssigned, 0);
      expect(dashboard.reportsUnderReview, 0);
      expect(dashboard.reportsSolved, 0);
      expect(dashboard.reportsEscalated, 0);
      expect(dashboard.warningsIssued, 0);
      expect(dashboard.performanceScore, 0.0);
      expect(dashboard.avgResolutionMinutes, 0.0);
      expect(dashboard.taskCompletionRate, 0.0);
    });
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `flutter test test/features/moderator/moderator_remote_data_source_test.dart` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: FAIL — neither model file exists yet.

- [ ] **Step 3: Create `ModeratorAuthorizationProfile`**

Create `lib/features/moderator/data/models/moderator_authorization_profile.dart`:

```dart
/// The current user's RBAC-resolved authorization profile, from
/// `GET /authorization/me`. This is the source of truth for role checks —
/// never the `roles` field on a plain login response, which can be a stale
/// legacy column.
class ModeratorAuthorizationProfile {
  const ModeratorAuthorizationProfile({
    required this.userId,
    required this.assignedRoles,
    required this.inheritedRoles,
  });

  final String userId;
  final List<String> assignedRoles;
  final List<String> inheritedRoles;

  /// True only when MODERATOR was assigned directly to this account (e.g. via
  /// the admin panel's Provision Moderator flow), not merely inherited
  /// through the role hierarchy — matching the literal "is this person a
  /// moderator" gate this login method is required to enforce.
  bool get isModerator => assignedRoles.contains('MODERATOR');

  factory ModeratorAuthorizationProfile.fromJson(Map<String, dynamic> json) {
    return ModeratorAuthorizationProfile(
      userId: json['userId'] as String,
      assignedRoles: _stringList(json['assignedRoles']),
      inheritedRoles: _stringList(json['inheritedRoles']),
    );
  }

  static List<String> _stringList(Object? value) {
    if (value is! List) return const <String>[];
    return value.map((Object? e) => e.toString()).toList(growable: false);
  }
}
```

- [ ] **Step 4: Create `ModeratorDashboard`**

Create `lib/features/moderator/data/models/moderator_dashboard.dart`:

```dart
/// Snapshot from `GET /mobile/workforce/me/dashboard`. Field names below map
/// to the backend's `ModeratorShift` and `ModeratorDailyStats` Prisma models.
///
/// The backend does not currently return a human-readable region *name* —
/// only `regionCode` (e.g. `IN-S-04`). [regionCode] is used for both the
/// region label and the "Region ID" line until that gap is closed
/// server-side; see the plan's Global Constraints.
class ModeratorDashboard {
  const ModeratorDashboard({
    required this.regionCode,
    required this.shiftActive,
    required this.shiftStartHour,
    required this.shiftStartMinute,
    required this.shiftEndHour,
    required this.shiftEndMinute,
    required this.nextShiftStartsInSeconds,
    required this.reportsAssigned,
    required this.reportsUnderReview,
    required this.reportsSolved,
    required this.reportsEscalated,
    required this.warningsIssued,
    required this.performanceScore,
    required this.avgResolutionMinutes,
    required this.taskCompletionRate,
  });

  final String? regionCode;
  final bool shiftActive;
  final int? shiftStartHour;
  final int? shiftStartMinute;
  final int? shiftEndHour;
  final int? shiftEndMinute;
  final int? nextShiftStartsInSeconds;
  final int reportsAssigned;
  final int reportsUnderReview;
  final int reportsSolved;
  final int reportsEscalated;
  final int warningsIssued;
  final double performanceScore;
  final double avgResolutionMinutes;
  final double taskCompletionRate;

  factory ModeratorDashboard.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? scope = json['scope'] as Map<String, dynamic>?;
    final List<dynamic> assignments =
        (scope?['assignments'] as List<dynamic>?) ?? const <dynamic>[];
    final Map<String, dynamic>? firstAssignment =
        assignments.isNotEmpty ? assignments.first as Map<String, dynamic> : null;

    final Map<String, dynamic>? shift = json['shift'] as Map<String, dynamic>?;
    final Map<String, dynamic>? stats = json['todayStats'] as Map<String, dynamic>?;

    return ModeratorDashboard(
      regionCode: firstAssignment?['regionCode'] as String?,
      shiftActive: json['shiftActive'] as bool? ?? false,
      shiftStartHour: shift?['startHour'] as int?,
      shiftStartMinute: shift?['startMinute'] as int?,
      shiftEndHour: shift?['endHour'] as int?,
      shiftEndMinute: shift?['endMinute'] as int?,
      nextShiftStartsInSeconds: json['nextShiftStartsInSeconds'] as int?,
      reportsAssigned: (json['assignedReportsCount'] as num?)?.toInt() ?? 0,
      reportsUnderReview: (stats?['reportsReviewed'] as num?)?.toInt() ?? 0,
      reportsSolved: (stats?['reportsResolved'] as num?)?.toInt() ?? 0,
      reportsEscalated: (stats?['reportsEscalated'] as num?)?.toInt() ?? 0,
      warningsIssued: (stats?['warningsIssued'] as num?)?.toInt() ?? 0,
      performanceScore: (stats?['performanceScore'] as num?)?.toDouble() ?? 0.0,
      avgResolutionMinutes:
          (stats?['avgResolutionMinutes'] as num?)?.toDouble() ?? 0.0,
      taskCompletionRate: (stats?['taskCompletionRate'] as num?)?.toDouble() ?? 0.0,
    );
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `flutter test test/features/moderator/moderator_remote_data_source_test.dart`
Expected: PASS.

- [ ] **Step 6: Create the remote data source**

Create `lib/features/moderator/data/moderator_remote_data_source.dart`:

```dart
import 'package:dio/dio.dart';
import 'package:soulzaa_mobile/core/constants/api_endpoints.dart';
import 'package:soulzaa_mobile/core/network/dio_client.dart';
import 'package:soulzaa_mobile/core/network/response_parser.dart';
import 'package:soulzaa_mobile/features/authentication/data/models/auth_result_model.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_authorization_profile.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_dashboard.dart';

/// Talks to the staff-portal endpoints over the moderator-scoped [DioClient]
/// (see `moderatorDioClientProvider`) — never the consumer one, so these
/// calls never carry a consumer bearer token or vice versa.
class ModeratorRemoteDataSource {
  ModeratorRemoteDataSource(this._dioClient);

  final DioClient _dioClient;

  Dio get _dio => _dioClient.dio;

  /// `POST /staff/auth/login`. Response shape is identical to a consumer
  /// login (`{user, tokens, isNewUser}`), so [AuthResultModel] is reused as-is.
  Future<AuthResultModel> staffLogin({
    required String identifier,
    required String password,
    String? deviceIdentifier,
    String? totpCode,
  }) async {
    final Response<dynamic> response = await _dio.post<dynamic>(
      ApiEndpoints.staffLogin,
      data: <String, dynamic>{
        'email': identifier,
        'password': password,
        if (deviceIdentifier != null) 'deviceIdentifier': deviceIdentifier,
        if (totpCode != null) 'totpCode': totpCode,
      },
      options: DioClient.noAuth(),
    );
    return ResponseParser.parse<AuthResultModel>(
      response,
      AuthResultModel.fromJson,
    );
  }

  /// `GET /authorization/me`, authenticated via the moderator bearer token
  /// the moderator Dio client's `AuthInterceptor` attaches automatically.
  Future<ModeratorAuthorizationProfile> getAuthorizationProfile() async {
    final Response<dynamic> response = await _dio.get<dynamic>(
      ApiEndpoints.authorizationMe,
    );
    return ResponseParser.parse<ModeratorAuthorizationProfile>(
      response,
      ModeratorAuthorizationProfile.fromJson,
    );
  }

  /// `GET /mobile/workforce/me/dashboard`.
  Future<ModeratorDashboard> getDashboard() async {
    final Response<dynamic> response = await _dio.get<dynamic>(
      '/mobile/workforce/me/dashboard',
    );
    return ResponseParser.parse<ModeratorDashboard>(
      response,
      ModeratorDashboard.fromJson,
    );
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/features/moderator/data/models/moderator_authorization_profile.dart lib/features/moderator/data/models/moderator_dashboard.dart lib/features/moderator/data/moderator_remote_data_source.dart test/features/moderator/moderator_remote_data_source_test.dart
git commit -m "feat: add moderator remote data source for staff login, role profile, and dashboard"
```

---

## Task 7: Mobile — moderator session state and login controller

**Files:**
- Create: `lib/features/moderator/presentation/providers/moderator_session_provider.dart`
- Create: `lib/features/moderator/presentation/controllers/moderator_auth_controller.dart`
- Create: `lib/features/moderator/presentation/providers/moderator_providers.dart`
- Modify: `lib/core/providers/core_providers.dart` (add `moderatorDioClientProvider`, deferred here from Task 5 — see that task's note)
- Test: `test/features/moderator/moderator_auth_controller_test.dart` (new)

**Interfaces:**
- Consumes: `ModeratorRemoteDataSource` (Task 6), `ModeratorTokenStore`/`moderatorTokenStoreProvider`/`moderatorTokenRefresherProvider` (Task 5), `ErrorMapper`/`AppFailure`/`BackendErrorCode` (Task 3/4).
- Produces: `moderatorSessionProvider: NotifierProvider<ModeratorSessionNotifier, ModeratorSessionStatus>`; `moderatorDioClientProvider: Provider<DioClient>` (completes the provider Task 5 started); `ModeratorAuthState{isLoading, needsTotp, failure, isAuthenticated}`; `moderatorAuthControllerProvider: NotifierProvider<ModeratorAuthController, ModeratorAuthState>` with `Future<void> submit({required String identifier, required String password, String? totpCode})` and `Future<void> logout()` — consumed by Task 9 (the login screen).

- [ ] **Step 1: Write the failing test**

Create `test/features/moderator/moderator_auth_controller_test.dart`. This tests the state-transition logic directly against a fake data source (no Dio, no Riverpod container needed beyond a plain `ProviderContainer`):

```dart
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/core/error/error_codes.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';
import 'package:soulzaa_mobile/features/authentication/data/models/auth_result_model.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_authorization_profile.dart';
import 'package:soulzaa_mobile/features/moderator/data/moderator_remote_data_source.dart';
import 'package:soulzaa_mobile/features/moderator/data/moderator_token_store.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/controllers/moderator_auth_controller.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_providers.dart';

Map<String, dynamic> _authResultJson({List<String> roles = const <String>['USER', 'MODERATOR']}) =>
    <String, dynamic>{
      'user': <String, dynamic>{
        'id': 'mod1',
        'username': 'mod_raviteja',
        'roles': roles,
        'isGuest': false,
        'status': 'ACTIVE',
        'createdAt': '2026-01-01T00:00:00.000Z',
      },
      'tokens': <String, dynamic>{
        'accessToken': 'acc-1',
        'refreshToken': 'ref-1',
        'tokenType': 'Bearer',
      },
      'isNewUser': false,
    };

/// Builds the same wire shape a Dio 4xx response carries, so the real
/// [ErrorMapper] pipeline runs end-to-end in these tests exactly as it will
/// in production — no separate "fake failure" bypass path to keep in sync.
DioException _errorFor(int status, {String? errorCode, String? message}) {
  final RequestOptions options = RequestOptions(path: '/staff/auth/login');
  return DioException(
    requestOptions: options,
    type: DioExceptionType.badResponse,
    response: Response<dynamic>(
      requestOptions: options,
      statusCode: status,
      data: <String, dynamic>{
        if (errorCode != null) 'errorCode': errorCode,
        if (message != null) 'message': message,
      },
    ),
  );
}

void main() {
  group('ModeratorAuthController', () {
    test('grants access when the RBAC profile confirms MODERATOR', () async {
      final _FakeModeratorRemoteDataSource fake = _FakeModeratorRemoteDataSource()
        ..loginResult = AuthResultModel.fromJson(_authResultJson())
        ..profile = const ModeratorAuthorizationProfile(
          userId: 'mod1',
          assignedRoles: <String>['MODERATOR'],
          inheritedRoles: <String>[],
        );
      final _FakeModeratorTokenStore tokenStore = _FakeModeratorTokenStore();

      final ProviderContainer container = ProviderContainer(
        overrides: <Override>[
          moderatorRemoteDataSourceProvider.overrideWithValue(fake),
          moderatorTokenStoreProvider.overrideWithValue(tokenStore),
        ],
      );
      addTearDown(container.dispose);

      await container
          .read(moderatorAuthControllerProvider.notifier)
          .submit(identifier: 'mod@example.com', password: 'Str0ng@Pass');

      final ModeratorAuthState state = container.read(moderatorAuthControllerProvider);
      expect(state.isAuthenticated, isTrue);
      expect(state.failure, isNull);
      expect(tokenStore.accessToken, 'acc-1');
      expect(tokenStore.cleared, isFalse);
    });

    test('denies access and clears the session when the role check fails', () async {
      final _FakeModeratorRemoteDataSource fake = _FakeModeratorRemoteDataSource()
        ..loginResult = AuthResultModel.fromJson(_authResultJson())
        ..profile = const ModeratorAuthorizationProfile(
          userId: 'mod1',
          assignedRoles: <String>['OFFICIAL'],
          inheritedRoles: <String>['MODERATOR'],
        );
      final _FakeModeratorTokenStore tokenStore = _FakeModeratorTokenStore();

      final ProviderContainer container = ProviderContainer(
        overrides: <Override>[
          moderatorRemoteDataSourceProvider.overrideWithValue(fake),
          moderatorTokenStoreProvider.overrideWithValue(tokenStore),
        ],
      );
      addTearDown(container.dispose);

      await container
          .read(moderatorAuthControllerProvider.notifier)
          .submit(identifier: 'official@example.com', password: 'Str0ng@Pass');

      final ModeratorAuthState state = container.read(moderatorAuthControllerProvider);
      expect(state.isAuthenticated, isFalse);
      expect(state.failure, isNotNull);
      expect(tokenStore.cleared, isTrue);
    });

    test('surfaces a 2FA prompt without treating it as access-denied', () async {
      final _FakeModeratorRemoteDataSource fake = _FakeModeratorRemoteDataSource()
        ..loginError = _errorFor(
          401,
          errorCode: BackendErrorCode.unauthorized,
          message: 'Two-factor authentication code is required',
        );

      final ProviderContainer container = ProviderContainer(
        overrides: <Override>[
          moderatorRemoteDataSourceProvider.overrideWithValue(fake),
          moderatorTokenStoreProvider.overrideWithValue(_FakeModeratorTokenStore()),
        ],
      );
      addTearDown(container.dispose);

      await container
          .read(moderatorAuthControllerProvider.notifier)
          .submit(identifier: 'mod@example.com', password: 'Str0ng@Pass');

      final ModeratorAuthState state = container.read(moderatorAuthControllerProvider);
      expect(state.isAuthenticated, isFalse);
      expect(state.needsTotp, isTrue);
    });

    test('surfaces a device-change-pending failure distinctly', () async {
      final _FakeModeratorRemoteDataSource fake = _FakeModeratorRemoteDataSource()
        ..loginError = _errorFor(
          409,
          errorCode: BackendErrorCode.deviceChangePending,
          message: "This device isn't recognized. A request has been sent for admin approval.",
        );

      final ProviderContainer container = ProviderContainer(
        overrides: <Override>[
          moderatorRemoteDataSourceProvider.overrideWithValue(fake),
          moderatorTokenStoreProvider.overrideWithValue(_FakeModeratorTokenStore()),
        ],
      );
      addTearDown(container.dispose);

      await container
          .read(moderatorAuthControllerProvider.notifier)
          .submit(identifier: 'mod@example.com', password: 'Str0ng@Pass');

      final ModeratorAuthState state = container.read(moderatorAuthControllerProvider);
      expect(state.isAuthenticated, isFalse);
      expect(state.failure?.code, BackendErrorCode.deviceChangePending);
      expect(state.needsTotp, isFalse);
    });
  });
}

/// A fake standing in for [ModeratorRemoteDataSource] — no Dio involved.
/// Implements the same three methods the controller calls.
class _FakeModeratorRemoteDataSource implements ModeratorRemoteDataSource {
  AuthResultModel? loginResult;
  DioException? loginError;
  ModeratorAuthorizationProfile? profile;

  @override
  Future<AuthResultModel> staffLogin({
    required String identifier,
    required String password,
    String? deviceIdentifier,
    String? totpCode,
  }) async {
    if (loginError != null) throw loginError!;
    return loginResult!;
  }

  @override
  Future<ModeratorAuthorizationProfile> getAuthorizationProfile() async => profile!;

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// In-memory stand-in for [ModeratorTokenStore] — avoids touching the real
/// `flutter_secure_storage` plugin (unmocked in a plain `flutter_test` unit
/// test) and makes "was the session cleared" directly assertable. `implements
/// ModeratorTokenStore` (not just `AuthTokenStore`) so it satisfies
/// `moderatorTokenStoreProvider`'s declared type for `.overrideWithValue`.
class _FakeModeratorTokenStore implements ModeratorTokenStore {
  String? accessToken;
  String? refreshToken;
  bool cleared = false;

  @override
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
    String tokenType = 'Bearer',
  }) async {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  @override
  Future<String?> readAccessToken() async => accessToken;

  @override
  Future<String?> readRefreshToken() async => refreshToken;

  @override
  Future<void> clear() async {
    cleared = true;
    accessToken = null;
    refreshToken = null;
  }

  @override
  Future<bool> hasSession() async => accessToken != null;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/features/moderator/moderator_auth_controller_test.dart` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: FAIL — none of the referenced files exist yet.

- [ ] **Step 3: Create the session provider**

Create `lib/features/moderator/presentation/providers/moderator_session_provider.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_providers.dart';

enum ModeratorSessionStatus { unknown, authenticated, unauthenticated }

/// Session status for the moderator portal, entirely separate from the
/// consumer app's `sessionProvider` — a moderator route must never be
/// affected by, or affect, the consumer auth state machine.
class ModeratorSessionNotifier extends Notifier<ModeratorSessionStatus> {
  @override
  ModeratorSessionStatus build() {
    Future<void>(_resolveInitial);
    return ModeratorSessionStatus.unknown;
  }

  Future<void> _resolveInitial() async {
    final bool hasSession = await ref.read(moderatorTokenStoreProvider).hasSession();
    if (!ref.mounted) return;
    state = hasSession
        ? ModeratorSessionStatus.authenticated
        : ModeratorSessionStatus.unauthenticated;
  }

  void authenticated() => state = ModeratorSessionStatus.authenticated;

  void unauthenticated() => state = ModeratorSessionStatus.unauthenticated;

  Future<void> expire() async {
    await ref.read(moderatorTokenStoreProvider).clear();
    if (!ref.mounted) return;
    state = ModeratorSessionStatus.unauthenticated;
  }
}

final NotifierProvider<ModeratorSessionNotifier, ModeratorSessionStatus>
moderatorSessionProvider =
    NotifierProvider<ModeratorSessionNotifier, ModeratorSessionStatus>(
      ModeratorSessionNotifier.new,
    );
```

- [ ] **Step 4: Create the shared moderator providers file**

Create `lib/features/moderator/presentation/providers/moderator_providers.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/core/providers/core_providers.dart';
import 'package:soulzaa_mobile/features/moderator/data/moderator_remote_data_source.dart';

export 'package:soulzaa_mobile/core/providers/core_providers.dart'
    show moderatorTokenStoreProvider, moderatorDioClientProvider;

final Provider<ModeratorRemoteDataSource> moderatorRemoteDataSourceProvider =
    Provider<ModeratorRemoteDataSource>(
      (Ref ref) => ModeratorRemoteDataSource(ref.watch(moderatorDioClientProvider)),
    );
```

- [ ] **Step 5: Create the auth controller**

Create `lib/features/moderator/presentation/controllers/moderator_auth_controller.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/core/error/error_codes.dart';
import 'package:soulzaa_mobile/core/error/error_mapper.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';
import 'package:soulzaa_mobile/features/authentication/data/models/auth_result_model.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_authorization_profile.dart';
import 'package:soulzaa_mobile/features/moderator/data/moderator_remote_data_source.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_providers.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_session_provider.dart';

class ModeratorAuthState {
  const ModeratorAuthState({
    this.isLoading = false,
    this.needsTotp = false,
    this.failure,
    this.isAuthenticated = false,
  });

  final bool isLoading;

  /// True when the backend rejected the attempt specifically for a missing
  /// or incorrect TOTP code — the login screen keeps (or reveals) the code
  /// field instead of showing a generic access-denied dialog.
  final bool needsTotp;
  final AppFailure? failure;
  final bool isAuthenticated;

  ModeratorAuthState copyWith({
    bool? isLoading,
    bool? needsTotp,
    AppFailure? Function()? failure,
    bool? isAuthenticated,
  }) {
    return ModeratorAuthState(
      isLoading: isLoading ?? this.isLoading,
      needsTotp: needsTotp ?? this.needsTotp,
      failure: failure != null ? failure() : this.failure,
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
    );
  }
}

class ModeratorAuthController extends Notifier<ModeratorAuthState> {
  @override
  ModeratorAuthState build() => const ModeratorAuthState();

  Future<void> submit({
    required String identifier,
    required String password,
    String? deviceIdentifier,
    String? totpCode,
  }) async {
    state = state.copyWith(
      isLoading: true,
      needsTotp: false,
      failure: () => null,
    );

    try {
      final ModeratorRemoteDataSource dataSource = ref.read(
        moderatorRemoteDataSourceProvider,
      );

      final AuthResultModel loginResult = await dataSource.staffLogin(
        identifier: identifier,
        password: password,
        deviceIdentifier: deviceIdentifier,
        totpCode: totpCode,
      );

      await ref
          .read(moderatorTokenStoreProvider)
          .saveTokens(
            accessToken: loginResult.tokens.accessToken,
            refreshToken: loginResult.tokens.refreshToken,
            tokenType: loginResult.tokens.tokenType,
          );

      final ModeratorAuthorizationProfile profile = await dataSource
          .getAuthorizationProfile();

      if (!profile.isModerator) {
        await ref.read(moderatorTokenStoreProvider).clear();
        state = state.copyWith(
          isLoading: false,
          isAuthenticated: false,
          failure: () => const ForbiddenFailure(
            message:
                'Access denied: this account is not registered as a moderator.',
            code: BackendErrorCode.forbidden,
          ),
        );
        return;
      }

      ref.read(moderatorSessionProvider.notifier).authenticated();
      state = state.copyWith(isLoading: false, isAuthenticated: true);
    } on Object catch (e, s) {
      final AppFailure failure = ErrorMapper.mapToFailure(e, s);
      state = state.copyWith(
        isLoading: false,
        needsTotp:
            failure is UnauthorizedFailure &&
            failure.code != BackendErrorCode.invalidCredentials,
        failure: () => failure,
      );
    }
  }

  Future<void> logout() async {
    await ref.read(moderatorTokenStoreProvider).clear();
    ref.read(moderatorSessionProvider.notifier).unauthenticated();
    state = const ModeratorAuthState();
  }

  void clearFailure() {
    state = state.copyWith(failure: () => null);
  }
}

final NotifierProvider<ModeratorAuthController, ModeratorAuthState>
moderatorAuthControllerProvider =
    NotifierProvider<ModeratorAuthController, ModeratorAuthState>(
      ModeratorAuthController.new,
    );
```

Note the `on Object catch (e, s)` path in `submit()` is exactly what `_errorFor(...)` exercises: `ErrorMapper.toException` receives a real `DioException` (not a bespoke test-only type), so it runs through `_fromResponse` exactly as it would against a live backend response — the 401 branch populates `AuthenticationException.errorCode` (Task 3), and `toFailure` turns that into an `UnauthorizedFailure` carrying that same code, which is what the controller then checks via `failure.code`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `flutter test test/features/moderator/moderator_auth_controller_test.dart`
Expected: PASS, all four tests.

- [ ] **Step 7: Add `moderatorDioClientProvider` to `core_providers.dart`**

Task 5 stopped short of this provider because it needs `moderatorSessionProvider`, which did not exist yet. It exists now (Step 3 above). Append to `lib/core/providers/core_providers.dart`, directly after the `moderatorTokenRefresherProvider` block Task 5 added (still before `socketManagerProvider`):

```dart
/// A second, independent Dio client for moderator-portal traffic. Reuses the
/// same [DioClient] wiring as the consumer client but points its auth +
/// refresh interceptors at [ModeratorTokenStore], so the two sessions never
/// interfere with each other on a device that has both.
final Provider<DioClient> moderatorDioClientProvider = Provider<DioClient>((
  Ref ref,
) {
  return DioClient(
    config: ref.watch(appConfigProvider),
    tokenStore: ref.watch(moderatorTokenStoreProvider),
    refresher: ref.watch(moderatorTokenRefresherProvider).refresh,
    onSessionExpired: () {
      ref.read(moderatorSessionProvider.notifier).expire();
    },
    logger: ref.watch(loggerProvider),
    performance: ref.watch(performanceServiceProvider),
  );
});
```

Add the matching import near the top of the file, alongside the existing imports:

```dart
import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_session_provider.dart';
```

- [ ] **Step 8: Verify it compiles**

Run: `flutter analyze lib/core/providers/core_providers.dart`
Expected: No issues — `moderatorSessionProvider` now resolves, and every other symbol `moderatorDioClientProvider` uses was already defined by Task 5.

- [ ] **Step 9: Run the full test suite**

Run: `flutter test`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add lib/features/moderator/presentation/providers/moderator_session_provider.dart lib/features/moderator/presentation/providers/moderator_providers.dart lib/features/moderator/presentation/controllers/moderator_auth_controller.dart lib/core/providers/core_providers.dart test/features/moderator/moderator_auth_controller_test.dart
git commit -m "feat: add moderator session state, Dio client, and login controller with role gating"
```

---

## Task 8: Mobile — routing scaffolding

**Files:**
- Modify: `lib/core/routing/route_paths.dart`
- Modify: `lib/core/routing/app_router.dart:208-218` (`_authLocations`), `:220-227` (`_redirect` entry)
- Modify: `pubspec.yaml:150-163`

**Interfaces:**
- Produces: `RoutePaths.moderatorLogin`, `.moderatorHome`, `.moderatorReports`, `.moderatorRooms`, `.moderatorTasks` and matching `RouteNames` — consumed by Task 9 and Task 10. `assets/Moderator_UI/` bundled as a Flutter asset.

- [ ] **Step 1: Add the new route paths**

In `lib/core/routing/route_paths.dart`, find:

```dart
  // Auth
  static const String login = '/login';
  static const String loginMobile = '/login/mobile';
  static const String loginEmail = '/login/email';
```

Replace with:

```dart
  // Auth
  static const String login = '/login';
  static const String loginMobile = '/login/mobile';
  static const String loginEmail = '/login/email';
  static const String moderatorLogin = '/moderator/login';
```

Find:

```dart
  // Feature roots (placeholders until their phases)
  static const String wallet = '/wallet';
```

Replace with:

```dart
  // Moderator portal — a self-contained shell reached only via moderatorLogin,
  // entirely separate from the consumer app's bottom-nav shell.
  static const String moderatorHome = '/moderator/home';
  static const String moderatorReports = '/moderator/reports';
  static const String moderatorRooms = '/moderator/rooms';
  static const String moderatorTasks = '/moderator/tasks';

  // Feature roots (placeholders until their phases)
  static const String wallet = '/wallet';
```

In the same file, find (in `RouteNames`):

```dart
  static const String login = 'login';
  static const String loginMobile = 'loginMobile';
  static const String loginEmail = 'loginEmail';
```

Replace with:

```dart
  static const String login = 'login';
  static const String loginMobile = 'loginMobile';
  static const String loginEmail = 'loginEmail';
  static const String moderatorLogin = 'moderatorLogin';
  static const String moderatorHome = 'moderatorHome';
  static const String moderatorReports = 'moderatorReports';
  static const String moderatorRooms = 'moderatorRooms';
  static const String moderatorTasks = 'moderatorTasks';
```

- [ ] **Step 2: Exempt `/moderator/*` routes from the consumer redirect**

In `lib/core/routing/app_router.dart`, find:

```dart
String? _redirect(Ref ref, GoRouterState state) {
  final AuthStatus status = ref.read(sessionProvider);
  final String location = state.matchedLocation;

  // Initial status unknown → hold on the splash.
  if (status == AuthStatus.unknown) {
```

Replace with:

```dart
String? _redirect(Ref ref, GoRouterState state) {
  final String location = state.matchedLocation;

  // The moderator portal manages its own session state entirely separately
  // from the consumer auth state machine below (a moderator account has no
  // gender/dateOfBirth set, which would otherwise trip the profile-completion
  // redirect a few lines down). Each moderator screen guards itself.
  if (location.startsWith('/moderator')) return null;

  final AuthStatus status = ref.read(sessionProvider);

  // Initial status unknown → hold on the splash.
  if (status == AuthStatus.unknown) {
```

- [ ] **Step 3: Bundle the `Moderator_UI` assets**

In `pubspec.yaml`, find:

```yaml
  assets:
    - .env.development
    - .env.qa
    - .env.staging
    - .env.production
    - assets/images/
    - assets/images/gifts/
    - assets/images/backgrounds/
    - assets/icons/
    - assets/games/
    - assets/games/GreedyFood_UI/
    - assets/games/LuckyFruit_UI/
    - assets/audio/treasure/
    - assets/audio/call/
```

Replace with:

```yaml
  assets:
    - .env.development
    - .env.qa
    - .env.staging
    - .env.production
    - assets/images/
    - assets/images/gifts/
    - assets/images/backgrounds/
    - assets/icons/
    - assets/games/
    - assets/games/GreedyFood_UI/
    - assets/games/LuckyFruit_UI/
    - assets/audio/treasure/
    - assets/audio/call/
    - assets/Moderator_UI/
```

- [ ] **Step 4: Verify the app still builds and the route table is intact**

Run: `flutter analyze lib/core/routing/route_paths.dart lib/core/routing/app_router.dart` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: No issues. The `_redirect` change only added a plain string check (`location.startsWith('/moderator')`), not a reference to the new `RoutePaths` constants, so nothing here is left half-wired — the five new `RoutePaths`/`RouteNames` constants are simply unused until Task 9/10 register routes with them, which is not a compile error.

Run: `flutter test` (whole suite)
Expected: PASS — `appRoutes` (the `@visibleForTesting` route table) is untouched by this task; only `_redirect` and the constants changed.

- [ ] **Step 5: Commit**

```bash
git add lib/core/routing/route_paths.dart lib/core/routing/app_router.dart pubspec.yaml
git commit -m "feat: add moderator route paths, exempt them from the consumer redirect, bundle Moderator_UI assets"
```

---

## Task 9: Mobile — Moderator Login screen

**Files:**
- Create: `lib/features/moderator/presentation/screens/moderator_login_screen.dart`
- Modify: `lib/features/authentication/presentation/screens/login_selection_screen.dart`
- Modify: `lib/core/routing/app_router.dart` (register the route)

**Interfaces:**
- Consumes: `moderatorAuthControllerProvider` (Task 7), `RoutePaths.moderatorLogin`/`.moderatorHome` (Task 8), `PasswordInputField`/`PrimaryLoadingButton` (existing, `lib/features/authentication/presentation/widgets/`), `DeviceInfoService.identity()` (existing), `Moderator_UI` assets (Task 8).

- [ ] **Step 1: Create the screen**

Create `lib/features/moderator/presentation/screens/moderator_login_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:soulzaa_mobile/core/error/error_codes.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';
import 'package:soulzaa_mobile/core/providers/core_providers.dart';
import 'package:soulzaa_mobile/core/routing/route_paths.dart';
import 'package:soulzaa_mobile/core/theme/app_spacing.dart';
import 'package:soulzaa_mobile/features/authentication/presentation/widgets/auth_buttons.dart';
import 'package:soulzaa_mobile/features/authentication/presentation/widgets/password_field.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/controllers/moderator_auth_controller.dart';

class ModeratorLoginScreen extends ConsumerStatefulWidget {
  const ModeratorLoginScreen({super.key});

  @override
  ConsumerState<ModeratorLoginScreen> createState() =>
      _ModeratorLoginScreenState();
}

class _ModeratorLoginScreenState extends ConsumerState<ModeratorLoginScreen> {
  final TextEditingController _identifierController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  final TextEditingController _totpController = TextEditingController();
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _identifierController.dispose();
    _passwordController.dispose();
    _totpController.dispose();
    super.dispose();
  }

  Future<void> _handleSubmit() async {
    if (!_formKey.currentState!.validate()) return;

    final String deviceIdentifier = await ref
        .read(deviceInfoServiceProvider)
        .deviceId();

    if (!mounted) return;

    await ref
        .read(moderatorAuthControllerProvider.notifier)
        .submit(
          identifier: _identifierController.text.trim(),
          password: _passwordController.text,
          deviceIdentifier: deviceIdentifier,
          totpCode: _totpController.text.trim().isEmpty
              ? null
              : _totpController.text.trim(),
        );

    if (!mounted) return;

    final ModeratorAuthState state = ref.read(moderatorAuthControllerProvider);
    if (state.isAuthenticated) {
      context.go(RoutePaths.moderatorHome);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ModeratorAuthState state = ref.watch(moderatorAuthControllerProvider);

    ref.listen<ModeratorAuthState>(moderatorAuthControllerProvider, (
      ModeratorAuthState? prev,
      ModeratorAuthState current,
    ) {
      final AppFailure? failure = current.failure;
      if (failure == null || failure == prev?.failure) return;
      if (current.needsTotp) return; // handled inline by revealing the field

      if (failure.code == BackendErrorCode.deviceChangePending) {
        showDialog<void>(
          context: context,
          builder: (BuildContext dialogContext) => AlertDialog(
            title: const Text('New device detected'),
            content: Text(failure.message),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: const Text('OK'),
              ),
            ],
          ),
        );
        return;
      }

      showDialog<void>(
        context: context,
        builder: (BuildContext dialogContext) => AlertDialog(
          title: const Text('Access denied'),
          content: Text(failure.message),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('OK'),
            ),
          ],
        ),
      );
    });

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const SizedBox(height: AppSpacing.huge),
                Image.asset('assets/Moderator_UI/image 272.png', height: 40),
                const SizedBox(height: AppSpacing.lg),
                Text(
                  'Moderator sign in',
                  style: Theme.of(
                    context,
                  ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: AppSpacing.xxl),
                TextFormField(
                  controller: _identifierController,
                  decoration: InputDecoration(
                    labelText: 'Username or email',
                    prefixIcon: Padding(
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      child: Image.asset('assets/Moderator_UI/image 444.png'),
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  validator: (String? val) => (val == null || val.trim().isEmpty)
                      ? 'Username or email is required'
                      : null,
                ),
                const SizedBox(height: AppSpacing.lg),
                PasswordInputField(
                  controller: _passwordController,
                  labelText: 'Password',
                  validator: (String? val) =>
                      (val == null || val.isEmpty) ? 'Password is required' : null,
                ),
                if (state.needsTotp) ...<Widget>[
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _totpController,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Authentication code',
                      hintText: '6-digit code from your authenticator app',
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.all(Radius.circular(12)),
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: AppSpacing.xxl),
                PrimaryLoadingButton(
                  onPressed: _handleSubmit,
                  text: 'Sign in',
                  isLoading: state.isLoading,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
```

- [ ] **Step 2: Add the entry point on `LoginSelectionScreen`**

In `lib/features/authentication/presentation/screens/login_selection_screen.dart`, find the closing of the Meta capsule button and the following spacer (the end of the auth-methods column):

```dart
                        const SizedBox(height: 16),
                        // Meta Capsule Sign In
                        CapsuleSocialButton(
                          onPressed: _handleMetaSignIn,
                          text: 'continue with meta',
                          logoSvg: _metaSvg,
                          backgroundColor: const Color(0xFFAC99CD),
                          foregroundColor: Colors.white,
                          logoBgColor: Colors.white,
                        ),
                        const SizedBox(height: 48),
```

Replace with:

```dart
                        const SizedBox(height: 16),
                        // Meta Capsule Sign In
                        CapsuleSocialButton(
                          onPressed: _handleMetaSignIn,
                          text: 'continue with meta',
                          logoSvg: _metaSvg,
                          backgroundColor: const Color(0xFFAC99CD),
                          foregroundColor: Colors.white,
                          logoBgColor: Colors.white,
                        ),
                        const SizedBox(height: 16),
                        TextButton(
                          onPressed: () => context.push(RoutePaths.moderatorLogin),
                          child: const Text(
                            'Login as moderator',
                            style: TextStyle(
                              color: Colors.black54,
                              fontSize: 13,
                              decoration: TextDecoration.underline,
                            ),
                          ),
                        ),
                        const SizedBox(height: 48),
```

- [ ] **Step 3: Register the route**

In `lib/core/routing/app_router.dart`, add the import near the other authentication-screen imports:

```dart
import 'package:soulzaa_mobile/features/moderator/presentation/screens/moderator_login_screen.dart';
```

Find:

```dart
  GoRoute(
    path: RoutePaths.loginEmail,
    name: RouteNames.loginEmail,
    pageBuilder: (BuildContext context, GoRouterState state) =>
        _page(const EmailLoginScreen(), state),
  ),
```

Replace with:

```dart
  GoRoute(
    path: RoutePaths.loginEmail,
    name: RouteNames.loginEmail,
    pageBuilder: (BuildContext context, GoRouterState state) =>
        _page(const EmailLoginScreen(), state),
  ),
  GoRoute(
    path: RoutePaths.moderatorLogin,
    name: RouteNames.moderatorLogin,
    pageBuilder: (BuildContext context, GoRouterState state) =>
        _page(const ModeratorLoginScreen(), state),
  ),
```

- [ ] **Step 4: Verify it compiles**

Run: `flutter analyze` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: No new issues. (`RoutePaths.moderatorHome` is referenced by this screen's `context.go` call but not yet registered as a route — that's fine, go_router only resolves it at navigation time, which is Task 10.)

- [ ] **Step 5: Manual verification**

Run the app (`flutter run`), open the login page, tap "Login as moderator", confirm the form renders with the `Moderator_UI` icons and matches the provided mockup. This is a visual check against the screenshot — not something a widget test can verify.

- [ ] **Step 6: Commit**

```bash
git add lib/features/moderator/presentation/screens/moderator_login_screen.dart lib/features/authentication/presentation/screens/login_selection_screen.dart lib/core/routing/app_router.dart
git commit -m "feat: add Moderator Login screen and entry point from the login page"
```

---

## Task 10: Mobile — Moderator Dashboard screen and shell

**Files:**
- Create: `lib/features/moderator/presentation/controllers/moderator_dashboard_controller.dart`
- Create: `lib/features/moderator/presentation/widgets/moderator_shell.dart`
- Create: `lib/features/moderator/presentation/screens/moderator_dashboard_screen.dart`
- Create: `lib/features/moderator/presentation/screens/moderator_placeholder_screen.dart`
- Modify: `lib/core/routing/app_router.dart` (register the shell + 4 routes)

**Interfaces:**
- Consumes: `ModeratorDashboard` (Task 6), `moderatorRemoteDataSourceProvider` (Task 7), `RoutePaths.moderatorHome/.moderatorReports/.moderatorRooms/.moderatorTasks` (Task 8).
- Produces: `moderatorDashboardProvider: FutureProvider<ModeratorDashboard>`.

- [ ] **Step 1: Create the dashboard data provider**

Create `lib/features/moderator/presentation/controllers/moderator_dashboard_controller.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_dashboard.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/providers/moderator_providers.dart';

final FutureProvider<ModeratorDashboard> moderatorDashboardProvider =
    FutureProvider<ModeratorDashboard>((Ref ref) {
      return ref.watch(moderatorRemoteDataSourceProvider).getDashboard();
    });
```

- [ ] **Step 2: Create the moderator shell**

Create `lib/features/moderator/presentation/widgets/moderator_shell.dart`, mirroring `MainShell`'s `StatefulNavigationShell` + custom bottom bar structure with the `Moderator_UI` icon assets instead of Material icons:

```dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class ModeratorShell extends StatelessWidget {
  const ModeratorShell({required this.navigationShell, super.key});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: _ModeratorNavBar(
        currentIndex: navigationShell.currentIndex,
        onTap: (int index) => navigationShell.goBranch(
          index,
          initialLocation: index == navigationShell.currentIndex,
        ),
      ),
    );
  }
}

class _ModeratorNavItem {
  const _ModeratorNavItem({required this.asset, required this.label});
  final String asset;
  final String label;
}

const List<_ModeratorNavItem> _navItems = <_ModeratorNavItem>[
  _ModeratorNavItem(asset: 'assets/Moderator_UI/image 659-1.png', label: 'Home'),
  _ModeratorNavItem(asset: 'assets/Moderator_UI/image 661.png', label: 'Reports'),
  _ModeratorNavItem(asset: 'assets/Moderator_UI/image 738.png', label: 'Rooms'),
  _ModeratorNavItem(asset: 'assets/Moderator_UI/Tasks.png', label: 'Tasks'),
];

class _ModeratorNavBar extends StatelessWidget {
  const _ModeratorNavBar({required this.currentIndex, required this.onTap});

  final int currentIndex;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SizedBox(
        height: 64,
        child: Row(
          children: List<Widget>.generate(_navItems.length, (int index) {
            final _ModeratorNavItem item = _navItems[index];
            final bool selected = index == currentIndex;
            return Expanded(
              child: InkWell(
                onTap: () => onTap(index),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: <Widget>[
                    Opacity(
                      opacity: selected ? 1.0 : 0.5,
                      child: Image.asset(item.asset, height: 22),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      item.label,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                        color: selected ? Colors.black87 : Colors.black38,
                      ),
                    ),
                  ],
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
}
```

- [ ] **Step 3: Create the placeholder screen for Reports/Rooms/Tasks**

Create `lib/features/moderator/presentation/screens/moderator_placeholder_screen.dart`:

```dart
import 'package:flutter/material.dart';

class ModeratorPlaceholderScreen extends StatelessWidget {
  const ModeratorPlaceholderScreen({required this.title, super.key});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Center(
        child: Text(
          '$title — coming soon',
          style: Theme.of(context).textTheme.bodyLarge,
        ),
      ),
    );
  }
}
```

- [ ] **Step 4: Create the dashboard screen**

Create `lib/features/moderator/presentation/screens/moderator_dashboard_screen.dart`. This maps to the mockup: shift/time-left banner, region card, the 8-tile stat grid, and the performance summary using the `Moderator_UI` stat icons identified during design research (`image 658`=region pin, `image 659-1`=reports assigned, `image 661`=solved, `image 663`=escalated, `image 668`=warnings, `image 669`=performance score, `image 670`=avg resolution time, `image 671`=task completion):

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/core/theme/app_spacing.dart';
import 'package:soulzaa_mobile/features/moderator/data/models/moderator_dashboard.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/controllers/moderator_dashboard_controller.dart';

class ModeratorDashboardScreen extends ConsumerWidget {
  const ModeratorDashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<ModeratorDashboard> dashboard = ref.watch(
      moderatorDashboardProvider,
    );

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        leading: const Icon(Icons.menu),
        actions: const <Widget>[
          Padding(
            padding: EdgeInsets.only(right: AppSpacing.lg),
            child: Icon(Icons.notifications_none),
          ),
        ],
      ),
      body: dashboard.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (Object error, StackTrace stackTrace) => Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Text('Could not load the dashboard: $error'),
          ),
        ),
        data: (ModeratorDashboard data) => RefreshIndicator(
          onRefresh: () => ref.refresh(moderatorDashboardProvider.future),
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            children: <Widget>[
              _ShiftCard(data: data),
              const SizedBox(height: AppSpacing.lg),
              _RegionCard(data: data),
              const SizedBox(height: AppSpacing.lg),
              _StatGrid(data: data),
              const SizedBox(height: AppSpacing.lg),
              _PerformanceSummary(data: data),
            ],
          ),
        ),
      ),
    );
  }
}

String _twoDigits(int? value) => (value ?? 0).toString().padLeft(2, '0');

String _formatHour(int? hour, int? minute) {
  if (hour == null) return '--:--';
  final int h12 = hour % 12 == 0 ? 12 : hour % 12;
  final String period = hour >= 12 ? 'PM' : 'AM';
  return '${_twoDigits(h12)}:${_twoDigits(minute)} $period';
}

class _ShiftCard extends StatelessWidget {
  const _ShiftCard({required this.data});
  final ModeratorDashboard data;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(
                Icons.circle,
                size: 10,
                color: data.shiftActive ? Colors.green : Colors.grey,
              ),
              const SizedBox(width: AppSpacing.xs),
              Text(
                data.shiftActive ? 'Shift active' : 'Shift inactive',
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            '${_formatHour(data.shiftStartHour, data.shiftStartMinute)} - ${_formatHour(data.shiftEndHour, data.shiftEndMinute)}',
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
          ),
        ],
      ),
    );
  }
}

class _RegionCard extends StatelessWidget {
  const _RegionCard({required this.data});
  final ModeratorDashboard data;

  @override
  Widget build(BuildContext context) {
    final String region = data.regionCode ?? 'Unassigned';
    return Row(
      children: <Widget>[
        Expanded(
          child: _InfoTile(
            asset: 'assets/Moderator_UI/image 658.png',
            label: 'Assigned region',
            value: region,
          ),
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: _InfoTile(
            asset: 'assets/Moderator_UI/image 659.png',
            label: 'Region ID',
            value: region,
          ),
        ),
      ],
    );
  }
}

class _InfoTile extends StatelessWidget {
  const _InfoTile({required this.asset, required this.label, required this.value});
  final String asset;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Image.asset(asset, height: 20),
          const SizedBox(height: AppSpacing.xs),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
          Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
          ),
        ],
      ),
    );
  }
}

class _StatGrid extends StatelessWidget {
  const _StatGrid({required this.data});
  final ModeratorDashboard data;

  @override
  Widget build(BuildContext context) {
    final List<_StatTile> tiles = <_StatTile>[
      _StatTile(
        asset: 'assets/Moderator_UI/image 659-1.png',
        label: 'Reports assigned',
        value: '${data.reportsAssigned}',
      ),
      _StatTile(
        asset: 'assets/Moderator_UI/image 659.png',
        label: 'Reports under review',
        value: '${data.reportsUnderReview}',
      ),
      _StatTile(
        asset: 'assets/Moderator_UI/image 661.png',
        label: 'Reports solved',
        value: '${data.reportsSolved}',
      ),
      _StatTile(
        asset: 'assets/Moderator_UI/image 663.png',
        label: 'Reports escalated',
        value: '${data.reportsEscalated}',
      ),
      _StatTile(
        asset: 'assets/Moderator_UI/image 668.png',
        label: 'Warnings issued',
        value: '${data.warningsIssued}',
      ),
      _StatTile(
        asset: 'assets/Moderator_UI/image 669.png',
        label: 'Performance score',
        value: '${data.performanceScore.round()}%',
      ),
      _StatTile(
        asset: 'assets/Moderator_UI/image 670.png',
        label: 'Avg resolution time',
        value: '${data.avgResolutionMinutes.round()}m',
      ),
      _StatTile(
        asset: 'assets/Moderator_UI/image 671.png',
        label: 'Task completion rate',
        value: '${data.taskCompletionRate.round()}%',
      ),
    ];

    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: AppSpacing.md,
      crossAxisSpacing: AppSpacing.md,
      childAspectRatio: 1.6,
      children: tiles,
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.asset, required this.label, required this.value});
  final String asset;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Row(
            children: <Widget>[
              Image.asset(asset, height: 18),
              const Spacer(),
              Text(
                value,
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _PerformanceSummary extends StatelessWidget {
  const _PerformanceSummary({required this.data});
  final ModeratorDashboard data;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('Performance Summary', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.md),
          Row(
            children: <Widget>[
              SizedBox(
                width: 72,
                height: 72,
                child: Stack(
                  alignment: Alignment.center,
                  children: <Widget>[
                    CircularProgressIndicator(
                      value: (data.performanceScore / 100).clamp(0.0, 1.0),
                      strokeWidth: 8,
                      backgroundColor: Theme.of(
                        context,
                      ).colorScheme.outlineVariant.withValues(alpha: 0.3),
                    ),
                    Text('${data.performanceScore.round()}%'),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.lg),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _SummaryRow(
                      asset: 'assets/Moderator_UI/image 733.png',
                      label: 'Investigation accuracy',
                    ),
                    _SummaryRow(
                      asset: 'assets/Moderator_UI/image 736-1.png',
                      label: 'Avg. resolution time',
                    ),
                    _SummaryRow(
                      asset: 'assets/Moderator_UI/image 736.png',
                      label: 'Task completion rate',
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.asset, required this.label});
  final String asset;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
      child: Row(
        children: <Widget>[
          Image.asset(asset, height: 16),
          const SizedBox(width: AppSpacing.sm),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}
```

- [ ] **Step 5: Register the moderator shell and its four branches**

In `lib/core/routing/app_router.dart`, add imports:

```dart
import 'package:soulzaa_mobile/features/moderator/presentation/widgets/moderator_shell.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/screens/moderator_dashboard_screen.dart';
import 'package:soulzaa_mobile/features/moderator/presentation/screens/moderator_placeholder_screen.dart';
```

Add a new `StatefulShellRoute.indexedStack` entry to `_routes`, as a sibling of the existing consumer one (append after its closing `),` at line 578):

```dart
  StatefulShellRoute.indexedStack(
    builder:
        (
          BuildContext context,
          GoRouterState state,
          StatefulNavigationShell navigationShell,
        ) => ModeratorShell(navigationShell: navigationShell),
    branches: <StatefulShellBranch>[
      StatefulShellBranch(
        routes: <RouteBase>[
          GoRoute(
            path: RoutePaths.moderatorHome,
            name: RouteNames.moderatorHome,
            pageBuilder: (BuildContext context, GoRouterState state) =>
                _page(const ModeratorDashboardScreen(), state),
          ),
        ],
      ),
      StatefulShellBranch(
        routes: <RouteBase>[
          GoRoute(
            path: RoutePaths.moderatorReports,
            name: RouteNames.moderatorReports,
            pageBuilder: (BuildContext context, GoRouterState state) => _page(
              const ModeratorPlaceholderScreen(title: 'Reports'),
              state,
            ),
          ),
        ],
      ),
      StatefulShellBranch(
        routes: <RouteBase>[
          GoRoute(
            path: RoutePaths.moderatorRooms,
            name: RouteNames.moderatorRooms,
            pageBuilder: (BuildContext context, GoRouterState state) =>
                _page(const ModeratorPlaceholderScreen(title: 'Rooms'), state),
          ),
        ],
      ),
      StatefulShellBranch(
        routes: <RouteBase>[
          GoRoute(
            path: RoutePaths.moderatorTasks,
            name: RouteNames.moderatorTasks,
            pageBuilder: (BuildContext context, GoRouterState state) =>
                _page(const ModeratorPlaceholderScreen(title: 'Tasks'), state),
          ),
        ],
      ),
    ],
  ),
```

- [ ] **Step 6: Verify it compiles and the route table resolves**

Run: `flutter analyze` (from `c:\Users\soulz\Downloads\soulzaa-mobile`)
Expected: No issues.

Run: `flutter test`
Expected: PASS.

- [ ] **Step 7: Manual verification**

Run the app, log in as a moderator via the flow built in Task 9 (using an account provisioned per Task 12's admin screen, with device binding and IP allowlist configured — see the plan's testing notes), and confirm the dashboard visually matches the mockup: shift banner, region card, 8-tile stat grid, performance summary, and the bottom nav switching between Home/Reports/Rooms/Tasks.

- [ ] **Step 8: Commit**

```bash
git add lib/features/moderator/presentation/controllers/moderator_dashboard_controller.dart lib/features/moderator/presentation/widgets/moderator_shell.dart lib/features/moderator/presentation/screens/moderator_dashboard_screen.dart lib/features/moderator/presentation/screens/moderator_placeholder_screen.dart lib/core/routing/app_router.dart
git commit -m "feat: add Moderator Dashboard screen, shell, and placeholder tabs"
```

---

## Task 11: Admin panel — Allowed IPs screen

**Files:**
- Modify: `packages/shared/src/api/endpoints.ts`
- Create: `packages/shared/src/modules/StaffAllowedIpsModule.tsx`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/admin/src/App.tsx`

**Interfaces:**
- Produces: `endpoints(api).superAdmin.staffAllowedIps.{list, create, remove}`; `StaffAllowedIpsScreen` component — registered as nav item `allowed-ips`.

- [ ] **Step 1: Add the API client methods**

In `packages/shared/src/api/endpoints.ts` (`c:\Users\soulz\Downloads\soulzaa-superadmins\packages\shared\src\api\endpoints.ts`), find:

```ts
      moderators: {
        list: () => api.get<any>('/admin-identity/moderators'),
        create: (body: any) => api.post<any>('/admin-identity/moderators', body),
        setStatus: (id: string, status: string) => api.patch<any>(`/admin-identity/moderators/${id}/status`, { status }),
      },
      games: {
```

Replace with:

```ts
      moderators: {
        list: () => api.get<any>('/admin-identity/moderators'),
        create: (body: any) => api.post<any>('/admin-identity/moderators', body),
        setStatus: (id: string, status: string) => api.patch<any>(`/admin-identity/moderators/${id}/status`, { status }),
      },
      staffAllowedIps: {
        list: (userId: string) => api.get<any>(`/admin/staff/${userId}/allowed-ips`),
        create: (userId: string, body: { cidr: string; label?: string }) =>
          api.post<any>(`/admin/staff/${userId}/allowed-ips`, body),
        remove: (userId: string, ipId: string) =>
          api.request<any>(`/admin/staff/${userId}/allowed-ips/${ipId}`, { method: 'DELETE' }),
      },
      games: {
```

- [ ] **Step 2: Create the screen**

Create `packages/shared/src/modules/StaffAllowedIpsModule.tsx`:

```tsx
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { DataTable, ErrorNote, Grid, Loading, Panel, Badge } from '../ui/primitives';
import { useResource } from '../ui/Shell';

const inputStyle = {
  background: 'var(--ink-sunken)',
  border: '1px solid var(--rule-strong)',
  borderRadius: 'var(--radius)',
  color: 'var(--parchment)',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--step-0)',
  fontFamily: 'var(--font-body)',
  width: '100%',
} as const;

const buttonStyle = {
  background: 'transparent',
  border: '1px solid var(--rule-strong)',
  borderRadius: 'var(--radius)',
  padding: 'var(--space-2) var(--space-4)',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 'var(--step-0)',
  fontFamily: 'var(--font-display)',
} as const;

const labelStyle = {
  fontSize: 'var(--step--1)',
  color: 'var(--muted)',
  display: 'block',
  marginBottom: 'var(--space-1)',
} as const;

interface StaffAllowedIpRow {
  id: string;
  userId: string;
  cidr: string;
  label: string | null;
  addedBy: string;
  addedAt: string;
  isActive: boolean;
}

/**
 * StaffAllowedIpsScreen
 *
 * A moderator (or any staff) account is rejected at login by default until at
 * least one approved IP/CIDR is on file for it — `StaffIpAllowlistService`
 * denies when zero entries exist. This screen is the only UI for managing
 * that list; without it, a provisioned moderator can never sign in.
 */
export function StaffAllowedIpsScreen() {
  const { endpoints } = useAuth();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [lookupUserId, setLookupUserId] = useState('');
  const [activeUserId, setActiveUserId] = useState('');
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const ips = useResource(
    () => (activeUserId ? endpoints.superAdmin.staffAllowedIps.list(activeUserId) : Promise.resolve([])),
    [activeUserId],
  );

  function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    setActiveUserId(lookupUserId.trim());
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!activeUserId || !cidr.trim()) {
      setNotice({ kind: 'error', text: 'A moderator user ID and a CIDR are both required.' });
      return;
    }

    setIsSubmitting(true);
    setNotice(null);
    try {
      await endpoints.superAdmin.staffAllowedIps.create(activeUserId, {
        cidr: cidr.trim(),
        label: label.trim() || undefined,
      });
      setNotice({ kind: 'ok', text: `Approved IP ${cidr.trim()} added.` });
      setCidr('');
      setLabel('');
      ips.reload();
    } catch (err: any) {
      setNotice({
        kind: 'error',
        text: err?.message || 'Could not add the IP. Check the details and try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRemove(ipId: string) {
    if (!window.confirm('Remove this approved IP?')) return;
    setBusyId(ipId);
    setNotice(null);
    try {
      await endpoints.superAdmin.staffAllowedIps.remove(activeUserId, ipId);
      setNotice({ kind: 'ok', text: 'IP removed.' });
      ips.reload();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Removal failed.' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Grid>
      {notice && (
        <div style={{ gridColumn: 'span 12' }}>
          <Badge flow={notice.kind === 'ok' ? 'inflow' : 'signal'}>{notice.text}</Badge>
        </div>
      )}

      <Panel
        span={12}
        title="Look up a moderator"
        subtitle="Enter the account's user ID (from the Moderators screen) to manage its approved IPs."
      >
        <form onSubmit={handleLookup} style={{ display: 'flex', gap: 'var(--space-3)', maxWidth: 500 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>User ID</label>
            <input
              value={lookupUserId}
              onChange={(e) => setLookupUserId(e.target.value)}
              placeholder="uuid"
              style={inputStyle}
              autoComplete="off"
            />
          </div>
          <button type="submit" style={{ ...buttonStyle, alignSelf: 'flex-end' }}>
            Load
          </button>
        </form>
      </Panel>

      {activeUserId && (
        <>
          <Panel span={12} title={`Approved IPs for ${activeUserId}`}>
            {ips.error && <ErrorNote message={ips.error} onRetry={ips.reload} />}
            {!ips.error && !ips.data && <Loading />}
            {ips.data && (
              <DataTable
                rows={ips.data as StaffAllowedIpRow[]}
                rowKey={(row: StaffAllowedIpRow) => row.id}
                empty="No approved IPs yet — this account cannot log in until one is added."
                columns={[
                  { header: 'CIDR', render: (row: StaffAllowedIpRow) => <strong>{row.cidr}</strong> },
                  {
                    header: 'Label',
                    render: (row: StaffAllowedIpRow) => row.label ?? '—',
                  },
                  {
                    header: 'Added',
                    render: (row: StaffAllowedIpRow) => new Date(row.addedAt).toLocaleString(),
                  },
                  {
                    header: 'Actions',
                    render: (row: StaffAllowedIpRow) => (
                      <button
                        disabled={busyId === row.id}
                        onClick={() => handleRemove(row.id)}
                        style={{
                          ...buttonStyle,
                          padding: '2px 8px',
                          fontSize: 'var(--step--1)',
                          borderColor: 'var(--signal)',
                          color: 'var(--signal)',
                        }}
                      >
                        Remove
                      </button>
                    ),
                  },
                ]}
              />
            )}
          </Panel>

          <Panel span={12} title="Add an approved IP">
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 500 }}>
              <div>
                <label style={labelStyle}>CIDR</label>
                <input
                  value={cidr}
                  onChange={(e) => setCidr(e.target.value)}
                  placeholder="e.g. 192.168.1.50/32"
                  style={inputStyle}
                  autoComplete="off"
                />
              </div>
              <div>
                <label style={labelStyle}>Label (optional)</label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Office Primary IP"
                  style={inputStyle}
                  autoComplete="off"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  ...buttonStyle,
                  background: isSubmitting ? 'var(--rule-strong)' : 'var(--inflow)',
                  color: isSubmitting ? 'var(--faint)' : 'var(--ink)',
                  border: 'none',
                  fontWeight: 600,
                  padding: 'var(--space-3) var(--space-5)',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  width: 'fit-content',
                }}
              >
                {isSubmitting ? 'Adding…' : 'Add IP'}
              </button>
            </form>
          </Panel>
        </>
      )}
    </Grid>
  );
}
```

- [ ] **Step 3: Export it**

In `packages/shared/src/index.ts`, find:

```ts
export * from './modules/ModeratorManagementModule';
```

Replace with:

```ts
export * from './modules/ModeratorManagementModule';
export * from './modules/StaffAllowedIpsModule';
```

- [ ] **Step 4: Register the nav item and route in the admin app**

In `apps/admin/src/App.tsx`, add `StaffAllowedIpsScreen` to the import list from `@soulzaa/shared` (alphabetically, after `RoleApprovalScreen`, before `Shell`):

```tsx
  RoleApprovalScreen,
  Shell,
  StaffAllowedIpsScreen,
  TreasuryScreen,
```

Find the `'Governance'` group:

```tsx
  {
    label: 'Governance',
    items: [
      { id: 'moderation', label: 'Moderation', permission: 'dashboard.moderation.view' },
      { id: 'logs', label: 'Operational logs', permission: 'dashboard.moderation.view' },
      { id: 'approvals', label: 'Role approvals', permission: 'role_request.review' },
      { id: 'location', label: 'User territory', permission: 'user.location.view' },
      { id: 'moderators', label: 'Moderators', permission: 'admin.identity.manage' },
    ],
  },
```

Replace with:

```tsx
  {
    label: 'Governance',
    items: [
      { id: 'moderation', label: 'Moderation', permission: 'dashboard.moderation.view' },
      { id: 'logs', label: 'Operational logs', permission: 'dashboard.moderation.view' },
      { id: 'approvals', label: 'Role approvals', permission: 'role_request.review' },
      { id: 'location', label: 'User territory', permission: 'user.location.view' },
      { id: 'moderators', label: 'Moderators', permission: 'admin.identity.manage' },
      { id: 'allowed-ips', label: 'Allowed IPs', permission: 'admin.identity.manage' },
    ],
  },
```

Find:

```tsx
      {current === 'moderators' && <ModeratorManagementScreen />}
    </Shell>
```

Replace with:

```tsx
      {current === 'moderators' && <ModeratorManagementScreen />}
      {current === 'allowed-ips' && <StaffAllowedIpsScreen />}
    </Shell>
```

- [ ] **Step 5: Verify it builds**

Run: `npm run build --workspace=apps/admin` (from `c:\Users\soulz\Downloads\soulzaa-superadmins`) — adjust to this repo's actual build script name if different (check `package.json` first with `cat package.json` if the workspace name above doesn't match).
Expected: builds with no TypeScript errors.

- [ ] **Step 6: Manual verification**

Run the admin app, log in as an Admin/Super Admin, open Governance → Allowed IPs, look up a moderator's user ID (from the Moderators screen), add a CIDR, confirm it appears in the list, remove it, confirm it disappears.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/api/endpoints.ts packages/shared/src/modules/StaffAllowedIpsModule.tsx packages/shared/src/index.ts apps/admin/src/App.tsx
git commit -m "feat: add Allowed IPs admin screen so provisioned moderators can actually log in"
```

---

## Task 12: Admin panel — Device Change Requests screen

**Files:**
- Modify: `packages/shared/src/api/endpoints.ts`
- Create: `packages/shared/src/modules/DeviceChangeRequestsModule.tsx`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/admin/src/App.tsx`

**Interfaces:**
- Produces: `endpoints(api).superAdmin.moderatorDevice.{pending, managerReview, approve, reject}`; `DeviceChangeRequestsScreen` component — registered as nav item `device-change`.

- [ ] **Step 1: Add the API client methods**

In `packages/shared/src/api/endpoints.ts`, find (the block Task 11 just added):

```ts
      staffAllowedIps: {
        list: (userId: string) => api.get<any>(`/admin/staff/${userId}/allowed-ips`),
        create: (userId: string, body: { cidr: string; label?: string }) =>
          api.post<any>(`/admin/staff/${userId}/allowed-ips`, body),
        remove: (userId: string, ipId: string) =>
          api.request<any>(`/admin/staff/${userId}/allowed-ips/${ipId}`, { method: 'DELETE' }),
      },
      games: {
```

Replace with:

```ts
      staffAllowedIps: {
        list: (userId: string) => api.get<any>(`/admin/staff/${userId}/allowed-ips`),
        create: (userId: string, body: { cidr: string; label?: string }) =>
          api.post<any>(`/admin/staff/${userId}/allowed-ips`, body),
        remove: (userId: string, ipId: string) =>
          api.request<any>(`/admin/staff/${userId}/allowed-ips/${ipId}`, { method: 'DELETE' }),
      },
      moderatorDevice: {
        pending: () => api.get<any>('/moderator/device-change/pending'),
        managerReview: (id: string, reviewNote?: string) =>
          api.put<any>(`/moderator/device-change/${id}/manager-review`, { reviewNote }),
        approve: (id: string, reviewNote?: string) =>
          api.put<any>(`/moderator/device-change/${id}/approve`, { reviewNote }),
        reject: (id: string, reviewNote?: string) =>
          api.put<any>(`/moderator/device-change/${id}/reject`, { reviewNote }),
      },
      games: {
```

- [ ] **Step 2: Create the screen**

Create `packages/shared/src/modules/DeviceChangeRequestsModule.tsx`:

```tsx
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { DataTable, ErrorNote, Grid, Loading, Panel, Badge } from '../ui/primitives';
import { useResource } from '../ui/Shell';

const buttonStyle = {
  background: 'transparent',
  border: '1px solid var(--rule-strong)',
  borderRadius: 'var(--radius)',
  padding: '2px 8px',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 'var(--step--1)',
  fontFamily: 'var(--font-display)',
} as const;

type DeviceChangeRequestStatus = 'PENDING' | 'MANAGER_REVIEWED' | 'APPROVED' | 'REJECTED';

interface DeviceChangeRequestRow {
  id: string;
  moderatorId: string;
  oldDeviceId: string | null;
  newDeviceInfo: Record<string, unknown>;
  reason: string | null;
  status: DeviceChangeRequestStatus;
  createdAt: string;
}

/**
 * DeviceChangeRequestsScreen
 *
 * Moderators are restricted to one bound device. Logging in from a new one is
 * rejected automatically and files a PENDING row here — the moderator stays
 * locked out until a Manager reviews it and an Admin approves it (two-tier by
 * design; `moderator.device.approve` is Admin-exclusive, `can()` below gates
 * the Approve button accordingly while Review/Reject stay open to anyone who
 * can see this screen at all).
 */
export function DeviceChangeRequestsScreen() {
  const { endpoints, can } = useAuth();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const requests = useResource(() => endpoints.superAdmin.moderatorDevice.pending());
  const canApprove = can('moderator.device.approve');

  async function act(
    id: string,
    action: (id: string, reviewNote?: string) => Promise<unknown>,
    successText: string,
  ) {
    setBusyId(id);
    setNotice(null);
    try {
      await action(id);
      setNotice({ kind: 'ok', text: successText });
      requests.reload();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Action failed.' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Grid>
      {notice && (
        <div style={{ gridColumn: 'span 12' }}>
          <Badge flow={notice.kind === 'ok' ? 'inflow' : 'signal'}>{notice.text}</Badge>
        </div>
      )}

      <Panel
        span={12}
        title="Pending device-change requests"
        subtitle="Filed automatically when a moderator's login is rejected from an unrecognized device."
      >
        {requests.error && <ErrorNote message={requests.error} onRetry={requests.reload} />}
        {!requests.error && !requests.data && <Loading />}
        {requests.data && (
          <DataTable
            rows={requests.data as DeviceChangeRequestRow[]}
            rowKey={(row: DeviceChangeRequestRow) => row.id}
            empty="No pending device-change requests."
            columns={[
              {
                header: 'Moderator ID',
                render: (row: DeviceChangeRequestRow) => (
                  <span style={{ fontFamily: 'monospace', fontSize: 'var(--step--1)' }}>
                    {row.moderatorId.slice(0, 12).toUpperCase()}…
                  </span>
                ),
              },
              { header: 'Status', render: (row: DeviceChangeRequestRow) => <Badge>{row.status}</Badge> },
              {
                header: 'Requested',
                render: (row: DeviceChangeRequestRow) => new Date(row.createdAt).toLocaleString(),
              },
              { header: 'Reason', render: (row: DeviceChangeRequestRow) => row.reason ?? '—' },
              {
                header: 'Actions',
                render: (row: DeviceChangeRequestRow) => (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {row.status === 'PENDING' && (
                      <button
                        disabled={busyId === row.id}
                        onClick={() =>
                          act(
                            row.id,
                            endpoints.superAdmin.moderatorDevice.managerReview,
                            'Marked as manager-reviewed.',
                          )
                        }
                        style={buttonStyle}
                      >
                        Review
                      </button>
                    )}
                    {row.status === 'MANAGER_REVIEWED' && canApprove && (
                      <button
                        disabled={busyId === row.id}
                        onClick={() =>
                          act(row.id, endpoints.superAdmin.moderatorDevice.approve, 'Approved.')
                        }
                        style={{ ...buttonStyle, borderColor: 'var(--inflow)', color: 'var(--inflow)' }}
                      >
                        Approve
                      </button>
                    )}
                    <button
                      disabled={busyId === row.id}
                      onClick={() =>
                        act(row.id, endpoints.superAdmin.moderatorDevice.reject, 'Rejected.')
                      }
                      style={{ ...buttonStyle, borderColor: 'var(--signal)', color: 'var(--signal)' }}
                    >
                      Reject
                    </button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Panel>
    </Grid>
  );
}
```

- [ ] **Step 3: Export it**

In `packages/shared/src/index.ts`, find:

```ts
export * from './modules/ModeratorManagementModule';
export * from './modules/StaffAllowedIpsModule';
```

Replace with:

```ts
export * from './modules/ModeratorManagementModule';
export * from './modules/StaffAllowedIpsModule';
export * from './modules/DeviceChangeRequestsModule';
```

- [ ] **Step 4: Register the nav item and route**

In `apps/admin/src/App.tsx`, add `DeviceChangeRequestsScreen` to the import list (alphabetically, after `Badge`-adjacent imports aren't a thing here — insert after `useState` import stays as-is; add to the `@soulzaa/shared` import list before `FinancialOverviewScreen`):

```tsx
import {
  DeviceChangeRequestsScreen,
  FinancialOverviewScreen,
  LoginScreen,
```

Find the `'Governance'` group (as left by Task 11):

```tsx
      { id: 'moderators', label: 'Moderators', permission: 'admin.identity.manage' },
      { id: 'allowed-ips', label: 'Allowed IPs', permission: 'admin.identity.manage' },
    ],
  },
```

Replace with:

```tsx
      { id: 'moderators', label: 'Moderators', permission: 'admin.identity.manage' },
      { id: 'allowed-ips', label: 'Allowed IPs', permission: 'admin.identity.manage' },
      { id: 'device-change', label: 'Device Change Requests', permission: 'moderator.device.review' },
    ],
  },
```

Find:

```tsx
      {current === 'allowed-ips' && <StaffAllowedIpsScreen />}
    </Shell>
```

Replace with:

```tsx
      {current === 'allowed-ips' && <StaffAllowedIpsScreen />}
      {current === 'device-change' && <DeviceChangeRequestsScreen />}
    </Shell>
```

- [ ] **Step 5: Verify it builds**

Run: `npm run build --workspace=apps/admin` (from `c:\Users\soulz\Downloads\soulzaa-superadmins`, or the equivalent script confirmed in Task 11 Step 5)
Expected: builds with no TypeScript errors.

- [ ] **Step 6: Manual verification**

Trigger a device-change request end to end: attempt a moderator login (Task 9's screen) from a device not yet bound to that account, confirm the mobile app shows "Device change request submitted" rather than a generic access-denied dialog, then in the admin app open Governance → Device Change Requests, confirm the request appears with status `PENDING`, click Review (status becomes `MANAGER_REVIEWED`), click Approve (status becomes `APPROVED`), then retry the moderator login on that same device and confirm it now succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/api/endpoints.ts packages/shared/src/modules/DeviceChangeRequestsModule.tsx packages/shared/src/index.ts apps/admin/src/App.tsx
git commit -m "feat: add Device Change Requests admin screen to review and approve unbound-device logins"
```

---

## Post-plan manual step (not a task — the user's own action)

Provision the test account via the existing "Provision Moderator" screen (`apps/admin` → Governance → Moderators → Provision Moderator), using `bellamkondaraviteju@gmail.com` and a password of your choosing. Then, before that account can log in from a phone for the first time:

1. Governance → Allowed IPs (Task 11): look up its user ID, add the phone's IP/CIDR.
2. Attempt login from the phone (Task 9's screen) — since it is the account's first device, it binds automatically on success (no device-change request needed for a *first* login; the request-filing path in Task 2 only triggers when a device is already bound and a *different* one logs in).
