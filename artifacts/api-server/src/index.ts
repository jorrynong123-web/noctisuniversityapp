import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty, ensureCharacterPosts } from "./seed";
import { autoMigrateUsersFromOldDb, autoMigrateMessagesFromOldDb } from "./lib/auto-migrate";
import { applyApologyBonus } from "./lib/apology-bonus";
import { prewarmCaches } from "./routes/posts";
import { runUsersPrewarm } from "./routes/auth";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  try {
    await autoMigrateUsersFromOldDb();
  } catch (e) {
    logger.error({ err: e }, "Auto-migration failed (non-fatal)");
  }

  try {
    await autoMigrateMessagesFromOldDb();
  } catch (e) {
    logger.error({ err: e }, "Message migration failed (non-fatal)");
  }

  try {
    await applyApologyBonus();
  } catch (e) {
    logger.error({ err: e }, "Apology bonus failed (non-fatal)");
  }

  try {
    await seedIfEmpty();
    await ensureCharacterPosts();
    logger.info("Database seed check complete");
  } catch (e) {
    logger.error({ err: e }, "Seed failed (non-fatal)");
  }

  // Pre-warm posts + leaderboard + users caches in parallel — first requests are instant
  try {
    await Promise.all([prewarmCaches(), runUsersPrewarm()]);
    logger.info("Caches pre-warmed — first requests will be fast");
  } catch (e) {
    logger.error({ err: e }, "Cache pre-warm failed (non-fatal)");
  }
});
