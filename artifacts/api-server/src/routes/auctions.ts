import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { auctionsTable, auctionBidsTable, usersTable } from "@workspace/db";
import { eq, desc, and, or, lt, gt } from "drizzle-orm";

const router = Router();

// ── Auto-close expired auctions and reward highest bidder ─────────────────────
async function closeExpiredAuctions() {
  try {
    const now = new Date();
    const expired = await db
      .select()
      .from(auctionsTable)
      .where(and(eq(auctionsTable.status, "active"), lt(auctionsTable.endsAt, now)));

    for (const auction of expired) {
      await db
        .update(auctionsTable)
        .set({ status: "completed" })
        .where(eq(auctionsTable.id, auction.id));

      // If there was a highest bidder, boost their reputation in their profile
      if (auction.highestBidderId) {
        const winner = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, auction.highestBidderId))
          .limit(1);
        if (winner[0]) {
          const profile = (winner[0].profile || {}) as Record<string, any>;
          const currentRep = profile.reputation || 0;
          const repGain = Math.floor((auction.currentBid / 1000) * 10) + 50; // 50 base + bid-scaled bonus
          await db
            .update(usersTable)
            .set({ profile: { ...profile, reputation: currentRep + repGain } })
            .where(eq(usersTable.id, auction.highestBidderId));
        }
      }
    }
  } catch {}
}

// ── GET /api/auctions — list active auctions (auto-closes expired) ─────────
router.get("/auctions", async (req: Request, res: Response) => {
  try {
    await closeExpiredAuctions();
    const auctions = await db
      .select()
      .from(auctionsTable)
      .where(eq(auctionsTable.status, "active"))
      .orderBy(desc(auctionsTable.createdAt));
    res.json({ auctions });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch auctions" });
  }
});

// ── GET /api/auctions/history — all completed auctions ────────────────────
router.get("/auctions/history", async (req: Request, res: Response) => {
  try {
    const auctions = await db
      .select()
      .from(auctionsTable)
      .where(eq(auctionsTable.status, "completed"))
      .orderBy(desc(auctionsTable.createdAt))
      .limit(100);
    res.json({ auctions });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ── GET /api/auctions/user/:userId — get active auction for a specific user ──
router.get("/auctions/user/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const auction = await db
      .select()
      .from(auctionsTable)
      .where(and(eq(auctionsTable.subjectId, userId), eq(auctionsTable.status, "active")))
      .limit(1);
    res.json({ auction: auction[0] || null });
  } catch (err) {
    res.status(500).json({ error: "Failed to check auction status" });
  }
});

// ── GET /api/auctions/:id/bids — bid history for an auction ───────────────
router.get("/auctions/:id/bids", async (req: Request, res: Response) => {
  try {
    const bids = await db
      .select()
      .from(auctionBidsTable)
      .where(eq(auctionBidsTable.auctionId, req.params.id))
      .orderBy(desc(auctionBidsTable.createdAt));
    res.json({ bids });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch bids" });
  }
});

// ── POST /api/auctions — create a new auction ─────────────────────────────
router.post("/auctions", async (req: Request, res: Response) => {
  try {
    const {
      subjectId, subjectType, subjectName, subjectAvatar,
      subjectData, reason, startingBid,
    } = req.body;

    if (!subjectId || !subjectType || !subjectName) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    // Check if there's already an active auction for this subject
    const existing = await db
      .select()
      .from(auctionsTable)
      .where(and(eq(auctionsTable.subjectId, subjectId), eq(auctionsTable.status, "active")))
      .limit(1);

    if (existing[0]) {
      res.json({ auction: existing[0], existed: true });
      return;
    }

    const id = `auc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date();
    const endsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h from now

    const [auction] = await db
      .insert(auctionsTable)
      .values({
        id,
        subjectId,
        subjectType: subjectType || "user",
        subjectName,
        subjectAvatar: subjectAvatar || "🌑",
        subjectData: subjectData || {},
        status: "active",
        reason: reason || "financial",
        startedAt: now,
        endsAt,
        startingBid: startingBid || 500,
        currentBid: 0,
        bidCount: 0,
      })
      .returning();

    res.json({ auction });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create auction" });
  }
});

// ── POST /api/auctions/:id/bid — place a bid ──────────────────────────────
router.post("/auctions/:id/bid", async (req: Request, res: Response) => {
  try {
    const { bidderId, bidderName, bidderCov, amount } = req.body;

    if (!bidderId || !amount) {
      res.status(400).json({ error: "Missing bidder or amount" });
      return;
    }

    const [auction] = await db
      .select()
      .from(auctionsTable)
      .where(eq(auctionsTable.id, req.params.id))
      .limit(1);

    if (!auction) {
      res.status(404).json({ error: "Auction not found" });
      return;
    }
    if (auction.status !== "active") {
      res.status(400).json({ error: "Auction has closed" });
      return;
    }
    if (new Date() > auction.endsAt) {
      res.status(400).json({ error: "Auction has expired" });
      return;
    }
    if (bidderId === auction.subjectId) {
      res.status(400).json({ error: "Cannot bid on yourself" });
      return;
    }

    const minBid = Math.max(auction.currentBid + 1, auction.startingBid);
    if (amount < minBid) {
      res.status(400).json({ error: `Minimum bid is ₦${minBid.toLocaleString()}` });
      return;
    }

    // Record the bid
    const bidId = `bid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.insert(auctionBidsTable).values({
      id: bidId,
      auctionId: auction.id,
      bidderId,
      bidderName,
      bidderCov: bidderCov || "shadows",
      amount,
    });

    // Update the auction
    await db
      .update(auctionsTable)
      .set({
        currentBid: amount,
        highestBidderId: bidderId,
        highestBidderName: bidderName,
        highestBidderCov: bidderCov || "shadows",
        bidCount: (auction.bidCount || 0) + 1,
      })
      .where(eq(auctionsTable.id, auction.id));

    const updated = await db
      .select()
      .from(auctionsTable)
      .where(eq(auctionsTable.id, auction.id))
      .limit(1);

    res.json({ ok: true, auction: updated[0] });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to place bid" });
  }
});

export default router;
