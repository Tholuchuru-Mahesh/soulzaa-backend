import type { EscalationSeverity } from './workforce-scope.service';

/**
 * The three bits of side-effect work every domain's `escalateViolation` does
 * once it has appended its own domain-specific moderation-action row (which
 * stays per-domain — different Prisma tables, different action-type enums):
 * bump the moderator's performance stats, write the audit-log entry, and
 * notify whoever `resolveEscalationRecipients` says should hear about it.
 * Audio-room, video-room and live-stream moderation services were
 * reimplementing this identically; shared here instead.
 */
export interface EscalationRecorderDeps {
  performanceStats?: { recordAction(actorId: string, action: string): Promise<void> };
  // `input: any` — each domain's AuditLogService/INotificationService accepts a
  // more specific params type than a generic Record, which fails structural
  // assignability; the extra fields these calls pass are always valid on the
  // real implementations, so this is a pass-through, not a real widening.
  auditLog?: { logAction(input: any): unknown };
  scopeService?: {
    resolveEscalationRecipients(
      severity: EscalationSeverity,
      ownerId: string | null,
    ): Promise<string[]>;
  };
  notifications?: { create(input: any): Promise<unknown> };
}

export interface EscalationRecorderParams extends EscalationRecorderDeps {
  actorId: string;
  targetUserId: string;
  reason: string;
  severity: EscalationSeverity;
  /** e.g. 'audio_room.escalate_critical_violation' */
  auditAction: string;
  /** e.g. 'audio_room' — becomes both the audit log `resource` and the notification `entityType`. */
  resource: string;
  /** The room/stream id — becomes both the audit log `resourceId` and the notification `entityId`. */
  resourceId: string;
  /** The resource owner's id — used to resolve escalation recipients by their state/country (all three domains resolve this the same way). */
  ownerId: string | null;
  /**
   * `AuditLog.region` is a free-text field untouched by the Region→State
   * scoping migration; nothing here has a region value to put in it anymore,
   * so no caller sets this and the column stays null for these entries —
   * same as audio/video rooms already left it before this changed.
   */
  auditRegion?: string | null;
  requestMeta?: { ip?: string; userAgent?: string };
}

export async function recordEscalationOutcome(params: EscalationRecorderParams): Promise<void> {
  if (params.performanceStats) {
    await params.performanceStats.recordAction(params.actorId, 'REPORT_ESCALATED');
  }

  if (params.auditLog) {
    void params.auditLog.logAction({
      actorId: params.actorId,
      action: params.auditAction,
      resource: params.resource,
      resourceId: params.resourceId,
      targetUserId: params.targetUserId,
      ...(params.auditRegion !== undefined ? { region: params.auditRegion ?? undefined } : {}),
      violationReason: params.reason,
      ipAddress: params.requestMeta?.ip,
      userAgent: params.requestMeta?.userAgent,
      details: {
        targetUserId: params.targetUserId,
        reason: params.reason,
        severity: params.severity,
      },
    });
  }

  if (params.scopeService && params.notifications) {
    const recipients = await params.scopeService.resolveEscalationRecipients(
      params.severity,
      params.ownerId,
    );
    await Promise.all(
      recipients.map((userId) =>
        params.notifications!.create({
          userId,
          type: 'MODERATION_CASE_ESCALATED',
          actorId: params.actorId,
          entityType: params.resource,
          entityId: params.resourceId,
          data: {
            targetUserId: params.targetUserId,
            reason: params.reason,
            severity: params.severity,
          },
        }),
      ),
    );
  }
}
