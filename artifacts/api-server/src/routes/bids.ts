import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { bidsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/bids", async (req, res) => {
  try {
    const bids = await db
      .select()
      .from(bidsTable)
      .orderBy(desc(bidsTable.createdAt))
      .limit(100);

    const topBid = bids.length > 0 ? bids[0].amount : 34500;
    res.json({ bids, topBid, count: bids.length });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch bids");
    res.status(500).json({ error: "Failed to fetch bids" });
  }
});

router.post("/bids", async (req, res) => {
  try {
    const { userId, username, amount, lotId, lotName } = req.body;
    if (!userId || !username || !amount || !lotId || !lotName) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const id = `bid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [bid] = await db
      .insert(bidsTable)
      .values({ id, userId, username, amount, lotId, lotName })
      .returning();
    res.status(201).json({ bid });
  } catch (err) {
    req.log.error({ err }, "Failed to place bid");
    res.status(500).json({ error: "Failed to place bid" });
  }
});

export default router;
