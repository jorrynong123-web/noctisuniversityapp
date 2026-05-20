import { db } from "@workspace/db";
import { usersTable, walletBalancesTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const BONUS_MARKER = "_apology_bonus_v1";
const BONUS_AMOUNT = 50_000;
const REP_FLOOR = 100;

export async function applyApologyBonus(): Promise<void> {
  // Check if bonus was already applied (marker record in wallet_balances)
  const [marker] = await db
    .select()
    .from(walletBalancesTable)
    .where(sql`${walletBalancesTable.userId} = ${BONUS_MARKER}`)
    .limit(1);

  if (marker) {
    return; // Already ran
  }

  console.log("[apology-bonus] Applying reputation floor + 50k wallet bonus to all users…");

  // 1. Fetch all users
  const users = await db.select({ id: usersTable.id, profile: usersTable.profile }).from(usersTable);

  let repFixed = 0;
  let walletUpdated = 0;

  for (const user of users) {
    if (user.id === BONUS_MARKER) continue;

    const profile = (user.profile as any) || {};
    const currentRep = typeof profile.reputation === "number" ? profile.reputation : 0;

    // Fix reputation if below floor
    if (currentRep < REP_FLOOR) {
      await db
        .update(usersTable)
        .set({ profile: { ...profile, reputation: REP_FLOOR } })
        .where(sql`${usersTable.id} = ${user.id}`);
      repFixed++;
    }

    // Add 50k to wallet (upsert: create if not exists, add to existing)
    await db
      .insert(walletBalancesTable)
      .values({ userId: user.id, balance: BONUS_AMOUNT })
      .onConflictDoUpdate({
        target: walletBalancesTable.userId,
        set: { balance: sql`${walletBalancesTable.balance} + ${BONUS_AMOUNT}` },
      });
    walletUpdated++;
  }

  // Mark as done
  await db
    .insert(walletBalancesTable)
    .values({ userId: BONUS_MARKER, balance: 1 })
    .onConflictDoNothing();

  console.log(`[apology-bonus] Done — ${repFixed} reputations raised to ${REP_FLOOR}, ${walletUpdated} wallets credited ${BONUS_AMOUNT.toLocaleString()} coins.`);
}
