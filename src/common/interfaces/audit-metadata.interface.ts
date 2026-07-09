/**
 * Audit columns every table carries (see the Prisma base entity). Writes stamp
 * createdBy/updatedBy with the acting user's id — see utils/audit.util.ts.
 */
export interface AuditMetadata {
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
}
