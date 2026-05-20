import { Router, type IRouter } from "express";
import pg from "pg";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";

const router: IRouter = Router();
const { Pool } = pg;

const MIGRATE_KEY = process.env.MIGRATE_SECRET || "umbra-migrate-2026";

router.post("/admin/migrate-users", async (req, res) => {
  const key = req.headers["x-migrate-key"] || req.query.key;
  if (key !== MIGRATE_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const oldDbUrl = process.env.DATABASE_URL;
  if (!oldDbUrl) {
    return res.status(400).json({ error: "DATABASE_URL not set — no old database to migrate from" });
  }

  const supUrl = process.env.SUPABASE_DATABASE_URL;
  if (!supUrl) {
    return res.status(400).json({ error: "SUPABASE_DATABASE_URL not set — Supabase not configured" });
  }

  if (oldDbUrl.includes("supabase.com")) {
    return res.status(400).json({ error: "DATABASE_URL points to Supabase — same database, nothing to migrate" });
  }

  const oldPool = new Pool({ connectionString: oldDbUrl });
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const log: string[] = [];

  try {
    const { rows } = await oldPool.query(
      "SELECT id, username, password_hash, salt, profile, created_at FROM umbra_users ORDER BY created_at ASC"
    );

    log.push(`Found ${rows.length} users in old database`);

    for (const row of rows) {
      try {
        await db.insert(usersTable).values({
          id: row.id,
          username: row.username,
          passwordHash: row.password_hash,
          salt: row.salt,
          profile: row.profile || {},
        }).onConflictDoNothing();
        migrated++;
        log.push(`✓ Migrated: ${row.username} (${row.id})`);
      } catch (err: any) {
        errors++;
        log.push(`✗ Error migrating ${row.username}: ${err.message}`);
      }
    }

    return res.json({
      success: true,
      total: rows.length,
      migrated,
      skipped,
      errors,
      log,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message, log });
  } finally {
    await oldPool.end().catch(() => {});
  }
});

router.get("/admin/migrate-status", async (req, res) => {
  const key = req.headers["x-migrate-key"] || req.query.key;
  if (key !== MIGRATE_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const oldDbUrl = process.env.DATABASE_URL;
  const oldPool = oldDbUrl ? new Pool({ connectionString: oldDbUrl }) : null;

  try {
    let oldCount = 0;
    let oldUsers: any[] = [];
    if (oldPool && !oldDbUrl?.includes("supabase.com")) {
      const { rows } = await oldPool.query("SELECT id, username, created_at FROM umbra_users ORDER BY created_at ASC");
      oldCount = rows.length;
      oldUsers = rows.map(r => ({ id: r.id, username: r.username, created: r.created_at }));
    }

    const supabaseUsers = await db.select({
      id: usersTable.id,
      username: usersTable.username,
    }).from(usersTable).limit(500);

    return res.json({
      oldDatabase: { count: oldCount, users: oldUsers },
      supabase: { count: supabaseUsers.length, users: supabaseUsers },
    });
  } finally {
    await oldPool?.end().catch(() => {});
  }
});

export default router;
