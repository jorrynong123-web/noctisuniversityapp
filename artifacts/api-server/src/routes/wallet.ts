import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { walletBalancesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/wallet/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const rows = await db.select().from(walletBalancesTable).where(eq(walletBalancesTable.userId, userId));
    if (rows.length === 0) {
      res.json({ balance: null });
      return;
    }
    res.json({ balance: rows[0].balance });
  } catch (err) {
    req.log.error({ err }, "wallet get error");
    res.status(500).json({ error: "Failed to get wallet" });
  }
});

router.post("/wallet/set", async (req: Request, res: Response) => {
  try {
    const { userId, balance } = req.body;
    if (!userId || balance === undefined || balance === null) {
      res.status(400).json({ error: "userId and balance required" });
      return;
    }
    await db
      .insert(walletBalancesTable)
      .values({ userId, balance: Math.floor(balance), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: walletBalancesTable.userId,
        set: { balance: Math.floor(balance), updatedAt: new Date() },
      });
    res.json({ ok: true, balance: Math.floor(balance) });
  } catch (err) {
    req.log.error({ err }, "wallet set error");
    res.status(500).json({ error: "Failed to set wallet" });
  }
});

router.post("/wallet/transfer", async (req: Request, res: Response) => {
  try {
    const { fromId, toId, amount, fromBalance } = req.body;
    if (!fromId || !toId || !amount || fromBalance === undefined) {
      res.status(400).json({ error: "fromId, toId, amount, fromBalance required" });
      return;
    }
    const amt = Math.floor(amount);
    if (amt <= 0) {
      res.status(400).json({ error: "Amount must be positive" });
      return;
    }

    const toRows = await db.select().from(walletBalancesTable).where(eq(walletBalancesTable.userId, toId));
    const toCurrentBal = toRows.length > 0 ? toRows[0].balance : 0;

    await db
      .insert(walletBalancesTable)
      .values({ userId: fromId, balance: Math.floor(fromBalance), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: walletBalancesTable.userId,
        set: { balance: Math.floor(fromBalance), updatedAt: new Date() },
      });

    await db
      .insert(walletBalancesTable)
      .values({ userId: toId, balance: toCurrentBal + amt, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: walletBalancesTable.userId,
        set: { balance: toCurrentBal + amt, updatedAt: new Date() },
      });

    res.json({ ok: true, toBalance: toCurrentBal + amt });
  } catch (err) {
    req.log.error({ err }, "wallet transfer error");
    res.status(500).json({ error: "Failed to transfer" });
  }
});

export default router;
