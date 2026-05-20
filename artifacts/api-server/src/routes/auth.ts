import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, ilike, or, sql } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/** Strip raw base64 data URLs — they can be multiple MB each and destroy bandwidth in list responses. */
function safeAvatar(raw: unknown, fallback = "🎭"): string {
  if (!raw || typeof raw !== "string") return fallback;
  return raw.startsWith("data:") ? fallback : raw;
}

// ── In-memory cache for full users list (no-query, limit 200) ──
let _usersCache: { data: any; ts: number } | null = null;
const USERS_TTL_MS = 3 * 60 * 1000; // 3 minutes — reduces DB hits, user list rarely changes
export function bustUsersCache() { _usersCache = null; }
export function prewarmUsersCache(data: any) { _usersCache = { data, ts: Date.now() }; }

export async function runUsersPrewarm() {
  try {
    const rows = await db.select({
      id: usersTable.id,
      username: usersTable.username,
      profile: usersTable.profile,
    }).from(usersTable).limit(200);
    const users = rows.map((r) => ({
      id: r.id,
      username: r.username,
      profile: {
        pic: safeAvatar((r.profile as any)?.pic),
        tier: (r.profile as any)?.tier || "merit",
        covenant: (r.profile as any)?.covenant || "shadows",
        bio: (r.profile as any)?.bio || "",
        major: (r.profile as any)?.major || "Undeclared",
        followers: (r.profile as any)?.followers || 0,
        following: (r.profile as any)?.following || 0,
      },
    }));
    _usersCache = { data: { users }, ts: Date.now() };
  } catch {}
}

const router: IRouter = Router();

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function makeUserId(username: string): string {
  return username.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function deterministicFollowers(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) { h = Math.imul(31, h) + username.charCodeAt(i) | 0; }
  return 800 + Math.abs(h % 1200);
}

function deterministicFollowing(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) { h = Math.imul(37, h) + username.charCodeAt(i) | 0; }
  return 20 + Math.abs(h % 150);
}

router.post("/auth/signup", async (req, res) => {
  try {
    const { username, password, profile } = req.body ?? {};
    if (!username?.trim() || !password?.trim()) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const cleanUsername = username.trim().toLowerCase().replace(/\s+/g, "_");
    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: "Username must be at least 3 characters." });
    }

    const existing = await db.select().from(usersTable).where(eq(usersTable.username, cleanUsername)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "Username already taken." });
    }

    const salt = randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password.trim(), salt);
    const id = makeUserId(cleanUsername);
    const token = generateToken();

    const [user] = await db.insert(usersTable).values({
      id,
      username: cleanUsername,
      passwordHash,
      salt,
      profile: {
        followers: deterministicFollowers(cleanUsername),
        following: deterministicFollowing(cleanUsername),
        ...(profile && typeof profile === "object" ? profile : {}),
      },
    }).returning();

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        profile: user.profile,
        createdAt: user.createdAt,
      },
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Username already taken." });
    }
    return res.status(500).json({ error: "Signup failed. Please try again." });
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username?.trim() || !password?.trim()) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const rawUsername = username.trim();
    const cleanUsername = rawUsername.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

    // Search by id (always lowercase), exact username (original case), lowercase username, and case-insensitive
    const [user] = await db.select().from(usersTable).where(
      or(
        eq(usersTable.id, cleanUsername),
        eq(usersTable.username, rawUsername),
        eq(usersTable.username, cleanUsername),
        ilike(usersTable.username, rawUsername),
      )
    ).limit(1);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    let passwordMatch = false;
    try {
      const hash = hashPassword(password.trim(), user.salt || "");
      const hashBuf = Buffer.from(hash, "hex");
      const storedBuf = Buffer.from(user.passwordHash || "", "hex");
      if (hashBuf.length > 0 && hashBuf.length === storedBuf.length) {
        passwordMatch = timingSafeEqual(hashBuf, storedBuf);
      }
    } catch { passwordMatch = false; }

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const token = generateToken();

    const lp = (user.profile as any) || {};
    return res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        profile: {
          ...lp,
          followers: lp.followers || deterministicFollowers(user.username),
          following: lp.following || deterministicFollowing(user.username),
        },
        createdAt: user.createdAt,
      },
    });
  } catch {
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ── PUT /api/auth/profile ── update user profile fields (traits, bio, pic…) ─
// Upserts: if userId doesn't exist in DB (e.g. NPC accounts), creates a minimal record
router.put("/auth/profile", async (req, res) => {
  try {
    const { userId, traits, bio, pic, cover, year, major, wealth, rep, covenant, tier, trentMemory } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: "userId required" });

    const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);

    if (!existing) {
      // Upsert: create a minimal DB record for NPC / legacy accounts so profile pics persist cross-device
      const profile: Record<string, any> = {};
      if (traits !== undefined) profile.traits = traits;
      if (bio !== undefined) profile.bio = bio;
      if (pic !== undefined) profile.pic = pic;
      if (cover !== undefined) profile.cover = cover;
      if (year !== undefined) profile.year = year;
      if (major !== undefined) profile.major = major;
      if (wealth !== undefined) profile.wealth = wealth;
      if (rep !== undefined) profile.rep = rep;
      if (covenant !== undefined) profile.covenant = covenant;
      if (tier !== undefined) profile.tier = tier;
      if (trentMemory !== undefined) profile.trentMemory = trentMemory;
      await db.insert(usersTable).values({
        id: userId,
        username: userId,
        passwordHash: "npc",
        salt: "npc",
        profile,
      });
      return res.json({ success: true, profile });
    }

    const current = (existing.profile as Record<string, any>) || {};
    const updated: Record<string, any> = { ...current };
    if (traits !== undefined) updated.traits = traits;
    if (bio !== undefined) updated.bio = bio;
    if (pic !== undefined) updated.pic = pic;
    if (cover !== undefined) updated.cover = cover;
    if (year !== undefined) updated.year = year;
    if (major !== undefined) updated.major = major;
    if (wealth !== undefined) updated.wealth = wealth;
    if (rep !== undefined) updated.rep = rep;
    if (covenant !== undefined) updated.covenant = covenant;
    if (tier !== undefined) updated.tier = tier;
    if (trentMemory !== undefined) updated.trentMemory = trentMemory;

    await db.update(usersTable).set({ profile: updated }).where(eq(usersTable.id, userId));
    return res.json({ success: true, profile: updated });
  } catch {
    return res.status(500).json({ error: "Profile update failed" });
  }
});

// ── GET /api/auth/profile/:userId ── fetch public profile of a real user ────
router.get("/auth/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const p = (user.profile as any) || {};
    return res.json({
      id: user.id,
      username: user.username,
      profile: {
        ...p,
        followers: p.followers || deterministicFollowers(user.username),
        following: p.following || deterministicFollowing(user.username),
      },
    });
  } catch {
    return res.status(500).json({ error: "Profile fetch failed" });
  }
});

// ── GET /api/users?q=query&limit=N ── search users by username ─────────────
router.get("/users", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const limitN = Math.min(parseInt(String(req.query.limit || "20"), 10) || 20, 200);

    // Serve from cache for the most common "list all" call (no query, limit ≥ 200)
    if (!q && limitN >= 200 && _usersCache && Date.now() - _usersCache.ts < USERS_TTL_MS) {
      return res.json(_usersCache.data);
    }

    const baseQuery = db.select({
      id: usersTable.id,
      username: usersTable.username,
      profile: usersTable.profile,
    }).from(usersTable);
    const rows = q.length >= 1
      ? await baseQuery.where(ilike(usersTable.username, `%${q}%`)).limit(limitN)
      : await baseQuery.limit(limitN);
    const users = rows.map((r) => ({
      id: r.id,
      username: r.username,
      profile: {
        pic: safeAvatar((r.profile as any)?.pic),
        tier: (r.profile as any)?.tier || "merit",
        covenant: (r.profile as any)?.covenant || "shadows",
        bio: (r.profile as any)?.bio || "",
        major: (r.profile as any)?.major || "Undeclared",
        followers: (r.profile as any)?.followers || deterministicFollowers(r.username),
        following: (r.profile as any)?.following || deterministicFollowing(r.username),
      },
    }));
    const payload = { users };
    // Cache the full list for fast subsequent calls
    if (!q && limitN >= 200) _usersCache = { data: payload, ts: Date.now() };
    return res.json(payload);
  } catch (err) {
    console.error("/api/users error:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

export default router;
