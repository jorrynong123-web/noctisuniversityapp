import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { messagesTable } from "@workspace/db";
import { or, eq, and, asc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/messages/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const msgs = await db
      .select()
      .from(messagesTable)
      .where(or(eq(messagesTable.fromId, userId), eq(messagesTable.toId, userId)))
      .orderBy(asc(messagesTable.createdAt))
      .limit(500);
    res.json({ messages: msgs });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch messages");
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

router.post("/messages", async (req, res) => {
  try {
    const { fromId, fromUsername, fromPic, toId, toUsername, text, imageUrl } = req.body;
    if (!fromId || !fromUsername || !toId || !toUsername || !text) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [msg] = await db
      .insert(messagesTable)
      .values({ id, fromId, fromUsername, fromPic: fromPic || "🌑", toId, toUsername, text, imageUrl: imageUrl || null })
      .returning();
    res.status(201).json({ message: msg });
  } catch (err) {
    req.log.error({ err }, "Failed to send message");
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
