# Consumer Report User UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give any non-self member of an audio room or video room a working "Report user" action — audio rooms have none today, video rooms have a dead `// TODO: Open report dialog` stub — reusing the app's existing report-reason sheet UI instead of building a new one.

**Architecture:** Generalize the existing chat-message report sheet (`report_message_sheet.dart`) into a small, reason-type-generic shared widget (`report_reason_sheet.dart`), then add two thin wrappers over it — one per room type — each backed by the already-built, unchanged backend endpoints (`POST rooms/:id/moderation/report`, `POST video-rooms/:id/report`). Both wrappers are wired into the profile-tap overlay each room type already opens (`UserProfileCardOverlay` for audio, `host_public_profile_sheet.dart` for video) — no new entry point, no new sheet mechanism.

**Tech Stack:** Flutter + Riverpod (`soulzaa-mobile`), flutter_test.

**Spec:** `docs/superpowers/specs/2026-08-19-moderator-report-actions-and-consumer-reporting-design.md`, section 9. This plan is independent of `2026-08-19-moderator-report-actions.md` (the backend/moderator-portal plan) — neither depends on the other, and either can be built and shipped alone.

## Global Constraints

- No live-stream consumer report UI — there is no live-stream viewer screen in this app yet; that is a separate, larger feature.
- Do not build a new bottom-sheet mechanism — reuse the existing reason-picker sheet (generalized in Task 1), and reuse the existing profile-tap overlays as the entry point (no new "how do I report someone" UI flow).
- Both backend endpoints this plan calls already exist and already require a reason — no backend changes anywhere in this plan.
- Reporting is open to any non-self member, not gated on a moderation permission (the backend endpoints are already `@NotGuest()`-only, open to any active member including audience/viewer).

---

## Task 1: Generalize the report-reason sheet into a shared widget

**Files:**
- Create: `soulzaa-mobile/lib/core/widgets/report_reason_sheet.dart`
- Modify: `soulzaa-mobile/lib/features/audio_room/chat/presentation/widgets/report_message_sheet.dart`
- Test: `soulzaa-mobile/test/core/widgets/report_reason_sheet_test.dart`

**Interfaces:**
- Produces: `Future<void> showReportReasonSheet<T>(BuildContext context, {required String title, required List<T> reasons, required String Function(T reason) label, required Future<AppFailure?> Function(WidgetRef ref, T reason, String? description) onSubmit, String descriptionHint, String submitLabel, String successMessage})` — Tasks 2 and 3 build on this.
- Consumes: `AppFailure` (`soulzaa-mobile/lib/core/error/failure.dart`, existing).

`showReportMessageSheet(context, {required roomId, required messageId})`'s public signature and behavior are unchanged — this task only changes what's inside it.

- [ ] **Step 1: Write the failing test**

Create `soulzaa-mobile/test/core/widgets/report_reason_sheet_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';
import 'package:soulzaa_mobile/core/widgets/report_reason_sheet.dart';

enum _TestReason { spam, other }

void main() {
  testWidgets('renders reasons as chips, submits the selected reason and description, then closes with a success snackbar', (
    WidgetTester tester,
  ) async {
    _TestReason? submittedReason;
    String? submittedDescription;

    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (BuildContext context) => ElevatedButton(
                onPressed: () => showReportReasonSheet<_TestReason>(
                  context,
                  title: 'Report this',
                  reasons: _TestReason.values,
                  label: (_TestReason r) => r.name,
                  successMessage: 'Reported!',
                  onSubmit: (WidgetRef ref, _TestReason reason, String? description) async {
                    submittedReason = reason;
                    submittedDescription = description;
                    return null;
                  },
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    expect(find.text('Report this'), findsOneWidget);
    expect(find.text('spam'), findsOneWidget);
    expect(find.text('other'), findsOneWidget);

    await tester.tap(find.text('other'));
    await tester.enterText(find.byType(TextField), 'extra detail');
    await tester.tap(find.text('Submit report'));
    await tester.pumpAndSettle();

    expect(submittedReason, _TestReason.other);
    expect(submittedDescription, 'extra detail');
    expect(find.text('Reported!'), findsOneWidget);
    expect(find.text('Report this'), findsNothing); // sheet closed
  });

  testWidgets('shows the failure message instead of the success message when onSubmit returns a failure', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (BuildContext context) => ElevatedButton(
                onPressed: () => showReportReasonSheet<_TestReason>(
                  context,
                  title: 'Report this',
                  reasons: _TestReason.values,
                  label: (_TestReason r) => r.name,
                  successMessage: 'Reported!',
                  onSubmit: (WidgetRef ref, _TestReason reason, String? description) async =>
                      const ConflictFailure(message: 'Already reported.'),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Submit report'));
    await tester.pumpAndSettle();

    expect(find.text('Already reported.'), findsOneWidget);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/core/widgets/report_reason_sheet_test.dart`
Expected: FAIL — `Target of URI doesn't exist: 'package:soulzaa_mobile/core/widgets/report_reason_sheet.dart'`.

- [ ] **Step 3: Implement the shared widget**

Create `soulzaa-mobile/lib/core/widgets/report_reason_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';
import 'package:soulzaa_mobile/core/theme/app_spacing.dart';

/// Generic "pick a reason, optionally add detail, submit" bottom sheet shared
/// by every report flow in the app — a chat message, a user in a room. Only
/// the reason type, its labels, and the submit callback differ per caller;
/// the sheet itself is not duplicated per flow.
Future<void> showReportReasonSheet<T>(
  BuildContext context, {
  required String title,
  required List<T> reasons,
  required String Function(T reason) label,
  required Future<AppFailure?> Function(WidgetRef ref, T reason, String? description) onSubmit,
  String descriptionHint = 'Add any extra detail (optional)',
  String submitLabel = 'Submit report',
  String successMessage = 'Report submitted.',
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (BuildContext sheetContext) => _ReportReasonSheet<T>(
      title: title,
      reasons: reasons,
      label: label,
      onSubmit: onSubmit,
      descriptionHint: descriptionHint,
      submitLabel: submitLabel,
      successMessage: successMessage,
    ),
  );
}

class _ReportReasonSheet<T> extends ConsumerStatefulWidget {
  const _ReportReasonSheet({
    required this.title,
    required this.reasons,
    required this.label,
    required this.onSubmit,
    required this.descriptionHint,
    required this.submitLabel,
    required this.successMessage,
  });

  final String title;
  final List<T> reasons;
  final String Function(T reason) label;
  final Future<AppFailure?> Function(WidgetRef ref, T reason, String? description) onSubmit;
  final String descriptionHint;
  final String submitLabel;
  final String successMessage;

  @override
  ConsumerState<_ReportReasonSheet<T>> createState() => _ReportReasonSheetState<T>();
}

class _ReportReasonSheetState<T> extends ConsumerState<_ReportReasonSheet<T>> {
  late T _reason = widget.reasons.first;
  final TextEditingController _description = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _submitting = true);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final AppFailure? failure = await widget.onSubmit(
      ref,
      _reason,
      _description.text.trim().isEmpty ? null : _description.text.trim(),
    );
    if (!mounted) return;
    Navigator.of(context).pop();
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(failure?.message ?? widget.successMessage)));
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        0,
        AppSpacing.lg,
        AppSpacing.lg,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(widget.title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.xs,
            children: widget.reasons
                .map(
                  (T r) => ChoiceChip(
                    label: Text(widget.label(r)),
                    selected: _reason == r,
                    onSelected: (_) => setState(() => _reason = r),
                  ),
                )
                .toList(growable: false),
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _description,
            maxLength: 500,
            maxLines: 3,
            minLines: 1,
            decoration: InputDecoration(
              hintText: widget.descriptionHint,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: _submitting ? null : _submit,
              child: Text(widget.submitLabel),
            ),
          ),
        ],
      ),
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `flutter test test/core/widgets/report_reason_sheet_test.dart`
Expected: PASS — both tests.

- [ ] **Step 5: Refactor `report_message_sheet.dart` to use the shared widget**

Replace the full contents of `soulzaa-mobile/lib/features/audio_room/chat/presentation/widgets/report_message_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/core/extensions/context_extensions.dart';
import 'package:soulzaa_mobile/core/widgets/report_reason_sheet.dart';
import 'package:soulzaa_mobile/features/audio_room/chat/domain/entities/chat_report_reason.dart';
import 'package:soulzaa_mobile/features/audio_room/chat/presentation/providers/chat_providers.dart';

/// Lets a member report a chat message (`POST /chat/messages/:id/report`) with a
/// reason and optional details. Moderator review is a separate phase.
///
/// Thin wrapper over the shared [showReportReasonSheet] — see
/// `report_user_sheet.dart` (audio-room moderation feature) for the sibling
/// "report a user" wrapper over the same sheet.
Future<void> showReportMessageSheet(
  BuildContext context, {
  required String roomId,
  required String messageId,
}) {
  return showReportReasonSheet<ChatReportReason>(
    context,
    title: context.l10n.chatReportTitle,
    reasons: ChatReportReason.values,
    label: (ChatReportReason r) => _label(context, r),
    descriptionHint: context.l10n.chatReportDescriptionHint,
    submitLabel: context.l10n.chatReportSubmit,
    successMessage: context.l10n.chatReportSubmitted,
    onSubmit: (WidgetRef ref, ChatReportReason reason, String? description) => ref
        .read(reportMessageUseCaseProvider)
        .call(roomId, messageId, reason: reason, description: description)
        .then((result) => result.failureOrNull),
  );
}

String _label(BuildContext context, ChatReportReason r) {
  switch (r) {
    case ChatReportReason.abuse:
      return context.l10n.chatReportReasonAbuse;
    case ChatReportReason.harassment:
      return context.l10n.chatReportReasonHarassment;
    case ChatReportReason.spam:
      return context.l10n.chatReportReasonSpam;
    case ChatReportReason.fraud:
      return context.l10n.chatReportReasonFraud;
    case ChatReportReason.fakeProfile:
      return context.l10n.chatReportReasonFakeProfile;
    case ChatReportReason.copyright:
      return context.l10n.chatReportReasonCopyright;
    case ChatReportReason.adultContent:
      return context.l10n.chatReportReasonAdultContent;
    case ChatReportReason.other:
      return context.l10n.chatReportReasonOther;
  }
}
```

- [ ] **Step 6: Verify the existing message-report call site still compiles and its own tests (if any) still pass**

Run: `flutter analyze lib/features/audio_room/chat/`
Expected: clean.

Run: `flutter test test/ -t "report"` (or, if that filter matches nothing because no existing test names contain "report", just re-run the full suite for the chat feature: `flutter test test/features/audio_room/chat/`)
Expected: PASS, no regressions — `showReportMessageSheet`'s public signature is unchanged, so `message_bubble.dart` (its only caller) needs no changes.

- [ ] **Step 7: Commit**

```bash
git add lib/core/widgets/report_reason_sheet.dart lib/features/audio_room/chat/presentation/widgets/report_message_sheet.dart test/core/widgets/report_reason_sheet_test.dart
git commit -m "refactor(reporting): extract shared report-reason sheet from the message-report flow"
```

---

## Task 2: Audio room — "Report user" in the profile overlay

**Files:**
- Create: `soulzaa-mobile/lib/features/audio_room/moderation/domain/entities/report_user_reason.dart`
- Modify: `soulzaa-mobile/lib/features/audio_room/moderation/domain/repositories/moderation_repository.dart`
- Modify: `soulzaa-mobile/lib/features/audio_room/moderation/data/repositories/moderation_repository_impl.dart`
- Modify: `soulzaa-mobile/lib/features/audio_room/moderation/data/datasources/moderation_remote_data_source.dart`
- Modify: `soulzaa-mobile/lib/features/audio_room/moderation/domain/usecases/moderation_usecases.dart`
- Modify: `soulzaa-mobile/lib/features/audio_room/moderation/presentation/providers/moderation_providers.dart`
- Create: `soulzaa-mobile/lib/features/audio_room/moderation/presentation/widgets/report_user_sheet.dart`
- Modify: `soulzaa-mobile/lib/core/constants/api_endpoints.dart`
- Modify: `soulzaa-mobile/lib/features/audio_room/in_room/presentation/widgets/seat_profile_card_overlay.dart`
- Test: `soulzaa-mobile/test/features/audio_room/moderation/report_user_reason_test.dart`

**Interfaces:**
- Consumes: `showReportReasonSheet<T>` (Task 1).
- Produces: `showReportUserSheet(BuildContext context, {required String roomId, required String targetUserId}) → Future<void>` — called from `seat_profile_card_overlay.dart`'s action row.

Backend contract this calls: `POST rooms/:id/moderation/report` with body `{targetUserId, reason, description?}` — `ReportDto` in `src/modules/audio-rooms/dto/moderation.dto.ts`, already built, no backend changes.

- [ ] **Step 1: Write the failing test for the reason enum**

Create `soulzaa-mobile/test/features/audio_room/moderation/report_user_reason_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/audio_room/moderation/domain/entities/report_user_reason.dart';

void main() {
  test('every value maps to the exact backend ReportReason enum string', () {
    expect(ReportUserReason.abuse.api, 'ABUSE');
    expect(ReportUserReason.harassment.api, 'HARASSMENT');
    expect(ReportUserReason.spam.api, 'SPAM');
    expect(ReportUserReason.fraud.api, 'FRAUD');
    expect(ReportUserReason.fakeProfile.api, 'FAKE_PROFILE');
    expect(ReportUserReason.copyright.api, 'COPYRIGHT');
    expect(ReportUserReason.adultContent.api, 'ADULT_CONTENT');
    expect(ReportUserReason.hateSpeech.api, 'HATE_SPEECH');
    expect(ReportUserReason.bullying.api, 'BULLYING');
    expect(ReportUserReason.threats.api, 'THREATS');
    expect(ReportUserReason.sexualContent.api, 'SEXUAL_CONTENT');
    expect(ReportUserReason.inappropriateContent.api, 'INAPPROPRIATE_CONTENT');
    expect(ReportUserReason.other.api, 'OTHER');
  });

  test('every value has a non-empty human label', () {
    for (final ReportUserReason r in ReportUserReason.values) {
      expect(r.label, isNotEmpty);
    }
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/features/audio_room/moderation/report_user_reason_test.dart`
Expected: FAIL — the file doesn't exist yet.

- [ ] **Step 3: Create the reason enum**

Create `soulzaa-mobile/lib/features/audio_room/moderation/domain/entities/report_user_reason.dart`:

```dart
/// Reasons a member can report another user in an audio room (mirrors the
/// backend's `ReportReason` enum, all 13 values). Distinct from
/// `ChatReportReason` (`audio_room/chat/domain/entities/chat_report_reason.dart`),
/// which covers only a single reported chat message and a smaller value set.
enum ReportUserReason {
  abuse,
  harassment,
  spam,
  fraud,
  fakeProfile,
  copyright,
  adultContent,
  hateSpeech,
  bullying,
  threats,
  sexualContent,
  inappropriateContent,
  other;

  /// The backend enum string expected in the report body.
  String get api {
    switch (this) {
      case ReportUserReason.abuse:
        return 'ABUSE';
      case ReportUserReason.harassment:
        return 'HARASSMENT';
      case ReportUserReason.spam:
        return 'SPAM';
      case ReportUserReason.fraud:
        return 'FRAUD';
      case ReportUserReason.fakeProfile:
        return 'FAKE_PROFILE';
      case ReportUserReason.copyright:
        return 'COPYRIGHT';
      case ReportUserReason.adultContent:
        return 'ADULT_CONTENT';
      case ReportUserReason.hateSpeech:
        return 'HATE_SPEECH';
      case ReportUserReason.bullying:
        return 'BULLYING';
      case ReportUserReason.threats:
        return 'THREATS';
      case ReportUserReason.sexualContent:
        return 'SEXUAL_CONTENT';
      case ReportUserReason.inappropriateContent:
        return 'INAPPROPRIATE_CONTENT';
      case ReportUserReason.other:
        return 'OTHER';
    }
  }

  /// Human-readable chip label. No l10n entry exists for the 5 values beyond
  /// `ChatReportReason`'s set, so this humanizes directly rather than
  /// partially localizing a mixed set.
  String get label {
    switch (this) {
      case ReportUserReason.fakeProfile:
        return 'Fake profile';
      case ReportUserReason.adultContent:
        return 'Adult content';
      case ReportUserReason.hateSpeech:
        return 'Hate speech';
      case ReportUserReason.sexualContent:
        return 'Sexual content';
      case ReportUserReason.inappropriateContent:
        return 'Inappropriate content';
      default:
        return name[0].toUpperCase() + name.substring(1);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `flutter test test/features/audio_room/moderation/report_user_reason_test.dart`
Expected: PASS.

- [ ] **Step 5: Add the endpoint constant**

In `soulzaa-mobile/lib/core/constants/api_endpoints.dart`, add next to `roomModActions` (around line 122):

```dart
  static String roomModReport(String id) => '/rooms/$id/moderation/report';
```

- [ ] **Step 6: Add `report` to the repository interface**

In `soulzaa-mobile/lib/features/audio_room/moderation/domain/repositories/moderation_repository.dart`, add the import and method (the file's own doc comment already scopes it to "`/api/rooms/:id/moderation/...`", so this belongs here, not in a new file):

```dart
import 'package:soulzaa_mobile/features/audio_room/moderation/domain/entities/report_user_reason.dart';
```

```dart
  /// `POST :id/moderation/report` — file a report against another member.
  /// Open to any active, non-self member (not gated on a moderation
  /// permission) — the server enforces that.
  Future<ApiResult<void>> report(
    String roomId,
    String userId, {
    required ReportUserReason reason,
    String? description,
  });
```

(add it after `unmute`, before the `// ---- Read (paginated) ----` section divider)

- [ ] **Step 7: Implement it in the remote data source**

In `soulzaa-mobile/lib/features/audio_room/moderation/data/datasources/moderation_remote_data_source.dart`, add the import and method (after `unmute`, before the `// ---- Read (paginated) ----` divider):

```dart
import 'package:soulzaa_mobile/features/audio_room/moderation/domain/entities/report_user_reason.dart';
```

```dart
  Future<void> report(
    String roomId,
    String userId, {
    required ReportUserReason reason,
    String? description,
  }) async {
    await _dio.post<dynamic>(
      ApiEndpoints.roomModReport(roomId),
      data: <String, dynamic>{
        'targetUserId': userId,
        'reason': reason.api,
        'description': ?description,
      },
    );
  }
```

- [ ] **Step 8: Implement it in the repository**

In `soulzaa-mobile/lib/features/audio_room/moderation/data/repositories/moderation_repository_impl.dart`, add the import and method (after `unmute`, before `getKicks`):

```dart
import 'package:soulzaa_mobile/features/audio_room/moderation/domain/entities/report_user_reason.dart';
```

```dart
  @override
  Future<ApiResult<void>> report(
    String roomId,
    String userId, {
    required ReportUserReason reason,
    String? description,
  }) => _guardVoid(
    () => _remote.report(roomId, userId, reason: reason, description: description),
  );
```

- [ ] **Step 9: Add the use case**

In `soulzaa-mobile/lib/features/audio_room/moderation/domain/usecases/moderation_usecases.dart`, add the import and class (after `KickUserUseCase`, or anywhere in the file — order doesn't matter, these are independent classes):

```dart
import 'package:soulzaa_mobile/features/audio_room/moderation/domain/entities/report_user_reason.dart';
```

```dart
class ReportUserUseCase {
  const ReportUserUseCase(this._repo);
  final ModerationRepository _repo;

  Future<ApiResult<void>> call(
    String roomId,
    String userId, {
    required ReportUserReason reason,
    String? description,
  }) => _repo.report(roomId, userId, reason: reason, description: description);
}
```

- [ ] **Step 10: Wire the provider**

In `soulzaa-mobile/lib/features/audio_room/moderation/presentation/providers/moderation_providers.dart`, add (in the `// ---- Use cases ----` section):

```dart
final Provider<ReportUserUseCase> reportUserUseCaseProvider =
    Provider<ReportUserUseCase>(
      (Ref ref) => ReportUserUseCase(ref.watch(moderationRepositoryProvider)),
    );
```

- [ ] **Step 11: Create the sheet wrapper**

Create `soulzaa-mobile/lib/features/audio_room/moderation/presentation/widgets/report_user_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/core/widgets/report_reason_sheet.dart';
import 'package:soulzaa_mobile/features/audio_room/moderation/domain/entities/report_user_reason.dart';
import 'package:soulzaa_mobile/features/audio_room/moderation/presentation/providers/moderation_providers.dart';

/// Lets any non-self member report another user in the audio room
/// (`POST rooms/:id/moderation/report`). Reuses the same reason-picker sheet
/// `report_message_sheet.dart` uses for chat messages — only the reason enum
/// and submit target differ.
Future<void> showReportUserSheet(
  BuildContext context, {
  required String roomId,
  required String targetUserId,
}) {
  return showReportReasonSheet<ReportUserReason>(
    context,
    title: 'Report user',
    reasons: ReportUserReason.values,
    label: (ReportUserReason r) => r.label,
    successMessage: 'Report submitted.',
    onSubmit: (WidgetRef ref, ReportUserReason reason, String? description) => ref
        .read(reportUserUseCaseProvider)
        .call(roomId, targetUserId, reason: reason, description: description)
        .then((result) => result.failureOrNull),
  );
}
```

- [ ] **Step 12: Wire it into the profile overlay**

In `soulzaa-mobile/lib/features/audio_room/in_room/presentation/widgets/seat_profile_card_overlay.dart`:

1. Add the import:

```dart
import 'package:soulzaa_mobile/features/audio_room/moderation/presentation/widgets/report_user_sheet.dart';
```

2. In `_buildActionButtons`, add a "Report" button to the "Primary Social Action Row" (the `if (!isSelf) ...` block, currently Gift + Message). Change that block's `Row` from two `Expanded` children to three:

```dart
        if (!isSelf) ...<Widget>[
          Row(
            children: <Widget>[
              // Gift Button
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: () {
                    Navigator.of(context).pop();
                    if (profile != null) {
                      unawaited(_giftTo(context, ref, profile));
                    }
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFFEC4899),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  icon: const Icon(Icons.card_giftcard_rounded, size: 18),
                  label: const Text(
                    'Send Gift',
                    style: TextStyle(fontWeight: FontWeight.bold),
                  ),
                ),
              ),
              const SizedBox(width: 10),

              // Message Button
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () {
                    Navigator.of(context).pop();
                    if (profile != null) {
                      unawaited(_startChat(context, ref, profile));
                    }
                  },
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: BorderSide(color: Colors.white.withOpacity(0.35)),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  icon: const Icon(Icons.chat_bubble_outline_rounded, size: 18),
                  label: const Text(
                    'Message',
                    style: TextStyle(fontWeight: FontWeight.bold),
                  ),
                ),
              ),
              const SizedBox(width: 10),

              // Report Button
              if (roomState != null && targetUserId.isNotEmpty)
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () {
                      Navigator.of(context).pop();
                      showReportUserSheet(
                        context,
                        roomId: roomState.room.id,
                        targetUserId: targetUserId,
                      );
                    },
                    style: OutlinedButton.styleFrom(
                      foregroundColor: const Color(0xFFF87171),
                      side: const BorderSide(color: Color(0xFFF87171)),
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                    ),
                    icon: const Icon(Icons.flag_rounded, size: 18),
                    label: const Text(
                      'Report',
                      style: TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
        ],
```

(`roomState`/`targetUserId` are already parameters of `_buildActionButtons` — see its signature a few lines above this block. The Report button is guarded on `roomState != null` because reporting needs a `roomId`; on the rare path where this overlay is opened without room context — `showUserProfileCardOverlay` with `roomId: null` — Report is simply not offered, matching how the existing "Moderate" button below already handles the same case with `roomState!.room.id`.)

- [ ] **Step 13: Verify it compiles**

Run: `flutter analyze lib/features/audio_room/`
Expected: clean.

- [ ] **Step 14: Manual verification**

Run the app (moderator-app run instructions don't apply here — this is the consumer/USER-role path): start an audio room with two test accounts, tap a seated participant's avatar to open the profile overlay, tap "Report", pick a reason, optionally add a description, submit, and confirm the "Report submitted." snackbar appears and the sheet closes. Then confirm the report shows up in the moderator portal's Reports queue for a moderator scoped to that room owner's territory (uses the already-existing `GET mobile/workforce/moderation/queue` — no new verification needed beyond confirming the report row exists).

- [ ] **Step 15: Commit**

```bash
git add lib/core/constants/api_endpoints.dart lib/features/audio_room/moderation/domain/entities/report_user_reason.dart lib/features/audio_room/moderation/domain/repositories/moderation_repository.dart lib/features/audio_room/moderation/data/repositories/moderation_repository_impl.dart lib/features/audio_room/moderation/data/datasources/moderation_remote_data_source.dart lib/features/audio_room/moderation/domain/usecases/moderation_usecases.dart lib/features/audio_room/moderation/presentation/providers/moderation_providers.dart lib/features/audio_room/moderation/presentation/widgets/report_user_sheet.dart lib/features/audio_room/in_room/presentation/widgets/seat_profile_card_overlay.dart test/features/audio_room/moderation/report_user_reason_test.dart
git commit -m "feat(audio-room): add Report user to the participant profile overlay"
```

---

## Task 3: Video room — wire the dead "Report" stub

**Files:**
- Create: `soulzaa-mobile/lib/features/video_room/domain/entities/video_room_report_reason.dart`
- Modify: `soulzaa-mobile/lib/features/video_room/domain/repositories/video_room_repository.dart`
- Modify: `soulzaa-mobile/lib/features/video_room/data/repositories/video_room_repository_impl.dart`
- Modify: `soulzaa-mobile/lib/features/video_room/presentation/providers/video_room_controller.dart`
- Create: `soulzaa-mobile/lib/features/video_room/presentation/widgets/profile/report_user_sheet.dart`
- Modify: `soulzaa-mobile/lib/features/video_room/presentation/widgets/profile/host_public_profile_sheet.dart`
- Test: `soulzaa-mobile/test/features/video_room/domain/video_room_report_reason_test.dart`

**Interfaces:**
- Consumes: `showReportReasonSheet<T>` (Task 1).
- Produces: `showVideoRoomReportUserSheet(BuildContext context, {required VideoRoomController controller, required String roomId, required String targetUserId}) → Future<void>`.

Backend contract this calls: `POST video-rooms/:id/report` with body `{targetUserId, reason, description?}` — `ReportVideoRoomUserDto` in `src/modules/video-rooms/dto/moderation.dto.ts`, already built, no backend changes. Unlike the audio-room repository (Task 2), `VideoRoomRepository`'s write methods return plain `Future<void>` (throw on failure) rather than `ApiResult<T>` — this task matches that existing convention rather than introducing `ApiResult` into this repository.

- [ ] **Step 1: Write the failing test for the reason enum**

Create `soulzaa-mobile/test/features/video_room/domain/video_room_report_reason_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/video_room/domain/entities/video_room_report_reason.dart';

void main() {
  test('every value maps to the exact backend VideoRoomReportReason enum string', () {
    expect(VideoRoomReportReason.user.api, 'USER');
    expect(VideoRoomReportReason.message.api, 'MESSAGE');
    expect(VideoRoomReportReason.spam.api, 'SPAM');
    expect(VideoRoomReportReason.harassment.api, 'HARASSMENT');
    expect(VideoRoomReportReason.abuse.api, 'ABUSE');
    expect(VideoRoomReportReason.fakeAccount.api, 'FAKE_ACCOUNT');
    expect(VideoRoomReportReason.hateSpeech.api, 'HATE_SPEECH');
    expect(VideoRoomReportReason.bullying.api, 'BULLYING');
    expect(VideoRoomReportReason.threats.api, 'THREATS');
    expect(VideoRoomReportReason.sexualContent.api, 'SEXUAL_CONTENT');
    expect(VideoRoomReportReason.inappropriateContent.api, 'INAPPROPRIATE_CONTENT');
    expect(VideoRoomReportReason.other.api, 'OTHER');
  });

  test('every value has a non-empty human label', () {
    for (final VideoRoomReportReason r in VideoRoomReportReason.values) {
      expect(r.label, isNotEmpty);
    }
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/features/video_room/domain/video_room_report_reason_test.dart`
Expected: FAIL — the file doesn't exist yet.

- [ ] **Step 3: Create the reason enum**

Create `soulzaa-mobile/lib/features/video_room/domain/entities/video_room_report_reason.dart`:

```dart
/// Reasons a member can report another user in a video room (mirrors the
/// backend's `VideoRoomReportReason` enum, all 12 values).
enum VideoRoomReportReason {
  user,
  message,
  spam,
  harassment,
  abuse,
  fakeAccount,
  hateSpeech,
  bullying,
  threats,
  sexualContent,
  inappropriateContent,
  other;

  /// The backend enum string expected in the report body.
  String get api {
    switch (this) {
      case VideoRoomReportReason.user:
        return 'USER';
      case VideoRoomReportReason.message:
        return 'MESSAGE';
      case VideoRoomReportReason.spam:
        return 'SPAM';
      case VideoRoomReportReason.harassment:
        return 'HARASSMENT';
      case VideoRoomReportReason.abuse:
        return 'ABUSE';
      case VideoRoomReportReason.fakeAccount:
        return 'FAKE_ACCOUNT';
      case VideoRoomReportReason.hateSpeech:
        return 'HATE_SPEECH';
      case VideoRoomReportReason.bullying:
        return 'BULLYING';
      case VideoRoomReportReason.threats:
        return 'THREATS';
      case VideoRoomReportReason.sexualContent:
        return 'SEXUAL_CONTENT';
      case VideoRoomReportReason.inappropriateContent:
        return 'INAPPROPRIATE_CONTENT';
      case VideoRoomReportReason.other:
        return 'OTHER';
    }
  }

  /// Human-readable chip label.
  String get label {
    switch (this) {
      case VideoRoomReportReason.user:
        return 'This user';
      case VideoRoomReportReason.message:
        return 'A message';
      case VideoRoomReportReason.fakeAccount:
        return 'Fake account';
      case VideoRoomReportReason.hateSpeech:
        return 'Hate speech';
      case VideoRoomReportReason.sexualContent:
        return 'Sexual content';
      case VideoRoomReportReason.inappropriateContent:
        return 'Inappropriate content';
      default:
        return name[0].toUpperCase() + name.substring(1);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `flutter test test/features/video_room/domain/video_room_report_reason_test.dart`
Expected: PASS.

- [ ] **Step 5: Add `reportUser` to the repository interface**

In `soulzaa-mobile/lib/features/video_room/domain/repositories/video_room_repository.dart`, add the import and method (right after `banUser`, around line 134):

```dart
import 'package:soulzaa_mobile/features/video_room/domain/entities/video_room_report_reason.dart';
```

```dart
  /// `POST :id/report` — file a report against another user in the room.
  /// Open to any active, non-self member (not gated on host status) — the
  /// server enforces that.
  Future<void> reportUser(
    String roomId,
    String userId, {
    required VideoRoomReportReason reason,
    String? description,
  });
```

- [ ] **Step 6: Implement it in the repository**

In `soulzaa-mobile/lib/features/video_room/data/repositories/video_room_repository_impl.dart`, add the import and method (right after `banUser`, around line 463):

```dart
import 'package:soulzaa_mobile/features/video_room/domain/entities/video_room_report_reason.dart';
```

```dart
  @override
  Future<void> reportUser(
    String roomId,
    String userId, {
    required VideoRoomReportReason reason,
    String? description,
  }) async {
    await _dio.post<dynamic>(
      '/video-rooms/$roomId/report',
      data: <String, dynamic>{
        'targetUserId': userId,
        'reason': reason.api,
        'description': ?description,
      },
    );
  }
```

- [ ] **Step 7: Expose it on the controller**

In `soulzaa-mobile/lib/features/video_room/presentation/providers/video_room_controller.dart`, add the import and method (right after `banUser`, around line 1671). Unlike `kickUser`/`banUser`, this is **not** gated on `state.isHost` — reporting is open to any non-self member:

```dart
import 'package:soulzaa_mobile/features/video_room/domain/entities/video_room_report_reason.dart';
```

```dart
  Future<void> reportUser(
    String targetUserId, {
    required VideoRoomReportReason reason,
    String? description,
  }) => _repository.reportUser(_roomId, targetUserId, reason: reason, description: description);
```

- [ ] **Step 8: Create the sheet wrapper**

Create `soulzaa-mobile/lib/features/video_room/presentation/widgets/profile/report_user_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:soulzaa_mobile/core/error/error_mapper.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';
import 'package:soulzaa_mobile/core/widgets/report_reason_sheet.dart';
import 'package:soulzaa_mobile/features/video_room/domain/entities/video_room_report_reason.dart';
import 'package:soulzaa_mobile/features/video_room/presentation/providers/video_room_controller.dart';

/// Lets any non-self member report another user in the video room
/// (`POST video-rooms/:id/report`). Reuses the same reason-picker sheet the
/// audio-room and chat-message report flows use. Takes the already-resolved
/// [VideoRoomController] rather than looking one up via `ref` — the caller
/// (`host_public_profile_sheet.dart`) already has one in scope.
Future<void> showVideoRoomReportUserSheet(
  BuildContext context, {
  required VideoRoomController controller,
  required String roomId,
  required String targetUserId,
}) {
  return showReportReasonSheet<VideoRoomReportReason>(
    context,
    title: 'Report user',
    reasons: VideoRoomReportReason.values,
    label: (VideoRoomReportReason r) => r.label,
    successMessage: 'Report submitted.',
    onSubmit: (WidgetRef ref, VideoRoomReportReason reason, String? description) async {
      try {
        await controller.reportUser(targetUserId, reason: reason, description: description);
        return null;
      } on Object catch (e, s) {
        return ErrorMapper.mapToFailure(e, s);
      }
    },
  );
}
```

- [ ] **Step 9: Wire it into the dead stub**

In `soulzaa-mobile/lib/features/video_room/presentation/widgets/profile/host_public_profile_sheet.dart`:

1. Add the import:

```dart
import 'package:soulzaa_mobile/features/video_room/presentation/widgets/profile/report_user_sheet.dart';
```

2. Replace the Report button's `onTap` (currently `// TODO: Open report dialog`, around line 417):

```dart
                              onTap: () {
                                Navigator.of(ctx).pop();
                                showVideoRoomReportUserSheet(
                                  context,
                                  controller: controller,
                                  roomId: room.id,
                                  targetUserId: room.hostId,
                                );
                              },
```

(`controller` and `room` are already in scope — see `showHostPublicProfileSheet`'s parameters a few lines above this block; `room.hostId` is the target being reported, since this sheet is specifically the host's profile card.)

- [ ] **Step 10: Verify it compiles**

Run: `flutter analyze lib/features/video_room/`
Expected: clean.

- [ ] **Step 11: Manual verification**

Run the app: join a video room as a non-host viewer, tap the host's avatar to open their profile sheet, tap "Report", pick a reason, submit, confirm the "Report submitted." snackbar. Confirm the report appears in the moderator portal's Reports queue for a moderator scoped to that room owner's territory.

- [ ] **Step 12: Commit**

```bash
git add lib/features/video_room/domain/entities/video_room_report_reason.dart lib/features/video_room/domain/repositories/video_room_repository.dart lib/features/video_room/data/repositories/video_room_repository_impl.dart lib/features/video_room/presentation/providers/video_room_controller.dart lib/features/video_room/presentation/widgets/profile/report_user_sheet.dart lib/features/video_room/presentation/widgets/profile/host_public_profile_sheet.dart test/features/video_room/domain/video_room_report_reason_test.dart
git commit -m "feat(video-room): wire up Report user in the host profile sheet"
```
