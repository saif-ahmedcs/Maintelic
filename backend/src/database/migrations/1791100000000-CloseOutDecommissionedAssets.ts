import { MigrationInterface, QueryRunner } from 'typeorm';

export class CloseOutDecommissionedAssets1791100000000 implements MigrationInterface {
  name = 'CloseOutDecommissionedAssets1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH targets AS (
        SELECT wo."id", wo."status"
        FROM "work_orders" wo
        JOIN "assets" a ON a."id" = wo."asset_id"
        WHERE a."status" = 'DECOMMISSIONED'
          AND wo."status" IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED')
        FOR UPDATE OF wo
      ),
      cancelled AS (
        UPDATE "work_orders" wo
        SET "status" = 'CANCELLED', "cancelled_at" = now()
        FROM targets t
        WHERE wo."id" = t."id"
        RETURNING wo."id"
      )
      INSERT INTO "audit_logs"
        ("actor_user_id", "entity_type", "entity_id", "action", "before", "after", "source")
      SELECT NULL, 'WorkOrder', t."id", 'CANCEL',
             jsonb_build_object('status', t."status"),
             jsonb_build_object('status', 'CANCELLED'),
             'asset-decommission'
      FROM targets t
      JOIN cancelled c ON c."id" = t."id"
    `);

    await queryRunner.query(`
      WITH targets AS (
        SELECT mp."id"
        FROM "maintenance_plans" mp
        JOIN "assets" a ON a."id" = mp."asset_id"
        WHERE a."status" = 'DECOMMISSIONED' AND mp."active" = true
        FOR UPDATE OF mp
      ),
      deactivated AS (
        UPDATE "maintenance_plans" mp
        SET "active" = false
        FROM targets t
        WHERE mp."id" = t."id"
        RETURNING mp."id"
      )
      INSERT INTO "audit_logs"
        ("actor_user_id", "entity_type", "entity_id", "action", "before", "after", "source")
      SELECT NULL, 'MaintenancePlan', d."id", 'UPDATE',
             jsonb_build_object('active', true),
             jsonb_build_object('active', false),
             'asset-decommission'
      FROM deactivated d
    `);

    await queryRunner.query(`
      UPDATE "notifications" n
      SET "status" = 'RESOLVED', "resolved_at" = now(), "resolved_by_user_id" = NULL
      WHERE n."status" IN ('UNREAD', 'ACKNOWLEDGED')
        AND n."type" = 'OVERDUE_MAINTENANCE'
        AND EXISTS (
          SELECT 1
          FROM "maintenance_plans" mp
          JOIN "assets" a ON a."id" = mp."asset_id"
          WHERE mp."id" = n."related_entity_id" AND a."status" = 'DECOMMISSIONED'
        )
    `);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op: the cancelled work orders, deactivated plans and
    // resolved alerts are the correct end state for decommissioned assets, and
    // the original per-row state is kept in the audit log.
  }
}
