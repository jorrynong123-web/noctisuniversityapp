import app from "./app";
import { seedIfEmpty, ensureCharacterPosts } from "./seed";
import { autoMigrateUsersFromOldDb, autoMigrateMessagesFromOldDb } from "./lib/auto-migrate";
import { applyApologyBonus } from "./lib/apology-bonus";
import { prewarmCaches } from "./routes/posts";
import { runUsersPrewarm } from "./routes/auth";

(async () => {
  try { await autoMigrateUsersFromOldDb(); } catch {}
  try { await autoMigrateMessagesFromOldDb(); } catch {}
  try { await applyApologyBonus(); } catch {}
  try { await seedIfEmpty(); await ensureCharacterPosts(); } catch {}
  try { await Promise.all([prewarmCaches(), runUsersPrewarm()]); } catch {}
})();

export default app;
