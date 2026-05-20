import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { postsTable, commentsTable, usersTable } from "@workspace/db";
import { eq, desc, sql, inArray } from "drizzle-orm";

const router: IRouter = Router();

/** Strip base64 data URLs from pic/avatar fields before sending in API responses.
 *  Base64 images can be 1–7 MB each; sending them on every poll destroys bandwidth.
 *  Keeps URL-based paths (e.g. /api/storage/...) and emoji strings intact. */
function safeAvatar(raw: unknown, fallback = "🌑"): string {
  if (!raw || typeof raw !== "string") return fallback;
  if (raw.startsWith("data:")) {
    // It's a base64 data URL — too large to send in list endpoints
    return fallback;
  }
  return raw;
}

// In-memory posts cache — avoids slow sequential DB hits on every refresh
let _postsCache: { data: any; ts: number } | null = null;
const POSTS_TTL_MS = 3 * 60 * 1000; // 3 minutes — reduces compute, posts don't change that fast

router.get("/posts", async (req, res) => {
  try {
    if (_postsCache && Date.now() - _postsCache.ts < POSTS_TTL_MS) {
      return res.json(_postsCache.data);
    }

    // Run posts + comments in parallel (user lookup depends on post results)
    const [posts, comments] = await Promise.all([
      db.select().from(postsTable).orderBy(desc(postsTable.createdAt)).limit(200),
      db.select().from(commentsTable).orderBy(commentsTable.createdAt),
    ]);

    // Fetch current profile data for real (DB) users so we always return their latest pic/name
    const realUserIds = [...new Set(posts.map((p) => p.userId))].filter(Boolean);
    const userRows = realUserIds.length > 0
      ? await db.select({ id: usersTable.id, username: usersTable.username, profile: usersTable.profile })
          .from(usersTable).where(inArray(usersTable.id, realUserIds))
      : [];
    const userMap: Record<string, { username: string; pic?: string }> = {};
    for (const u of userRows) {
      const profile = (u.profile as Record<string, any>) || {};
      userMap[u.id] = { username: u.username, pic: safeAvatar(profile.pic) };
    }

    const commentsByPost: Record<string, typeof comments> = {};
    for (const c of comments) {
      if (!commentsByPost[c.postId]) commentsByPost[c.postId] = [];
      commentsByPost[c.postId].push(c);
    }

    const result = posts.map((p) => {
      const u = userMap[p.userId];
      return {
        ...p,
        // Override with current DB values if they exist (profile pic may have changed since post was made)
        username: u?.username || p.username,
        pic: u?.pic || safeAvatar(p.pic as string),
        comments: commentsByPost[p.id] || [],
      };
    });

    const payload = { posts: result };
    _postsCache = { data: payload, ts: Date.now() };
    // Invalidate posts cache when a new post is written (handled in POST /posts)
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch posts");
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

router.post("/posts", async (req, res) => {
  try {
    const { id, userId, username, pic, covenant, tier, content, image, likes, skulls, flames, autoComments } = req.body;
    if (!userId || !username || !content?.trim()) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    const postId = id || `p${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const [post] = await db
      .insert(postsTable)
      .values({
        id: postId,
        userId,
        username,
        pic: pic || "🌑",
        covenant: covenant || "shadows",
        tier: tier || "commoner",
        content: content.trim(),
        image: image || null,
        likes: typeof likes === "number" ? likes : 0,
        skulls: typeof skulls === "number" ? skulls : 0,
        flames: typeof flames === "number" ? flames : 0,
      })
      .onConflictDoNothing()
      .returning();

    if (Array.isArray(autoComments) && autoComments.length > 0) {
      const rows = autoComments.map((c: any) => ({
        id: c.id || `ac_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        postId,
        parentId: null,
        userId: c.userId || "auto",
        username: c.un || c.username || "Anonymous",
        text: c.t || c.text || "",
      })).filter((r: any) => r.text.trim());
      if (rows.length > 0) {
        await db.insert(commentsTable).values(rows).onConflictDoNothing();
      }
    }

    _postsCache = null; // Bust cache so next GET returns fresh data with new post
    res.status(201).json({ post });
  } catch (err) {
    req.log.error({ err }, "Failed to create post");
    res.status(500).json({ error: "Failed to create post" });
  }
});

router.post("/posts/:id/comments", async (req, res) => {
  try {
    const { id: postId } = req.params;
    const { id, userId, username, text, parentId } = req.body;
    if (!userId || !username || !text?.trim()) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    const commentId = id || `c${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const [comment] = await db
      .insert(commentsTable)
      .values({
        id: commentId,
        postId,
        parentId: parentId || null,
        userId,
        username,
        text: text.trim(),
      })
      .onConflictDoNothing()
      .returning();

    _postsCache = null; // Bust cache so comment appears immediately on next fetch
    res.status(201).json({ comment });
  } catch (err) {
    req.log.error({ err }, "Failed to create comment");
    res.status(500).json({ error: "Failed to create comment" });
  }
});

router.post("/posts/:id/react", async (req, res) => {
  try {
    const { id: postId } = req.params;
    const { emoji } = req.body;
    if (emoji === "💀") {
      await db.update(postsTable).set({ skulls: sql`${postsTable.skulls} + 1` }).where(eq(postsTable.id, postId));
    } else if (emoji === "🔥") {
      await db.update(postsTable).set({ flames: sql`${postsTable.flames} + 1` }).where(eq(postsTable.id, postId));
    } else {
      await db.update(postsTable).set({ likes: sql`${postsTable.likes} + 1` }).where(eq(postsTable.id, postId));
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to react");
    res.status(500).json({ error: "Failed to react" });
  }
});

router.delete("/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(postsTable).where(eq(postsTable.id, id));
    await db.delete(commentsTable).where(eq(commentsTable.postId, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete post");
    res.status(500).json({ error: "Failed to delete post" });
  }
});

router.delete("/posts/:postId/comments/:commentId", async (req, res) => {
  try {
    const { commentId } = req.params;
    await db.delete(commentsTable).where(eq(commentsTable.id, commentId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete comment");
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// ── GET /api/leaderboard — real-time leaderboard ─────────────────────────────
// In-memory cache — avoids hammering the DB on rapid refreshes
// Stores pre-serialized JSON to eliminate repeated stringify overhead
let _lbCache: { json: string; ts: number } | null = null;
const LB_TTL_MS = 5 * 60 * 1000; // 5 minutes — leaderboard shifts slowly, cache longer to cut compute

router.get("/leaderboard", async (req, res) => {
  try {
    // Serve from cache if fresh — send raw string to skip re-serialization
    if (_lbCache && Date.now() - _lbCache.ts < LB_TTL_MS) {
      return res.type("application/json").send(_lbCache.json);
    }

    // Run all three queries in parallel instead of sequentially
    const [users, postCounts, commentCounts] = await Promise.all([
      db.select().from(usersTable),
      db.select({ userId: postsTable.userId, count: sql<number>`cast(count(*) as int)` })
        .from(postsTable).groupBy(postsTable.userId),
      db.select({ userId: commentsTable.userId, count: sql<number>`cast(count(*) as int)` })
        .from(commentsTable).groupBy(commentsTable.userId),
    ]);

    const postMap = Object.fromEntries(postCounts.map(p => [p.userId, p.count]));
    const commentMap = Object.fromEntries(commentCounts.map(c => [c.userId, c.count]));

    const leaderboard = users.map(u => {
      const profile = (u.profile || {}) as Record<string, any>;
      const posts = postMap[u.id] || 0;
      const comments = commentMap[u.id] || 0;
      const profileReputation = profile.reputation ?? 0;
      const profileWealth = profile.wealth ?? 50000;
      const profileXp = profile.xp ?? 0;
      const reputation = profileReputation + posts * 10 + comments * 3;
      return {
        id: u.id,
        username: profile.username || u.username,
        avatar: safeAvatar(profile.pic) || safeAvatar(profile.avatar) || "🌑",
        covenant: profile.cov || profile.covenant || "shadows",
        tier: profile.tier || "merit",
        major: profile.major || "Undeclared",
        posts,
        comments,
        reputation,
        wealth: profileWealth,
        xp: profileXp,
        joinedAt: u.createdAt,
      };
    });

    leaderboard.sort((a, b) => b.reputation - a.reputation);

    const json = JSON.stringify({ leaderboard, updatedAt: new Date().toISOString() });
    _lbCache = { json, ts: Date.now() };
    res.type("application/json").send(json);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch leaderboard");
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// ── PATCH /api/users/:id/profile — update user profile fields ─────────────────
router.patch("/users/:id/profile", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    // Upsert: create a stub row for hardcoded accounts that don't have a DB row yet,
    // then merge the profile fields (wealth, reputation, xp, etc.)
    const existing = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!existing[0]) {
      // Insert a stub so we can track stats for hardcoded ACCTS users
      await db.insert(usersTable).values({
        id,
        username: updates.username || id,
        passwordHash: "__hardcoded__",
        salt: "__hardcoded__",
        profile: updates,
      }).onConflictDoNothing();
      _lbCache = null; // Bust so new user appears on leaderboard immediately
      res.json({ ok: true, profile: updates });
      return;
    }
    const currentProfile = (existing[0].profile || {}) as Record<string, any>;
    const merged = { ...currentProfile, ...updates };

    // CRITICAL: Never allow progress to go backwards via a blank-device sync.
    // reputation and xp can only ever increase (they're cumulative scores).
    // If the incoming value is lower than what we already have, keep the higher one.
    const safeMax = (field: string) => {
      const cur = typeof currentProfile[field] === "number" ? currentProfile[field] : 0;
      const inc = typeof updates[field] === "number" ? updates[field] : null;
      if (inc === null || inc === undefined) return; // field not sent — keep existing
      if (inc < cur) merged[field] = cur; // never decrease
    };
    safeMax("reputation");
    safeMax("xp");
    // Also ensure rep/xp never go below 100 (the floor)
    if (typeof merged.reputation === "number" && merged.reputation < 100) merged.reputation = 100;

    _lbCache = null; // Bust leaderboard cache so rankings update immediately
    await db.update(usersTable).set({ profile: merged }).where(eq(usersTable.id, id));
    res.json({ ok: true, profile: merged });
  } catch (err) {
    req.log.error({ err }, "Failed to update profile");
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ── Cache pre-warmer — call once at server startup so first user never waits ──
export async function prewarmCaches() {
  try {
    const [posts, comments] = await Promise.all([
      db.select().from(postsTable).orderBy(desc(postsTable.createdAt)).limit(200),
      db.select().from(commentsTable).orderBy(commentsTable.createdAt),
    ]);
    const realUserIds = [...new Set(posts.map((p) => p.userId))].filter(Boolean);
    const userRows = realUserIds.length > 0
      ? await db.select({ id: usersTable.id, username: usersTable.username, profile: usersTable.profile })
          .from(usersTable).where(inArray(usersTable.id, realUserIds))
      : [];
    const userMap: Record<string, { username: string; pic?: string }> = {};
    for (const u of userRows) {
      const p = (u.profile as Record<string, any>) || {};
      userMap[u.id] = { username: u.username, pic: p.pic };
    }
    const commentsByPost: Record<string, any[]> = {};
    for (const c of comments) {
      if (!commentsByPost[c.postId]) commentsByPost[c.postId] = [];
      commentsByPost[c.postId].push(c);
    }
    const result = posts.map((p) => {
      const u = userMap[p.userId];
      return { ...p, username: u?.username || p.username, pic: u?.pic || p.pic, comments: commentsByPost[p.id] || [] };
    });
    _postsCache = { data: { posts: result }, ts: Date.now() };
  } catch {}

  try {
    const [users, postCounts, commentCounts] = await Promise.all([
      db.select().from(usersTable),
      db.select({ userId: postsTable.userId, count: sql<number>`cast(count(*) as int)` })
        .from(postsTable).groupBy(postsTable.userId),
      db.select({ userId: commentsTable.userId, count: sql<number>`cast(count(*) as int)` })
        .from(commentsTable).groupBy(commentsTable.userId),
    ]);
    const postMap = Object.fromEntries(postCounts.map(p => [p.userId, p.count]));
    const commentMap = Object.fromEntries(commentCounts.map(c => [c.userId, c.count]));
    const leaderboard = users.map(u => {
      const profile = (u.profile || {}) as Record<string, any>;
      const posts2 = postMap[u.id] || 0;
      const comments2 = commentMap[u.id] || 0;
      return {
        id: u.id,
        username: profile.username || u.username,
        avatar: safeAvatar(profile.pic) || safeAvatar(profile.avatar) || "🌑",
        covenant: profile.cov || profile.covenant || "shadows",
        tier: profile.tier || "merit",
        major: profile.major || "Undeclared",
        posts: posts2,
        comments: comments2,
        reputation: (profile.reputation ?? 0) + posts2 * 10 + comments2 * 3,
        wealth: profile.wealth ?? 50000,
        xp: profile.xp ?? 0,
        joinedAt: u.createdAt,
      };
    });
    leaderboard.sort((a, b) => b.reputation - a.reputation);
    _lbCache = { json: JSON.stringify({ leaderboard, updatedAt: new Date().toISOString() }), ts: Date.now() };
  } catch {}
}

export default router;
