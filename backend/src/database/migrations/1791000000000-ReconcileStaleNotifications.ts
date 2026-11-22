import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReconcileStaleNotifications1791000000000 implements MigrationInterface {
  name = 'ReconcileStaleNotifications1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notifications" n
      SET "status" = 'RESOLVED', "resolved_at" = now(), "resolved_by_user_id" = NULL
      WHERE n."status" IN ('UNREAD', 'ACKNOWLEDGED')
        AND n."type" = 'CRITICAL_ASSET'
        AND NOT EXISTS (
          SELECT 1 FROM "assets" a
          WHERE a."id" = n."related_entity_id" AND a."status" = 'CRITICAL'
        )
    `);

    await queryRunner.query(`
      UPDATE "notifications" n
      SET "status" = 'RESOLVED', "resolved_at" = now(), "resolved_by_user_id" = NULL
      WHERE n."status" IN ('UNREAD', 'ACKNOWLEDGED')
        AND n."type" = 'LOW_STOCK'
        AND NOT EXISTS (
          SELECT 1 FROM "spare_parts" p
          WHERE p."id" = n."related_entity_id"
            AND p."quantity_on_hand" <= p."reorder_threshold"
        )
    `);

    await queryRunner.query(`
      UPDATE "notifications" n
      SET "status" = 'RESOLVED', "resolved_at" = now(), "resolved_by_user_id" = NULL
      WHERE n."status" IN ('UNREAD', 'ACKNOWLEDGED')
        AND n."type" = 'OVERDUE_MAINTENANCE'
        AND NOT EXISTS (
          SELECT 1 FROM "maintenance_plans" m
          WHERE m."id" = n."related_entity_id"
            AND m."active" = true
            AND m."next_due_at" IS NOT NULL
            AND m."next_due_at" <= now() + interval '1 day'
        )
    `);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op: reopening notifications cannot be done safely
    // (the original status, UNREAD vs ACKNOWLEDGED, is not retained) and a
    // resolved, state-inactive notification is the correct end state.
  }
}
