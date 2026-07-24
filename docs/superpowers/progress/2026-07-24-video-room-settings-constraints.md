# VR-17 Global Constraints (bind every task)

- **NO GIT of any kind**, including read-only (`git diff`/`status`/`log`). All work stays in
  the working tree; the owner commits manually. Evidence of git use is a finding.
- **No Prisma migration.** No file under `prisma/schema/` may change.
- **No change to `VideoRoomPermission` or `VIDEO_ROOM_PERMISSION_MATRIX`.** `MANAGE_MEDIA` must
  NOT be created — media flags reuse the existing `MANAGE_PARTICIPANTS` ({OWNER, ADMIN}).
- **No changes outside the Video Room Settings scope.** No cross-module edits. Audio Rooms must
  not be touched (reading its two `@Public()` reference routes from mobile is permitted reuse).
- `BusinessException`'s field is **`.errorCode`**, never `.code`.
- **No placeholder controls.** Every shipped setting must be enforced server-side. This phase
  exists because an audit found 13 of 21 `video_room_settings` columns were write-only —
  stored but read by no code. A toggle for such a column flips, syncs to every participant,
  and changes nothing.
- **Enforcement guards take no owner/admin bypass.** These flags express room policy; whoever
  can flip the flag can turn it back on. A role check inside a guard is a defect.
- **Guards run AFTER the permission assertion**, so permission errors take precedence over
  policy errors.
- **Test-harness honesty:** a newly added `getSettings` stub must default to the ENABLED value,
  so pre-existing tests keep exercising the real path rather than passing for the wrong reason.
- Backend gates: `npx tsc --noEmit` 0 errors; `npx eslint src/modules/video-rooms --max-warnings 0`;
  focused jest green.
- Mobile gates: `flutter analyze` 0 issues; `flutter test` green.

## Known non-findings (established by the controller — do NOT attribute to any task)

Pre-existing failing suites, unrelated to VR-17 and not to be fixed:
  - src/modules/video-rooms/services/video-room-lifecycle.service.spec.ts
  - src/modules/wallet/repositories/wallet.repository.spec.ts
  - src/modules/wallet/services/wallet-ledger.spec.ts
  - src/modules/wallet/services/wallet.service.spec.ts

Backend baseline before VR-17: 4 failed suites, 361 passed, 365 total / 9 failed, 4116 passed, 4125 tests.
