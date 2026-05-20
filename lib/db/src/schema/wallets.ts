import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const walletBalancesTable = pgTable("wallet_balances", {
  userId: text("user_id").primaryKey(),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
