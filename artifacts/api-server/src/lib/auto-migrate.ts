import pg from "pg";
import { db } from "@workspace/db";
import { usersTable, messagesTable } from "@workspace/db";

const { Pool } = pg;

export async function autoMigrateUsersFromOldDb(): Promise<void> {
  const oldDbUrl = process.env.DATABASE_URL;
  const supUrl = process.env.SUPABASE_DATABASE_URL;

  if (!supUrl || !oldDbUrl) return;
  if (oldDbUrl.includes("supabase.com") || oldDbUrl === supUrl.replace("?pgbouncer=true", "")) return;

  // If Supabase already has users, migration is complete — skip connecting to local Postgres entirely.
  // This prevents unnecessary PostgreSQL compute charges on every server restart.
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).limit(5);
    if (existing.length >= 5) {
      // Already populated — nothing to migrate
      return;
    }
  } catch {}

  const oldPool = new Pool({ connectionString: oldDbUrl });

  try {
    const { rows } = await oldPool.query(
      "SELECT id, username, password_hash, salt, profile FROM umbra_users ORDER BY created_at ASC"
    );

    if (rows.length === 0) return;

    console.log(`[auto-migrate] Found ${rows.length} users in old database — migrating to Supabase…`);
    let migrated = 0;

    for (const row of rows) {
      try {
        if (!row.id || !row.username || !row.password_hash) continue;
        await db.insert(usersTable).values({
          id: row.id,
          username: row.username,
          passwordHash: row.password_hash,
          salt: row.salt || "",
          profile: row.profile || {},
        }).onConflictDoNothing();
        migrated++;
      } catch {}
    }

    console.log(`[auto-migrate] Done — ${migrated}/${rows.length} users migrated to Supabase.`);
  } catch (err: any) {
    console.error("[auto-migrate] Error reading old database:", err.message);
  } finally {
    await oldPool.end().catch(() => {});
  }
}

/** Migrate messages from local Postgres to Supabase (one-time, idempotent via onConflictDoNothing). */
export async function autoMigrateMessagesFromOldDb(): Promise<void> {
  const oldDbUrl = process.env.DATABASE_URL;
  const supUrl = process.env.SUPABASE_DATABASE_URL;

  if (!supUrl || !oldDbUrl) return;
  if (oldDbUrl.includes("supabase.com") || oldDbUrl === supUrl.replace("?pgbouncer=true", "")) return;

  // Check if local Postgres has a messages table with user-sent messages
  const oldPool = new Pool({ connectionString: oldDbUrl });
  try {
    const { rows: localMsgs } = await oldPool.query(
      "SELECT id, from_id, from_username, from_pic, to_id, to_username, text, created_at, image_url FROM messages ORDER BY created_at ASC LIMIT 500"
    );

    if (localMsgs.length === 0) return;

    // Check how many of these are already in Supabase to avoid redundant work
    const { rows: countRows } = await oldPool.query("SELECT COUNT(*) as cnt FROM messages");
    const localCount = parseInt(countRows[0]?.cnt || "0", 10);

    const existing = await db.select({ id: messagesTable.id }).from(messagesTable).limit(500);
    const existingIds = new Set(existing.map(m => m.id));

    const toInsert = localMsgs.filter(r => !existingIds.has(r.id));
    if (toInsert.length === 0) return;

    console.log(`[auto-migrate-msgs] Migrating ${toInsert.length}/${localCount} messages to Supabase…`);
    let migrated = 0;

    for (const row of toInsert) {
      try {
        await db.insert(messagesTable).values({
          id: row.id,
          fromId: row.from_id,
          fromUsername: row.from_username || row.from_id,
          fromPic: row.from_pic || "🌑",
          toId: row.to_id,
          toUsername: row.to_username || row.to_id,
          text: row.text || "",
          imageUrl: row.image_url || null,
          createdAt: row.created_at ? new Date(row.created_at) : new Date(),
        }).onConflictDoNothing();
        migrated++;
      } catch {}
    }

    console.log(`[auto-migrate-msgs] Done — ${migrated} messages migrated to Supabase.`);
  } catch (err: any) {
    // If messages table doesn't exist or any error, just skip silently
    if (!err.message?.includes("does not exist")) {
      console.error("[auto-migrate-msgs] Error:", err.message);
    }
  } finally {
    await oldPool.end().catch(() => {});
  }
}
