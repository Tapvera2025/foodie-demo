/**
 * The audit log's writer.
 *
 * WHY THIS FILE DID NOT EXIST
 *
 * `audit.ts` has been here since the first week: the `AUDITED_ACTIONS` list,
 * the `AuditEntry` shape, `buildAuditEntry` reading the actor from ambient
 * context so no call site can forget to name one, and an `AuditWriter` port
 * with a comment saying "the database implementation lands with the tenancy
 * module". It never did. The `audit_log` table was created, given an
 * append-only trigger, and had exactly one INSERT written against it anywhere
 * in the repository — inside `test-constraints.ts`, proving the trigger worked
 * on an empty table.
 *
 * So every privileged action the platform takes has been unrecorded. A stall
 * rejecting forty orders, which §12.1 says must have an answer, had none. And
 * §13.3's argument for building a Refunds module at all — "so that a refund is
 * never an untracked SQL statement" — was resting on a table nothing wrote to.
 *
 * A port with no adapter is the §2.2 pattern in its purest form: the design was
 * right, the review passed, and the behaviour was absent.
 */

import type { Kysely, Transaction } from 'kysely';

import { log } from './logger.js';
import type { AuditEntry, AuditWriter } from './audit.js';
import type { ActorType as DbActorType, Database, Json } from './schema.js';

function toJsonb(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/**
 * `correlation.ts` declares a `DEVICE` actor type. The `actor_type` enum in the
 * database does not have that label.
 *
 * Found by writing the first audit row. Until now nothing inserted one, so the
 * two definitions were free to disagree — a mounted tablet doing something
 * audited would have failed at the INSERT with an enum error, at whatever hour
 * that first happened.
 *
 * A device always acts on behalf of a vendor, so `VENDOR_USER` is the truthful
 * column value, and the original is kept in `metadata` rather than discarded:
 * "a tablet did this" and "a person did this" are different facts and the
 * mapping should not quietly erase one. Adding the enum label is the better fix
 * and needs a migration — noted rather than assumed.
 */
function columnActor(actor: AuditEntry['actorType']): DbActorType {
  return actor === 'DEVICE' ? 'VENDOR_USER' : actor;
}

export class AuditRepository implements AuditWriter {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Write the row.
   *
   * Takes an optional transaction because the interesting audit rows describe
   * something that also changed data, and the two must commit together. An
   * audit row written outside the transaction that caused it is a row that
   * survives a rollback and describes something that never happened — which is
   * worse than the absence, because it is believed.
   */
  async write(entry: AuditEntry, trx?: Transaction<Database>): Promise<void> {
    const db = trx ?? this.db;

    try {
      await db
        .insertInto('audit_log')
        .values({
          actor_type: columnActor(entry.actorType),
          actor_id: entry.actorId ?? null,
          action: entry.action,
          entity: entry.entity,
          entity_id: entry.entityId ?? null,
          food_court_id: entry.foodCourtId ?? null,
          vendor_id: entry.vendorId ?? null,
          before_value: entry.beforeValue === undefined ? null : toJsonb(entry.beforeValue),
          after_value: entry.afterValue === undefined ? null : toJsonb(entry.afterValue),
          metadata: toJsonb(
            entry.actorType === 'DEVICE'
              ? { ...(entry.metadata ?? {}), actorTypeReported: 'DEVICE' }
              : (entry.metadata ?? {}),
          ),
          correlation_id: entry.correlationId,
        })
        .execute();
    } catch (e) {
      /**
       * A failed audit write must not fail the action it describes — but it
       * must be impossible to miss.
       *
       * The alternative shapes are both worse. Throwing means a full disk in
       * the audit table stops the kitchen accepting orders. Swallowing
       * silently reintroduces exactly the condition this file was written to
       * end: an audit trail that is trusted and empty.
       *
       * When this is inside a transaction the throw propagates anyway and the
       * whole action rolls back, which is the correct behaviour there — the
       * caller chose atomicity by passing the transaction.
       */
      if (trx) throw e;
      log().error(
        {
          event: 'audit_write_failed',
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId,
          correlationId: entry.correlationId,
          err: (e as Error).message,
        },
        'a privileged action was not recorded in the audit log',
      );
    }
  }
}
