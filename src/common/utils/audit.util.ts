/**
 * Helpers to stamp audit columns on Prisma writes from the acting user's id.
 * On create both createdBy and updatedBy are set; on update only updatedBy.
 * (createdAt/updatedAt are handled by Prisma @default/@updatedAt.)
 */
export function auditCreate(actorId: string): { createdBy: string; updatedBy: string } {
  return { createdBy: actorId, updatedBy: actorId };
}

export function auditUpdate(actorId: string): { updatedBy: string } {
  return { updatedBy: actorId };
}

/** Soft-delete stamp: marks deletedAt now and records who deleted it. */
export function auditSoftDelete(actorId: string): { deletedAt: Date; updatedBy: string } {
  return { deletedAt: new Date(), updatedBy: actorId };
}
