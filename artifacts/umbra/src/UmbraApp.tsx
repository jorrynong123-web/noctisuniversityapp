import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  memo,
  createContext,
  useContext,
  startTransition,
} from "react";

// ── Data imports (extracted from UmbraApp for maintainability) ──────────────
import { ACCTS, STUDENTS, MAJORS_LIST, npcHash, npcReputation, npcWealth, npcXp } from "./data/students";
import { CLASSES } from "./data/classes";
import { PROFILE_TAGS, XP_LEVELS, getXPLevel } from "./data/xpData";
import { CLUBS, CHAMPS, HOTTEST_CATS } from "./data/clubs";
import { PROFS } from "./data/profs";
import { LOTS, INIT_CONFS, PARTIES, TWISTED, LIVES, QNA_INIT, ANNOUNCEMENTS, RELIEF_ROOMS, QUIZ, TIER_QUIZ, INIT_POSTS } from "./data/npcData";
import { SHOP_ITEMS, DAILY_DEALS, FLASH_SALES, PORTAL_LISTINGS, TRENT_REL_LEVELS, TRENT_REPLIES_L0, TRENT_REPLIES_L1, TRENT_REPLIES_L2, TRENT_REPLIES_L3, TRENT_REPLIES_L4, TRENT_REPLIES_L5, TRENT_GIFT_REPLIES, TRENT_PIC_REPLIES, CYRUS_REL_LEVELS, CYRUS_REPLIES_L0, CYRUS_REPLIES_L1, CYRUS_REPLIES_L2, CYRUS_REPLIES_L3, CYRUS_REPLIES_L4, CYRUS_REPLIES_L5, CYRUS_GIFT_REPLIES, CYRUS_PIC_REPLIES } from "./data/shopAndTrent";
import { AUTO_C, AUTO_UN, NPC_COMMENTERS, UNSPLASH_PLACEHOLDERS } from "./data/feedData";
import { supabase } from "./lib/supabase";
import { callLLM, getStoredCreds, buildNPCPrompt, buildProfPrompt, buildNPCPostPrompt, testLLMConnection } from "./lib/ai";

// ─── SUPABASE + AI SHIM ──────────────────────────────────────────────────────
// Intercepts all /api/* fetch calls and handles them with localStorage so the
// app runs completely standalone — no backend, no Vercel, no Railway needed.
// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
function _ls<T>(key: string, def: T): T {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? def; } catch { return def; }
}
function _lsSet(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function _apiOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function _apiErr(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json" } });
}

// ─── AI route handler (LLM-powered, template fallback) ───────────────────────
async function _handleAIRoute(sub: string, body: Record<string, unknown>): Promise<Response> {
  // Prefer credentials passed inline from the frontend (user's own API key from Settings)
  // over the stored fallback. This lets every NPC use the user's configured engine.
  const inlineCreds = (body.userApiBase && body.userApiKey && body.userModel)
    ? { apiBase: body.userApiBase as string, apiKey: body.userApiKey as string, model: body.userModel as string }
    : null;
  const creds = inlineCreds || getStoredCreds();

  if (sub === "npc-reply" || sub === "npc-initiate" || sub === "worship-dm" || sub === "prof-dm") {
    const isProfDM = sub === "prof-dm";
    const npc = (isProfDM ? body.profProfile : body.npcProfile) as any;
    const npcId = (body.npcId as string) || npc?.id || "";
    const relLevel = Math.min((body.relLevel as number) ?? 0, 5);
    const username = (body.username as string) || "student";
    const trentMemory = (body.trentMemory as string) || "";
    // Accept both field names for compatibility (conversationHistory / history, message / userMessage)
    const history = Array.isArray(body.conversationHistory) ? (body.conversationHistory as any[])
                   : Array.isArray(body.history) ? (body.history as any[]) : [];
    const userMsg = (body.message as string) || (body.userMessage as string) || "";

    // Template fallback when no creds — use character-specific lines where available
    if (!creds) {
      let reply = "";
      if (npcId === "trent_morrison") {
        const pools = [TRENT_REPLIES_L0, TRENT_REPLIES_L1, TRENT_REPLIES_L2, TRENT_REPLIES_L3, TRENT_REPLIES_L4, TRENT_REPLIES_L5];
        const pool = pools[relLevel] || TRENT_REPLIES_L0;
        reply = pool[Math.floor(Math.random() * pool.length)] || "...";
      } else if (npcId === "cyrus_whitmore") {
        const pools = [CYRUS_REPLIES_L0, CYRUS_REPLIES_L1, CYRUS_REPLIES_L2, CYRUS_REPLIES_L3, CYRUS_REPLIES_L4, CYRUS_REPLIES_L5];
        const pool = pools[relLevel] || CYRUS_REPLIES_L0;
        reply = pool[Math.floor(Math.random() * pool.length)] || "...";
      } else if (isProfDM && Array.isArray(npc?.dms) && npc.dms.length > 0) {
        // Professors have a curated dms[] array — use it for in-character fallback
        reply = npc.dms[Math.floor(Math.random() * npc.dms.length)];
      } else if (Array.isArray(npc?.replies) && npc.replies.length > 0) {
        reply = npc.replies[Math.floor(Math.random() * npc.replies.length)];
      } else {
        const fallbacks = ["Interesting. Go on.", "I wasn't expecting that from you.", "There's more to this than you're saying.", "You always find a way to surprise me.", "Tonight is complicated. Let's talk another time.", "I've been thinking about what you said earlier.", "You know how this ends, right?", "Don't read into this. I'm just being polite."];
        reply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
      return _apiOk({ reply, message: reply });
    }
    // npc profile is required for building the prompt — fall back if missing
    if (!npc) {
      const fb = ["I'm unavailable right now.", "We'll speak another time.", "Not now.", "..."];
      const reply = fb[Math.floor(Math.random() * fb.length)];
      return _apiOk({ reply, message: reply });
    }

    const studentTier = (body.studentTier as string) || "";
    const studentCov = (body.studentCov as string) || "";
    const systemPrompt = isProfDM
      ? buildProfPrompt(npc, { username, studentTier, studentCov })
      : buildNPCPrompt(npc, { relLevel, trentMemory, username });

    const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
    ];
    for (const h of history.slice(-6)) {
      if (h.from === "user" || h.fromId !== npcId) {
        msgs.push({ role: "user", content: h.text || h.content || "" });
      } else {
        msgs.push({ role: "assistant", content: h.text || h.content || "" });
      }
    }
    if (userMsg) msgs.push({ role: "user", content: userMsg });

    let reply: string;
    try {
      reply = await callLLM(msgs, creds, { maxTokens: 200, temperature: 0.88 });
    } catch (llmErr: any) {
      const msg = llmErr?.message || String(llmErr ?? "unknown");
      console.error("[ai/" + sub + "] LLM call failed:", msg);
      // Surface the real error so users can fix their Settings instead of staring at "Not now."
      // The chat UI will display this as the NPC's "reply" so the user sees what's broken.
      return _apiOk({ reply: `[AI error: ${msg}]`, message: `[AI error: ${msg}]`, llmError: msg });
    }
    return _apiOk({ reply, message: reply });
  }

  if (sub === "npc-comment") {
    const npcs = (body.npcs as any[]) || [];
    // App sends postContent/postAuthor directly OR nested as body.post
    const postText = (body.postContent as string) || (body.post as any)?.content || (body.post as any)?.text || "";
    const postAuthor = (body.postAuthor as string) || "";
    if (!creds || npcs.length === 0) {
      return _apiOk({ comments: npcs.map(() => ({ text: AUTO_C[Math.floor(Math.random() * AUTO_C.length)] })) });
    }
    const comments = await Promise.all(
      npcs.slice(0, 4).map(async (npc: any) => {
        const msgs = [
          { role: "system" as const, content: buildNPCPrompt(npc) + "\nWrite ONE short reaction comment (1 sentence max) on this post. Output only the comment text, nothing else." },
          { role: "user" as const, content: postAuthor ? `Post by ${postAuthor}: "${postText}"` : `Post: "${postText}"` },
        ];
        const text = await callLLM(msgs, creds, { maxTokens: 60, temperature: 0.9 }).catch(
          () => AUTO_C[Math.floor(Math.random() * AUTO_C.length)]
        );
        return { text, username: npc.un };
      })
    );
    return _apiOk({ comments });
  }

  if (sub === "npc-memory") {
    const existing = (body.existingMemory as string) || "";
    const lastExchange = Array.isArray(body.lastExchange) ? (body.lastExchange as any[]) : [];
    const last = lastExchange.map((e: any) => e.text || e.content || "").join(" | ");
    return _apiOk({ memory: existing ? `${existing} | ${last}` : last });
  }

  // gossip/rumour — 503 triggers existing template fallback in the app
  if (sub === "gossip" || sub === "generate-rumour") return _apiErr("offline", 503);

  return _apiOk({ success: true, reply: "", snippets: [], comments: [], message: "" });
}

// ─── NPC post generation ──────────────────────────────────────────────────────
let _genPostsRunning = false;
// Template post phrases used when no API key is configured
const NPC_POST_TEMPLATES = [
  "Some of you were never meant to be here. We all see it.",
  "Power isn't taken. It's recognised.",
  "Tonight reminded me why I choose very few.",
  "There's a version of you that almost had what you wanted. Pity.",
  "The difference between us isn't talent. It's tolerance for discomfort.",
  "Not everyone in this room deserves to be in this room.",
  "You don't earn your seat at Noctis. You prove you deserve to keep it.",
  "Every mistake here has a price. Some of you are overdue.",
  "I don't compete. I arrive.",
  "The ones who talk the most about loyalty are always the first to leave.",
  "Some scores settle themselves if you're patient enough.",
  "There's nothing more dangerous than someone with nothing left to lose.",
  "Not a warning. An observation.",
  "The weak call it cruelty. I call it clarity.",
  "Standards exist for a reason. Not everyone meets them.",
];

async function _generateNPCPosts(creds?: ReturnType<typeof getStoredCreds>): Promise<any[]> {
  if (_genPostsRunning) return [];
  _genPostsRunning = true;
  try {
    // CRITICAL: only pick NPCs, never real users. Real users have _real / isReal set
    // by buildRealUser() — without this guard, signed-up players with Apex tier would
    // have AI-generated posts ghost-written under their name. They wouldn't be amused.
    const npcList = (Object.values(ACCTS) as any[]).filter(
      (u: any) => !u._real && !u.isReal && !u.isGuest && (u.autoReply || u.tier === "apex" || u.tier === "ascendant" || u.tier === "elite")
    );
    const picks: any[] = [];
    const used = new Set<string>();
    while (picks.length < 6 && picks.length < npcList.length) {
      const r = npcList[Math.floor(Math.random() * npcList.length)];
      if (r && !used.has(r.id)) { picks.push(r); used.add(r.id); }
    }
    const generated: any[] = [];
    for (const npc of picks) {
      let content: string;
      if (creds) {
        const msgs = [
          { role: "system" as const, content: buildNPCPostPrompt(npc) },
          { role: "user" as const, content: "Write your post now." },
        ];
        content = await callLLM(msgs, creds, { maxTokens: 120, temperature: 0.92 }).catch(
          () => NPC_POST_TEMPLATES[Math.floor(Math.random() * NPC_POST_TEMPLATES.length)]
        );
      } else {
        // No API key — use template posts so the feed stays populated
        content = NPC_POST_TEMPLATES[Math.floor(Math.random() * NPC_POST_TEMPLATES.length)];
      }
      const ts = new Date(Date.now() - Math.floor(Math.random() * 7200000)).toISOString();
      generated.push({
        id: `npc_post_${npc.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        user_id: npc.id, userId: npc.id,
        username: npc.un,
        content,
        pic: npc.pic || "🌑",
        covenant: npc.cov || "silk",
        tier: npc.tier || "commoner",
        likes: Math.floor(Math.random() * 40),
        skulls: Math.floor(Math.random() * 10),
        flames: Math.floor(Math.random() * 15),
        is_npc: true, isNpc: true,
        created_at: ts, createdAt: ts,
      });
    }
    return generated;
  } finally {
    _genPostsRunning = false;
  }
}

// ─── Supabase handler ─────────────────────────────────────────────────────────
async function _supabaseHandler(method: string, seg: string[], query: URLSearchParams, body: Record<string, unknown>): Promise<Response> {
  const sb = supabase!;

  // ── MESSAGES ──────────────────────────────────────────────────────────────
  if (seg[0] === "messages") {
    if (method === "GET" && seg[1]) {
      const uid = seg[1];
      const { data, error } = await sb.from("messages").select("*")
        .or(`from_id.eq.${uid},to_id.eq.${uid}`).order("created_at");
      if (error) return _apiErr(error.message);
      return _apiOk({ messages: (data || []).map((m: any) => ({ id: m.id, fromId: m.from_id, fromUsername: m.from_username, fromPic: m.from_pic, toId: m.to_id, toUsername: m.to_username, text: m.text, createdAt: m.created_at })) });
    }
    if (method === "POST") {
      const b = body as any;
      const msg = { id: b.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`, from_id: b.fromId, from_username: b.fromUsername, from_pic: b.fromPic || "🌑", to_id: b.toId, to_username: b.toUsername, text: b.text, created_at: new Date().toISOString() };
      const { error } = await sb.from("messages").insert(msg);
      if (error) return _apiErr(error.message);
      return _apiOk({ message: { ...msg, fromId: msg.from_id, toId: msg.to_id, fromUsername: msg.from_username, fromPic: msg.from_pic, toUsername: msg.to_username, createdAt: msg.created_at } });
    }
  }

  // ── POSTS ──────────────────────────────────────────────────────────────────
  if (seg[0] === "posts") {
    if (method === "GET" && !seg[1]) {
      // Single unified query — captures every post regardless of is_npc value.
      const { data: rawPosts, error: pErr } = await sb.from("posts").select("*").order("created_at", { ascending: false }).limit(300);
      if (pErr) return _apiErr(pErr.message);
      const shape = (p: any) => ({ id: p.id, userId: p.user_id, username: p.username, content: p.content, image: p.image, pic: p.pic, covenant: p.covenant, tier: p.tier, likes: p.likes || 0, skulls: p.skulls || 0, flames: p.flames || 0, isNpc: p.is_npc, createdAt: p.created_at });
      let posts = (rawPosts || []).map(shape);
      const npcPosts = posts.filter((p: any) => p.isNpc === true);
      const creds = getStoredCreds();
      // Generate NPC posts when: (a) the feed has fewer than 10 NPC posts, OR
      // (b) the most recent NPC post is older than 30 minutes — keeps the
      // community feeling alive even when no real users have posted lately.
      // _generateNPCPosts uses templates (FREE AI) when no API key is set,
      // so this works for every user regardless of their API key settings.
      const newestNpc = npcPosts[0];
      const newestNpcAge = newestNpc ? Date.now() - new Date(newestNpc.createdAt).getTime() : Infinity;
      const shouldGenerate = npcPosts.length < 10 || newestNpcAge > 30 * 60 * 1000;
      if (shouldGenerate) {
        const aiPosts = await _generateNPCPosts(creds ?? undefined);
        for (const p of aiPosts) {
          try { await sb.from("posts").insert({ id: p.id, user_id: p.user_id, username: p.username, content: p.content, pic: p.pic, covenant: p.covenant, tier: p.tier, likes: p.likes, skulls: p.skulls, flames: p.flames, is_npc: true, created_at: p.created_at }); } catch {}
          // Schedule NPC comments on each generated post (non-blocking, staggered delays).
          // Always schedule — _generateNPCComments has a template fallback when no creds, so
          // users without an API key still see reactions in the feed.
          setTimeout(() => _generateNPCComments(p.id, p.content, p.user_id, creds ?? null).catch((e) => console.error("[npc-comments]", e)), 3000 + Math.random() * 7000);
        }
        posts = [...aiPosts.map((p: any) => ({ ...p, userId: p.user_id, createdAt: p.created_at })), ...posts];
      } else if (posts.length === 0) {
        posts = (INIT_POSTS as any[]).map((p: any) => ({ ...p, userId: p.userId || p.user_id, covenant: p.covenant || p.cov, createdAt: p.createdAt || p.created_at }));
      }
      // Fetch all comments for these posts in a single query
      const postIds = posts.map((p: any) => p.id).filter(Boolean);
      if (postIds.length > 0) {
        const { data: commRows } = await sb.from("comments").select("id,post_id,user_id,username,text,parent_id,created_at").in("post_id", postIds).order("created_at");
        const byPost = new Map<string, any[]>();
        for (const c of commRows || []) {
          const list = byPost.get(c.post_id) || [];
          list.push({ id: c.id, userId: c.user_id, username: c.username, text: c.text, parentId: c.parent_id || null, createdAt: c.created_at });
          byPost.set(c.post_id, list);
        }
        posts = posts.map((p: any) => ({ ...p, comments: byPost.get(p.id) || [] }));
      }
      return _apiOk({ posts });
    }
    if (method === "POST" && !seg[1]) {
      const b = body as any;
      const post = { id: b.id || `post_${Date.now()}_${Math.random().toString(36).slice(2)}`, user_id: b.userId || b.user_id, username: b.username, content: b.content, image: b.image || null, pic: b.pic || "🌑", covenant: b.covenant || b.cov || "silk", tier: b.tier || "commoner", likes: 0, skulls: 0, flames: 0, is_npc: b.isNpc || false, created_at: new Date().toISOString() };
      const { error } = await sb.from("posts").insert(post);
      if (error) return _apiErr(error.message);
      return _apiOk({ post: { ...post, userId: post.user_id, createdAt: post.created_at } });
    }
    if (method === "PATCH" && seg[1]) {
      const b = body as any;
      const upd: any = {};
      if (b.likes !== undefined) upd.likes = b.likes;
      if (b.skulls !== undefined) upd.skulls = b.skulls;
      if (b.flames !== undefined) upd.flames = b.flames;
      await sb.from("posts").update(upd).eq("id", seg[1]);
      return _apiOk({ success: true });
    }
    if (method === "DELETE" && seg[1] && !seg[2]) {
      await sb.from("posts").delete().eq("id", seg[1]);
      return _apiOk({ success: true });
    }
    // ── COMMENTS on a post: /api/posts/:postId/comments[/:commentId] ──────────
    if (seg[1] && seg[2] === "comments") {
      if (method === "POST") {
        const b = body as any;
        const comment = {
          id: b.id || `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          post_id: seg[1],
          user_id: b.userId || b.user_id,
          username: b.username,
          text: b.text,
          parent_id: b.parentId || null,
          created_at: new Date().toISOString(),
        };
        try { await sb.from("comments").insert(comment); } catch {}
        return _apiOk({ comment: { ...comment, userId: comment.user_id, createdAt: comment.created_at } });
      }
      if (method === "DELETE" && seg[3]) {
        await sb.from("comments").delete().eq("id", seg[3]);
        return _apiOk({ success: true });
      }
      return _apiOk({ success: true });
    }
    return _apiOk({ success: true });
  }

  // ── USERS ──────────────────────────────────────────────────────────────────
  if (seg[0] === "users") {
    if (method === "GET" && !seg[1]) {
      const q = query.get("q") || "";
      // Generous cap — we want ALL real users to be visible cross-device so
      // people can find and DM each other globally.
      const limit = Math.min(parseInt(query.get("limit") || "2000"), 5000);
      const npcUsers = (Object.values(ACCTS) as any[])
        .filter((u: any) => !u.isGuest && u.un && (!q || u.un.toLowerCase().includes(q.toLowerCase())))
        .slice(0, limit)
        .map((u: any) => ({ id: u.id, username: u.un, followers: u.followers ?? 0, following: u.following ?? 0, profile: { pic: u.pic, bio: u.bio, covenant: u.cov, tier: u.tier, traits: u.traits || [] } }));
      let sbQ = sb.from("profiles").select("id,username,followers,following,pic,bio,cov,tier,traits");
      if (q) sbQ = (sbQ as any).ilike("username", `%${q}%`);
      const { data } = await (sbQ as any).limit(limit);
      const realUsers = (data || []).map((u: any) => ({ id: u.id, username: u.username, followers: u.followers || 0, following: u.following || 0, profile: { pic: u.pic, bio: u.bio, covenant: u.cov, tier: u.tier, traits: u.traits || [] } }));
      const seen = new Set(realUsers.map((u: any) => u.id));
      return _apiOk({ users: [...realUsers, ...npcUsers.filter((u: any) => !seen.has(u.id))].slice(0, limit) });
    }
    if (method === "PATCH" && seg[1] && seg[2] === "profile") {
      const b = body as any;
      const upd: any = {};
      ["pic","bio","cov","tier","traits","major","year","wealth","rep","followers","following"].forEach(k => { if (b[k] !== undefined) upd[k] = b[k]; });
      if (b.covenant !== undefined) upd.cov = b.covenant;
      await sb.from("profiles").update(upd).eq("id", seg[1]);
      if (ACCTS[seg[1]]) Object.assign(ACCTS[seg[1]], b);
      return _apiOk({ success: true });
    }
  }

  // ── AUTH ───────────────────────────────────────────────────────────────────
  if (seg[0] === "auth") {
    if (seg[1] === "signup" && method === "POST") {
      const t0 = Date.now();
      const { username, password, profile = {} } = body as any;
      // Cheap NPC-username check (synchronous, in-memory). DON'T do a Supabase
      // SELECT here for the duplicate check — the client already does a debounced
      // live check on the typing screen, and signUp() will fail with a clean
      // error if a duplicate slipped through. Saves one round-trip on the hot path.
      const npcTaken = (Object.values(ACCTS) as any[]).some((u: any) => u.un?.toLowerCase() === (username as string)?.toLowerCase());
      if (npcTaken) {
        const suffix = Math.floor(Math.random() * 900) + 100;
        return new Response(JSON.stringify({ error: "Username already taken.", suggestion: `${username}_${suffix}` }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      const fakeEmail = `${(username as string).toLowerCase().replace(/[^a-z0-9]/g, "_")}@noctis.local`;
      let userId: string | undefined;
      const { data: authData, error: authErr } = await sb.auth.signUp({ email: fakeEmail, password: password as string });
      if (authErr) {
        console.error("[signup] signUp error:", authErr.message);
        return _apiErr(`Signup error: ${authErr.message}`, 400);
      }
      if (authData.user?.id) {
        userId = authData.user.id;
      } else {
        // Auth user already exists — recover by signing in with same credentials
        const { data: siData, error: siErr } = await sb.auth.signInWithPassword({ email: fakeEmail, password: password as string });
        if (siErr || !siData.user?.id) {
          return _apiErr("Username is taken or credentials mismatch. Please try a different username.", 409);
        }
        userId = siData.user.id;
      }
      const prof: any = profile || {};
      const profileRow = { id: userId, username, pic: prof.pic || "🌑", bio: prof.bio || "", cov: prof.covenant || prof.cov || "silk", tier: prof.tier || "commoner", major: prof.major || "Undeclared", year: prof.year || "Freshman", wealth: prof.wealth || "Self-Made", rep: prof.rep || "New Arrival", followers: 0, following: 0, xp: 0, traits: [] };
      // Run profile + wallet upserts in parallel — they're independent inserts.
      // We MUST await profile (it's the authoritative existence record), but we
      // can fire the wallet upsert at the same time so they overlap on the wire.
      const [profResp] = await Promise.all([
        sb.from("profiles").upsert(profileRow, { onConflict: "id" }),
        sb.from("wallets").upsert({ user_id: userId, balance: 5000 }, { onConflict: "user_id" }).then(() => null, () => null),
      ]);
      if (profResp.error) {
        console.error("[signup] profile upsert error:", profResp.error.message);
        return _apiErr(`Profile save failed: ${profResp.error.message}`, 500);
      }
      console.log(`[signup] success in ${Date.now() - t0}ms, userId:`, userId);
      return _apiOk({ token: "supabase", user: { id: userId, username, profile: { ...profileRow, covenant: profileRow.cov } } });
    }
    if (seg[1] === "login" && method === "POST") {
      const { username, password } = body as any;
      const fakeEmail = `${(username as string).toLowerCase().replace(/[^a-z0-9]/g, "_")}@noctis.local`;
      console.log("[login] attempting signIn for:", fakeEmail);
      const { data: authData, error: authErr } = await sb.auth.signInWithPassword({ email: fakeEmail, password: password as string });
      if (authErr) {
        console.error("[login] signIn error:", authErr.message);
        const msg = authErr.message?.toLowerCase() || "";
        if (msg.includes("email not confirmed") || msg.includes("not confirmed")) {
          return _apiErr("Account not confirmed. Re-run schema.sql in your Supabase SQL Editor, then try again.", 401);
        }
        if (msg.includes("invalid login") || msg.includes("invalid credentials") || msg.includes("wrong password") || msg.includes("invalid email") || msg.includes("email not found") || msg.includes("user not found")) {
          return _apiErr("Wrong username or password. If you signed up on a different device without server sync, try signing up again.", 401);
        }
        return _apiErr(`Login failed: ${authErr.message}`, 401);
      }
      console.log("[login] signIn succeeded, userId:", authData.user?.id);
      const userId = authData.user?.id;
      let { data: rawProf } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
      // If profile doesn't exist yet (e.g. signup failed mid-way), auto-create it now
      if (!rawProf) {
        const fallbackRow = { id: userId, username, pic: "🌑", bio: "", cov: "silk", tier: "commoner", major: "Undeclared", year: "Freshman", wealth: "Self-Made", rep: "New Arrival", followers: 0, following: 0, xp: 0, traits: [] };
        try { await sb.from("profiles").insert(fallbackRow); } catch {}
        try { await sb.from("wallets").insert({ user_id: userId, balance: 5000 }); } catch {}
        rawProf = fallbackRow as any;
      }
      // Map snake_case Supabase columns → camelCase fields the client expects
      const prof = rawProf ? {
        ...rawProf,
        covenant: rawProf.cov,
        canSeeAuction: rawProf.can_see_auction ?? false,
        canSeeRelief: rawProf.can_see_relief ?? false,
        trentMemory: rawProf.trent_memory ?? "",
        xp: rawProf.xp ?? 0,
      } : null;
      return _apiOk({ token: "supabase", user: { id: userId, username, profile: prof } });
    }
    if (seg[1] === "profile") {
      if (method === "PUT") {
        const { userId, ...rest } = body as any;
        if (!userId) return _apiErr("userId required", 400);
        const fieldMap: Record<string, string> = { covenant: "cov", trentMemory: "trent_memory", canSeeAuction: "can_see_auction", canSeeRelief: "can_see_relief" };
        const upd: any = {};
        for (const [k, v] of Object.entries(rest)) { upd[fieldMap[k] || k] = v; }
        await sb.from("profiles").update(upd).eq("id", userId);
        return _apiOk({ success: true });
      }
      if (method === "GET" && seg[2]) {
        const { data: prof } = await sb.from("profiles").select("*").eq("id", seg[2]).maybeSingle();
        if (prof) return _apiOk({ profile: { pic: prof.pic, bio: prof.bio, traits: prof.traits || [], covenant: prof.cov, tier: prof.tier, major: prof.major, year: prof.year, wealth: prof.wealth, rep: prof.rep } });
        const acct = ACCTS[seg[2]] as any;
        if (acct) return _apiOk({ profile: { pic: acct.pic, bio: acct.bio, traits: acct.traits || [], covenant: acct.cov, tier: acct.tier, major: acct.major, year: acct.year, wealth: acct.wealth, rep: acct.rep } });
        return _apiErr("Not found", 404);
      }
    }
  }

  // ── AUCTIONS ───────────────────────────────────────────────────────────────
  if (seg[0] === "auctions") {
    if (method === "GET" && !seg[1]) {
      const { data } = await sb.from("auctions").select("*").eq("is_active", true).order("created_at", { ascending: false });
      return _apiOk({ auctions: (data || []).map((a: any) => ({ ...a, subjectId: a.subject_id, subjectType: a.subject_type, subjectName: a.subject_name, subjectAvatar: a.subject_avatar, subjectData: a.subject_data, startingBid: a.starting_bid, topBid: a.top_bid, topBidder: a.top_bidder, isActive: a.is_active, createdAt: a.created_at })) });
    }
    if (method === "GET" && seg[1] === "history") {
      const { data } = await sb.from("auctions").select("*").eq("is_active", false).order("created_at", { ascending: false });
      return _apiOk({ auctions: data || [] });
    }
    if (method === "GET" && seg[1] === "user" && seg[2]) {
      const { data } = await sb.from("auctions").select("*").eq("subject_id", seg[2]).eq("is_active", true).maybeSingle();
      return _apiOk({ auction: data || null });
    }
    if (method === "POST" && !seg[1]) {
      const b = body as any;
      const auction = { id: b.id || `auc_${Date.now()}`, subject_id: b.subjectId, subject_type: b.subjectType || "user", subject_name: b.subjectName, subject_avatar: b.subjectAvatar || "🌑", subject_data: b.subjectData || {}, reason: b.reason || "", starting_bid: b.startingBid || 500, top_bid: b.startingBid || 500, top_bidder: null, bids: [], is_active: true, created_at: new Date().toISOString() };
      const { error } = await sb.from("auctions").insert(auction);
      if (error) return _apiErr(error.message);
      return _apiOk({ auction: { ...auction, subjectId: auction.subject_id, topBid: auction.top_bid, isActive: true, createdAt: auction.created_at } });
    }
    if (method === "POST" && seg[2] === "bid") {
      const b = body as any;
      await sb.from("bids").insert({ id: b.id || `bid_${Date.now()}`, auction_id: seg[1], bidder_id: b.bidderId, bidder_name: b.bidderName, amount: b.amount, created_at: new Date().toISOString() });
      const { data: auc, error } = await sb.from("auctions").update({ top_bid: b.amount, top_bidder: b.bidderId }).eq("id", seg[1]).select().single();
      if (error) return _apiErr(error.message);
      return _apiOk({ success: true, auction: auc });
    }
  }

  // ── WALLET ──────────────────────────────────────────────────────────────────
  if (seg[0] === "wallet") {
    if (method === "GET" && seg[1]) {
      const { data } = await sb.from("wallets").select("balance").eq("user_id", seg[1]).maybeSingle();
      return _apiOk({ balance: data?.balance ?? null });
    }
    if (method === "POST" && seg[1] === "transfer") {
      const { toId, amount, fromId } = body as any;
      const { data: toW } = await sb.from("wallets").select("balance").eq("user_id", toId).maybeSingle();
      const newBal = ((toW?.balance as number) ?? 5000) + (amount as number || 0);
      await sb.from("wallets").upsert({ user_id: toId, balance: newBal, updated_at: new Date().toISOString() });
      if (fromId) {
        const { data: fromW } = await sb.from("wallets").select("balance").eq("user_id", fromId).maybeSingle();
        await sb.from("wallets").upsert({ user_id: fromId, balance: ((fromW?.balance as number) ?? 5000) - (amount as number || 0), updated_at: new Date().toISOString() });
      }
      return _apiOk({ toBalance: newBal });
    }
  }

  // ── BIDS ────────────────────────────────────────────────────────────────────
  if (seg[0] === "bids") {
    if (method === "GET") {
      const { data } = await sb.from("bids").select("*").order("created_at", { ascending: false });
      return _apiOk({ bids: data || [] });
    }
    if (method === "POST") {
      const b = body as any;
      await sb.from("bids").insert({ id: b.id || `bid_${Date.now()}`, auction_id: b.auctionId, bidder_id: b.bidderId, bidder_name: b.bidderName, amount: b.amount, created_at: new Date().toISOString() });
      return _apiOk({ success: true });
    }
  }

  // ── LEADERBOARD ─────────────────────────────────────────────────────────────
  if (seg[0] === "leaderboard") {
    const { data: profRows } = await sb.from("profiles").select("id,username,pic,cov,tier,followers,xp").limit(200);
    const { data: walletRows } = await sb.from("wallets").select("user_id,balance").limit(200);
    const walletMap = Object.fromEntries((walletRows || []).map((w: any) => [w.user_id, w.balance]));
    const xpMap = _ls<Record<string, number>>("umbra_xp", {});
    const infMap = _ls<Record<string, number>>("umbra_influence", {});
    const npcLeaders = (Object.values(ACCTS) as any[]).filter((u: any) => !u.isGuest && !u._real && u.un && u.un !== "Lurker")
      .map((u: any) => ({ id: u.id, username: u.un, pic: u.pic, covenant: u.cov, tier: u.tier || "commoner", xp: xpMap[u.id] ?? npcXp(u.id, u.tier || "commoner"), wealth: walletMap[u.id] ?? npcWealth(u.id, u.tier || "commoner"), influence: infMap[u.id] ?? 0, followers: u.followers ?? 0, isNpc: true }));
    // Real users: use Supabase xp column first, then localStorage fallback
    const realLeaders = (profRows || []).map((u: any) => ({ id: u.id, username: u.username, pic: u.pic, covenant: u.cov, tier: u.tier || "commoner", xp: (u.xp ?? 0) || xpMap[u.id] || 0, wealth: walletMap[u.id] ?? 5000, influence: infMap[u.id] ?? 0, followers: u.followers || 0, isNpc: false }));
    const seen = new Set(realLeaders.map((u: any) => u.id));
    const leaderboard = [...realLeaders, ...npcLeaders.filter((u: any) => !seen.has(u.id))].sort((a: any, b: any) => b.xp - a.xp || b.wealth - a.wealth).slice(0, 50);
    return _apiOk({ leaderboard, updatedAt: new Date().toISOString() });
  }

  // ── STORAGE ─────────────────────────────────────────────────────────────────
  if (seg[0] === "storage") return _apiErr("local mode", 503);

  return _apiErr("Not found", 404);
}

// ─── localStorage fallback handler (sync) ────────────────────────────────────
function _localstorageHandler(method: string, seg: string[], query: URLSearchParams, body: Record<string, unknown>): Response {
  if (seg[0] === "messages") {
    const allMsgs = _ls<unknown[]>("umbra_local_msgs", []);
    if (method === "GET" && seg[1]) return _apiOk({ messages: (allMsgs as any[]).filter((m: any) => m.fromId === seg[1] || m.toId === seg[1]) });
    if (method === "POST") {
      const msg = { ...body, id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString() };
      _lsSet("umbra_local_msgs", [...allMsgs, msg]);
      return _apiOk({ message: msg });
    }
  }
  if (seg[0] === "posts") {
    if (method === "GET" && !seg[1]) {
      let posts = _ls<any[]>("umbra:posts:v1", []);
      if (posts.length === 0) {
        posts = (INIT_POSTS as any[]).map((p: any) => ({ ...p, userId: p.userId || p.user_id, covenant: p.covenant || p.cov, createdAt: p.createdAt || p.created_at }));
        _lsSet("umbra:posts:v1", posts);
      }
      // Attach NPC-generated comments stored per-post in localStorage
      posts = posts.map((p: any) => {
        const npcCs = _ls<any[]>(`umbra_comments_${p.id}`, []);
        const existing = p.comments || [];
        const existingIds = new Set(existing.map((c: any) => c.id));
        const merged = [...existing, ...npcCs.filter((c: any) => !existingIds.has(c.id))];
        return merged.length ? { ...p, comments: merged } : p;
      });
      return _apiOk({ posts });
    }
    if (method === "POST" && !seg[1]) {
      const posts = _ls<any[]>("umbra:posts:v1", []);
      const post = { ...body, id: (body as any).id || `post_${Date.now()}`, createdAt: new Date().toISOString() };
      _lsSet("umbra:posts:v1", [post, ...posts]);
      return _apiOk({ post });
    }
    // ── COMMENTS: /api/posts/:postId/comments[/:commentId] ───────────────────
    if (seg[1] && seg[2] === "comments") {
      const key = `umbra_comments_${seg[1]}`;
      if (method === "POST") {
        const b = body as any;
        const comment = { id: b.id || `c_${Date.now()}`, post_id: seg[1], user_id: b.userId || b.user_id, username: b.username, text: b.text, parent_id: b.parentId || null, created_at: new Date().toISOString() };
        _lsSet(key, [..._ls<any[]>(key, []), comment]);
        return _apiOk({ comment });
      }
      if (method === "DELETE" && seg[3]) {
        _lsSet(key, _ls<any[]>(key, []).filter((c: any) => c.id !== seg[3]));
        return _apiOk({ success: true });
      }
      return _apiOk({ success: true });
    }
    return _apiOk({ success: true });
  }
  if (seg[0] === "users") {
    if (method === "GET" && !seg[1]) {
      const q = query.get("q") || "";
      const limit = Math.min(parseInt(query.get("limit") || "200"), 500);
      return _apiOk({ users: (Object.values(ACCTS) as any[]).filter((u: any) => !u.isGuest && u.un && (!q || u.un.toLowerCase().includes(q.toLowerCase()))).slice(0, limit).map((u: any) => ({ id: u.id, username: u.un, followers: u.followers ?? 0, following: u.following ?? 0, profile: { pic: u.pic, bio: u.bio, covenant: u.cov, tier: u.tier, traits: u.traits || [] } })) });
    }
    if (method === "PATCH" && seg[1] && seg[2] === "profile") {
      if (ACCTS[seg[1]]) Object.assign(ACCTS[seg[1]], body);
      return _apiOk({ success: true });
    }
  }
  if (seg[0] === "auth") {
    if (seg[1] === "signup" && method === "POST") {
      const { username, password, profile = {} } = body as any;
      const taken = (Object.values(ACCTS) as any[]).some((u: any) => u.un?.toLowerCase() === (username as string)?.toLowerCase());
      const lsTaken = Object.keys(_ls<Record<string,any>>("umbra_custom_accts", {})).some((id: string) => {
        const a = _ls<Record<string,any>>("umbra_custom_accts", {})[id];
        return a?.un?.toLowerCase() === (username as string)?.toLowerCase();
      });
      if (taken || lsTaken) {
        const suffix = Math.floor(Math.random() * 900) + 100;
        const suggestion = `${username}_${suffix}`;
        return new Response(JSON.stringify({ error: "Username already taken.", suggestion }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      const id = `custom_${(username as string).toLowerCase().replace(/\s+/g, "_")}_${Date.now()}`;
      const pwStore = _ls<Record<string, string>>("umbra_pw_store", {});
      pwStore[id] = password as string;
      _lsSet("umbra_pw_store", pwStore);
      const customAccts = _ls<Record<string, any>>("umbra_custom_accts", {});
      customAccts[id] = { id, un: username, ...(profile as any) };
      _lsSet("umbra_custom_accts", customAccts);
      return _apiOk({ token: "local", user: { id, username, profile } });
    }
    if (seg[1] === "login" && method === "POST") {
      const { username, password } = body as any;
      const pwStore = _ls<Record<string, string>>("umbra_pw_store", {});
      const customAccts = _ls<Record<string, any>>("umbra_custom_accts", {});
      const acct = (Object.values(customAccts) as any[]).find((u: any) => u.un?.toLowerCase() === (username as string)?.toLowerCase() && pwStore[u.id] === password);
      if (!acct) return _apiErr("Invalid credentials.", 401);
      return _apiOk({ token: "local", user: { id: acct.id, username: acct.un, profile: { pic: acct.pic, bio: acct.bio, covenant: acct.cov, tier: acct.tier } } });
    }
    if (seg[1] === "profile") {
      if (method === "PUT") {
        const { userId, ...rest } = body as any;
        if (userId && ACCTS[userId]) { Object.assign(ACCTS[userId], rest); }
        const saved = _ls<Record<string, any>>("umbra_custom_accts", {});
        if (userId && saved[userId]) { Object.assign(saved[userId], rest); _lsSet("umbra_custom_accts", saved); }
        return _apiOk({ success: true });
      }
      if (method === "GET" && seg[2]) {
        const acct = ACCTS[seg[2]] as any;
        if (!acct) return _apiErr("Not found", 404);
        return _apiOk({ profile: { pic: acct.pic, bio: acct.bio, traits: acct.traits || [], covenant: acct.cov, tier: acct.tier, major: acct.major, year: acct.year, wealth: acct.wealth, rep: acct.rep } });
      }
    }
  }
  if (seg[0] === "auctions") {
    const auctions = _ls<any[]>("umbra_local_auctions", []);
    if (method === "GET" && !seg[1]) return _apiOk({ auctions });
    if (method === "GET" && seg[1] === "history") return _apiOk({ auctions: _ls("umbra_local_auc_hist", []) });
    if (method === "GET" && seg[1] === "user" && seg[2]) return _apiOk({ auction: auctions.find((a: any) => a.subjectId === seg[2]) || null });
    if (method === "POST" && !seg[1]) {
      const auction = { ...body, id: `auc_${Date.now()}`, createdAt: new Date().toISOString(), bids: [], topBid: (body as any).startingBid || 500, topBidder: null };
      _lsSet("umbra_local_auctions", [...auctions, auction]);
      return _apiOk({ auction });
    }
    if (method === "POST" && seg[2] === "bid") {
      const idx = auctions.findIndex((a: any) => a.id === seg[1]);
      if (idx === -1) return _apiErr("Not found", 404);
      const bid = { ...body, id: `bid_${Date.now()}`, createdAt: new Date().toISOString() };
      auctions[idx] = { ...auctions[idx], bids: [...(auctions[idx].bids || []), bid], topBid: (body as any).amount, topBidder: (body as any).bidderId };
      _lsSet("umbra_local_auctions", auctions);
      return _apiOk({ success: true, auction: auctions[idx] });
    }
  }
  if (seg[0] === "wallet") {
    if (method === "GET" && seg[1]) { const w = _ls<Record<string, number>>("umbra_wallets", {}); return _apiOk({ balance: w[seg[1]] ?? null }); }
    if (method === "POST" && seg[1] === "transfer") {
      const { toId, amount } = body as any;
      const w = _ls<Record<string, number>>("umbra_wallets", {});
      w[toId as string] = (w[toId as string] ?? 5000) + (amount as number || 0);
      _lsSet("umbra_wallets", w);
      return _apiOk({ toBalance: w[toId as string] });
    }
  }
  if (seg[0] === "bids") {
    if (method === "GET") return _apiOk({ bids: _ls("umbra_local_bids", []) });
    if (method === "POST") { _lsSet("umbra_local_bids", [..._ls<any[]>("umbra_local_bids", []), { ...body, id: `bid_${Date.now()}`, createdAt: new Date().toISOString() }]); return _apiOk({ success: true }); }
  }
  if (seg[0] === "leaderboard") {
    const xpMap = _ls<Record<string, number>>("umbra_xp", {});
    const walletMap = _ls<Record<string, number>>("umbra_wallets", {});
    const infMap = _ls<Record<string, number>>("umbra_influence", {});
    const leaderboard = (Object.values(ACCTS) as any[]).filter((u: any) => !u.isGuest && u.un && u.un !== "Lurker")
      .map((u: any) => ({ id: u.id, username: u.un, pic: u.pic, covenant: u.cov, tier: u.tier || "commoner", xp: xpMap[u.id] ?? npcXp(u.id, u.tier || "commoner"), wealth: walletMap[u.id] ?? npcWealth(u.id, u.tier || "commoner"), influence: infMap[u.id] ?? 0, followers: u.followers ?? 0 }))
      .sort((a: any, b: any) => b.xp - a.xp || b.wealth - a.wealth).slice(0, 50);
    return _apiOk({ leaderboard, updatedAt: new Date().toISOString() });
  }
  if (seg[0] === "ai") {
    const sub = seg[1];
    if (sub === "npc-reply" || sub === "npc-initiate" || sub === "worship-dm" || sub === "prof-dm") {
      const npcId = (body as any)?.npcId || "";
      const relLevel = Math.min((body as any)?.relLevel ?? 0, 5);
      let reply = "";
      if (npcId === "trent_morrison") {
        const pools = [TRENT_REPLIES_L0, TRENT_REPLIES_L1, TRENT_REPLIES_L2, TRENT_REPLIES_L3, TRENT_REPLIES_L4, TRENT_REPLIES_L5];
        const pool = pools[relLevel] || TRENT_REPLIES_L0;
        reply = pool[Math.floor(Math.random() * pool.length)] || "...";
      } else {
        const fallbacks = ["Interesting. Go on.", "I wasn't expecting that from you.", "There's more to this than you're saying.", "You always find a way to surprise me.", "Tonight is complicated. Let's talk another time.", "You know how this ends, right?", "Don't read into this. I'm just being polite."];
        reply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
      return _apiOk({ reply, message: reply });
    }
    if (sub === "npc-comment") return _apiOk({ comments: ((body.npcs as any[]) || []).map(() => ({ text: AUTO_C[Math.floor(Math.random() * AUTO_C.length)] })) });
    if (sub === "npc-memory") { const existing = (body.existingMemory as string) || ""; const last = ((body.lastExchange as any[]) || []).map((e: any) => e.text).join(" | "); return _apiOk({ memory: existing ? `${existing} | ${last}` : last }); }
    if (sub === "gossip" || sub === "generate-rumour") return _apiErr("offline", 503);
    return _apiOk({ success: true, reply: "", snippets: [], comments: [], message: "" });
  }
  if (seg[0] === "storage") return _apiErr("local mode", 503);
  return _apiErr("Not found", 404);
}

// ─── Main router ──────────────────────────────────────────────────────────────
async function _localAPIHandler(url: string, opts: RequestInit = {}): Promise<Response> {
  const method = (opts.method || "GET").toUpperCase();
  const qMark = url.indexOf("?");
  const path = qMark !== -1 ? url.slice(0, qMark) : url;
  const query = qMark !== -1 ? new URLSearchParams(url.slice(qMark + 1)) : new URLSearchParams();
  const seg = path.replace(/^\/api\//, "").split("/");
  let body: Record<string, unknown> = {};
  try { if (opts.body) body = JSON.parse(opts.body as string); } catch {}

  // AI routes always use LLM (with template fallback when no key)
  if (seg[0] === "ai") return _handleAIRoute(seg[1], body);
  // Storage always 503 (triggers compressImage fallback in app)
  if (seg[0] === "storage") return _apiErr("local mode", 503);
  // Route to Supabase (shared) or localStorage (offline)
  if (supabase) return _supabaseHandler(method, seg, query, body);
  return _localstorageHandler(method, seg, query, body);
}

// ─── NPC comment generation (called after NPC posts are created) ─────────────
async function _generateNPCComments(
  postId: string,
  postContent: string,
  authorId: string,
  creds: ReturnType<typeof getStoredCreds>
): Promise<void> {
  // CRITICAL: never let a real player be picked as an NPC commenter.
  const pool = (Object.values(ACCTS) as any[]).filter(
    (n: any) => n.personality && n.id !== authorId && !n.isGuest && !n._real && !n.isReal && n.un
  );
  const count = 1 + Math.floor(Math.random() * 2); // 1–2 comments per NPC post
  const commenters: any[] = [];
  const used = new Set<string>([authorId]);
  while (commenters.length < count && commenters.length < pool.length) {
    const r = pool[Math.floor(Math.random() * pool.length)];
    if (r && !used.has(r.id)) { commenters.push(r); used.add(r.id); }
  }
  for (const npc of commenters) {
    let text = AUTO_C[Math.floor(Math.random() * AUTO_C.length)];
    if (creds) {
      const msgs = [
        { role: "system" as const, content: buildNPCPrompt(npc) + "\nWrite ONE short reaction comment (max 1 sentence) on this post. Output only the comment text." },
        { role: "user" as const, content: `Post: "${postContent}"` },
      ];
      text = await callLLM(msgs, creds, { maxTokens: 60, temperature: 0.92 }).catch(() => text);
    }
    const comment = {
      id: `npc_c_${npc.id}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      post_id: postId,
      user_id: npc.id,
      username: npc.un,
      text,
      created_at: new Date(Date.now() + Math.floor(Math.random() * 1800000)).toISOString(),
    };
    if (supabase) {
      try { await supabase.from("comments").insert(comment); } catch {}
    } else {
      const key = `umbra_comments_${postId}`;
      _lsSet(key, [..._ls<any[]>(key, []), comment]);
    }
  }
}

// Patch window.fetch once at module load — routes /api/* to Supabase + AI shim
if (typeof window !== "undefined" && !(window as any).__umbraShim) {
  (window as any).__umbraShim = true;
  const _origFetch = window.fetch.bind(window);
  (window as any).fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (typeof url === "string" && url.startsWith("/api/")) {
      return _localAPIHandler(url, init ?? {}).catch((err) => {
        // Expose the real exception message so users + devs can see what failed,
        // instead of the useless "shim error" placeholder.
        const msg = err instanceof Error ? err.message : String(err ?? "unknown");
        console.error("[shim] handler threw on", url, "→", err);
        return new Response(JSON.stringify({ error: `Network/handler error: ${msg}` }), { status: 500, headers: { "Content-Type": "application/json" } });
      });
    }
    return _origFetch(input, init);
  };
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── timeAgo — relative time using the user's system clock ───────────────────
function timeAgo(ms: number | string): string {
  const d = typeof ms === "string" ? new Date(ms).getTime() : ms;
  const diff = Date.now() - d;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* ═══════════════════════════════════════════════════════
   UMBRA v4 — NOCTIS UNIVERSITY SOCIAL NETWORK
   University Portal · Auction Documents · Bid Records
   30 Students · 15 Professors · localStorage persistence
═══════════════════════════════════════════════════════ */

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,400&family=IM+Fell+English:ital@0;1&family=Dancing+Script:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=UnifrakturMaguntia&family=MedievalSharp&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:rgba(212,175,55,.25);border-radius:2px;}
  body{font-family:'Cormorant Garamond',Georgia,serif;}
  @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  @keyframes liveDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.2;transform:scale(.5)}}
  @keyframes collarGlow{0%,100%{box-shadow:0 0 8px #8b0000}50%{box-shadow:0 0 22px #8b0000,0 0 44px #4a0000}}
  .fu{animation:fadeUp .3s ease forwards}
  .fi{animation:fadeIn .25s ease forwards}
  .flt{animation:float 4s ease-in-out infinite}
  .live{width:7px;height:7px;border-radius:50%;background:#ff3b3b;display:inline-block;animation:liveDot 1s infinite}
  .b{transition:transform .12s;cursor:pointer;}.b:hover{transform:scale(1.04)}.b:active{transform:scale(.95)}
  input:focus,textarea:focus{outline:none;}button{cursor:pointer;font-family:inherit;}

  @keyframes frmTwink{0%,100%{opacity:.2;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}
  @keyframes frmFloatY{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  @keyframes frmFlicker{0%,100%{opacity:.7;transform:scaleY(1)}30%{opacity:1;transform:scaleY(1.08)}60%{opacity:.85;transform:scaleY(.95)}}
  @keyframes frmGlow{0%,100%{filter:drop-shadow(0 0 2px currentColor)}50%{filter:drop-shadow(0 0 5px currentColor)}}
  @keyframes frmSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
  @keyframes frmPop{0%,100%{opacity:.6;transform:scale(1)}50%{opacity:1;transform:scale(1.08)}}
  .frm-twink{animation:frmTwink 2.2s ease-in-out infinite}
  .frm-twink2{animation:frmTwink 1.7s ease-in-out infinite .5s}
  .frm-twink3{animation:frmTwink 2.8s ease-in-out infinite 1s}
  .frm-float{animation:frmFloatY 3s ease-in-out infinite}
  .frm-flicker{animation:frmFlicker 1.4s ease-in-out infinite}
  .frm-flicker2{animation:frmFlicker 1.8s ease-in-out infinite .3s}
  .frm-glow{animation:frmGlow 2s ease-in-out infinite}
  .frm-pop{animation:frmPop 2.5s ease-in-out infinite}
  .frm-pop2{animation:frmPop 3s ease-in-out infinite .8s}

  @keyframes charmSwing{0%,100%{transform:rotate(-8deg) translateY(0)}50%{transform:rotate(8deg) translateY(2px)}}
  @keyframes charmSwing2{0%,100%{transform:rotate(6deg) translateY(0)}50%{transform:rotate(-6deg) translateY(3px)}}
  @keyframes charmSwing3{0%,100%{transform:rotate(-4deg) translateY(0)}50%{transform:rotate(10deg) translateY(1px)}}
  @keyframes charmBob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.08)}}
  @keyframes lacePulse{0%,100%{opacity:.6}50%{opacity:1}}
  .charm-swing{animation:charmSwing 2.6s ease-in-out infinite;transform-origin:top center;}
  .charm-swing2{animation:charmSwing2 2.1s ease-in-out infinite .4s;transform-origin:top center;}
  .charm-swing3{animation:charmSwing3 3s ease-in-out infinite .9s;transform-origin:top center;}
  .charm-bob{animation:charmBob 2.4s ease-in-out infinite;}
  .lace-pulse{animation:lacePulse 3s ease-in-out infinite;}

  .lolita-theme *{font-family:'EB Garamond','Cormorant Garamond',Georgia,serif !important;}
  .lolita-theme h1,.lolita-theme h2,.lolita-theme .lolita-script{font-family:'Dancing Script',cursive !important;}

  @keyframes gothicFlicker{0%,100%{opacity:1;filter:drop-shadow(0 0 3px #fff)}40%{opacity:.7;filter:drop-shadow(0 0 1px #ccc)}70%{opacity:.9;filter:drop-shadow(0 0 5px #fff)}}
  @keyframes gothicPulse{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}
  @keyframes gothicGlow{0%,100%{filter:drop-shadow(0 0 2px #cccccc)}50%{filter:drop-shadow(0 0 7px #ffffff)}}
  .gothic-flicker{animation:gothicFlicker 3s ease-in-out infinite;}
  .gothic-pulse{animation:gothicPulse 2.8s ease-in-out infinite;}
  .gothic-glow{animation:gothicGlow 2.5s ease-in-out infinite;}

  .goth-theme *{font-family:'Cinzel','Cormorant Garamond',Georgia,serif !important;}
  .goth-theme h1,.goth-theme h2,.goth-theme .goth-title{font-family:'UnifrakturMaguntia',cursive !important;}

  @keyframes amethystShimmer{0%,100%{opacity:.6;filter:drop-shadow(0 0 2px #9b72cf)}50%{opacity:1;filter:drop-shadow(0 0 6px #c8a8f0)}}
  @keyframes amethystPulse{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.07)}}
  @keyframes quillBob{0%,100%{transform:translateY(0) rotate(-5deg)}50%{transform:translateY(-4px) rotate(2deg)}}
  .amethyst-shimmer{animation:amethystShimmer 3s ease-in-out infinite;}
  .amethyst-pulse{animation:amethystPulse 2.8s ease-in-out infinite;}
  .quill-bob{animation:quillBob 2.5s ease-in-out infinite;transform-origin:bottom center;}

  .amethyst-theme *{font-family:'Cinzel','IM Fell English',Georgia,serif !important;}
  .amethyst-theme h1,.amethyst-theme h2{font-family:'Cinzel',serif !important;}
  .amethyst-theme p,.amethyst-theme span:not(button span){font-family:'IM Fell English',serif !important;}
    .pastel-theme *{font-family:'Quicksand','Inter',sans-serif !important;}
    .pastel-theme h1,.pastel-theme h2,.pastel-theme .pastel-script{font-family:'Dancing Script',cursive !important;}
    .pastel-sparkle{animation:pastelSparkle 1.8s ease-in-out infinite;}
    .pastel-float{animation:pastelFloat 3.2s ease-in-out infinite;}
    @keyframes pastelSparkle{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.3)}}
    @keyframes pastelFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
    .vii-theme{background-image:repeating-conic-gradient(rgba(3,176,211,.028) 0% 25%,transparent 0% 50%);background-size:28px 28px;}
    .vii-theme *{font-family:'Cinzel','Cormorant Garamond',Georgia,serif !important;}
    .vii-theme h1,.vii-theme h2,.vii-theme .vii-title{font-family:'Cinzel Decorative','Cinzel',Georgia,serif !important;}
    .vii-glow{animation:viiGlow 2s ease-in-out infinite;text-shadow:0 0 8px #03B0D3,0 0 20px #48cae4,0 0 40px #03B0D3;}
    .vii-pulse{animation:viiPulse 3s ease-in-out infinite;}
    .chess-drift{animation:chessDrift 6s ease-in-out infinite;}
    .chess-drift2{animation:chessDrift 4s ease-in-out infinite 1.5s;}
    .chess-drift3{animation:chessDrift 5s ease-in-out infinite 3s;}
    .vii-ring{animation:viiRing 3s linear infinite;}
    @keyframes viiGlow{0%,100%{text-shadow:0 0 8px #03B0D3,0 0 20px #48cae4;opacity:1}50%{text-shadow:0 0 16px #03B0D3,0 0 40px #48cae4,0 0 80px #90e0ef;opacity:.92}}
    @keyframes viiPulse{0%,100%{opacity:.6;transform:scale(1)}50%{opacity:1;transform:scale(1.08)}}
    @keyframes chessDrift{0%,100%{transform:translateY(0) rotate(0deg)}33%{transform:translateY(-4px) rotate(3deg)}66%{transform:translateY(2px) rotate(-2deg)}}
    @keyframes viiRing{0%{stroke-dashoffset:0}100%{stroke-dashoffset:-300}}
`;
const injectCSS = () => {
  let e = document.getElementById("u4css");
  if (!e) {
    e = document.createElement("style");
    e.id = "u4css";
    document.head.appendChild(e);
  }
  e.textContent = CSS;
};

// ═══════════════════════════════════════════════════════
// PROFILE FRAMES
// ═══════════════════════════════════════════════════════
const FRAMES = [
  { id: "none",      label: "None",       icon: "⭕", accent: "#555" },
  { id: "wings",     label: "Wings",      icon: "🖤", accent: "#2a2a2a" },
  { id: "roses",     label: "Dark Roses", icon: "🌹", accent: "#5b2068" },
  { id: "butterfly", label: "Butterfly",  icon: "🦋", accent: "#6d28d9" },
  { id: "bloodmoon", label: "Blood Moon", icon: "🌕", accent: "#8b0000" },
  { id: "twilight",  label: "Twilight",   icon: "🌌", accent: "#6b7280" },
  { id: "electric",  label: "Electric",   icon: "💠", accent: "#0891b2" },
  { id: "fire",      label: "Fire",       icon: "🔥", accent: "#b45309" },
  { id: "sunflower",     label: "Sunflower",      icon: "🌻", accent: "#b45309" },
  { id: "lolita_charms",    label: "Lolita Charms",     icon: "🎀", accent: "#c785b2" },
{ id: "pastel_charms",    label: "Pastel Charms",     icon: "🌸", accent: "#F9CCE2" },
  { id: "goth_charms",      label: "Gothic Charms",     icon: "🖤", accent: "#cccccc" },
  { id: "amethyst_charms",  label: "Amethyst Charms",   icon: "🔮", accent: "#b08edf" },
];

// ═══════════════════════════════════════════════════════
// THEMES
// ═══════════════════════════════════════════════════════
const TH = {
  dark: {
    id: "dark",
    name: "Dark Academia",
    bg: "linear-gradient(160deg,#0e0b07,#1c1610,#261e13)",
    card: "#1a1409",
    hdr: "linear-gradient(135deg,#2a1e0e,#1a1409)",
    border: "#362e1e",
    text: "#e8dcc4",
    muted: "#9a8868",
    primary: "#d4af37",
    sec: "#8b7355",
    accent: "#c8954a",
    danger: "#8b2222",
    inp: "#120f06",
    tag: "#261e13",
    pill: "#2a2010",
  },
  butterfly: {
    id: "butterfly",
    name: "Butterfly Princess",
    bg: "linear-gradient(160deg,#fff5f8,#ffe0ec,#fff0f6)",
    card: "#fff",
    hdr: "linear-gradient(135deg,#ffe0f0,#ffd0e8)",
    border: "#ffc8de",
    text: "#3a1e2e",
    muted: "#9a6878",
    primary: "#ff69b4",
    sec: "#ffb6d9",
    accent: "#ff4499",
    danger: "#cc2266",
    inp: "#fff8fc",
    tag: "#ffe4f2",
    pill: "#ffd4ea",
  },
  cinnamon: {
    id: "cinnamon",
    name: "Cinnamon Roll",
    bg: "linear-gradient(160deg,#180d03,#281806,#38220e)",
    card: "#231506",
    hdr: "linear-gradient(135deg,#482c0e,#281806)",
    border: "#583a18",
    text: "#f5dfc0",
    muted: "#b88c5a",
    primary: "#e8963c",
    sec: "#c47830",
    accent: "#f0a85a",
    danger: "#a03020",
    inp: "#180d03",
    tag: "#321a08",
    pill: "#482c0e",
  },
  kuromi: {
    id: "kuromi",
    name: "Kuromi",
    bg: "linear-gradient(160deg,#07000c,#100018,#1a0028)",
    card: "#0e0015",
    hdr: "linear-gradient(135deg,#200038,#140025)",
    border: "#380052",
    text: "#f0d0ff",
    muted: "#8858b8",
    primary: "#cc44ff",
    sec: "#9922cc",
    accent: "#ff88ff",
    danger: "#ff2266",
    inp: "#07000c",
    tag: "#1c002c",
    pill: "#280040",
  },
  collar: {
    id: "collar",
    name: "🔒 Collared",
    locked: true,
    bg: "linear-gradient(160deg,#060000,#100303,#180505)",
    card: "#100303",
    hdr: "linear-gradient(135deg,#1e0606,#100303)",
    border: "#340a0a",
    text: "#c09090",
    muted: "#785050",
    primary: "#8b1414",
    sec: "#660000",
    accent: "#aa1818",
    danger: "#8b0000",
    inp: "#060000",
    tag: "#1a0505",
    pill: "#240808",
  },
  relief: {
    id: "relief",
    name: "🔒 Assigned",
    locked: true,
    bg: "#ecf2f8",
    card: "#fff",
    hdr: "#d8e8f4",
    border: "#b4ccdf",
    text: "#283848",
    muted: "#6888a8",
    primary: "#4a7a9b",
    sec: "#6a9ab0",
    accent: "#3a6a8b",
    danger: "#6a0000",
    inp: "#eef4fa",
    tag: "#d8e8f4",
    pill: "#c4d8ec",
  },
  cyberpunk: {
    id: "cyberpunk",
    name: "Cyberpunk",
    bg: "linear-gradient(160deg,#000005,#03000a,#060015)",
    card: "#040010",
    hdr: "linear-gradient(135deg,#07001a,#020008)",
    border: "#7700ff",
    text: "#f0ffff",
    muted: "#88bbdd",
    primary: "#00ffcc",
    sec: "#ff00bb",
    accent: "#cc00ff",
    danger: "#ff1155",
    inp: "#02000a",
    tag: "#0a0025",
    pill: "#110035",
  },
  mint: {
    id: "mint",
    name: "Mint Sovereignty",
    exclusive: "mercurial_cosmona",
    bg: "linear-gradient(160deg,#E8FAEA,#d4f7de,#C7FFD8)",
    card: "#FFFFFF",
    hdr: "linear-gradient(135deg,#C7FFD8,#94FFD4)",
    border: "#94FFD4",
    text: "#0d3d25",
    muted: "#46B47F",
    primary: "#46B47F",
    sec: "#6DD19C",
    accent: "#ADFFC3",
    danger: "#b03010",
    inp: "#F0FFF8",
    tag: "#C7FFD8",
    pill: "#ADFFC3",
    font: "'Josefin Sans','Inter',sans-serif",
  },
  lolita: {
    id: "lolita",
    name: "Lolita Reverie",
    exclusive: "polapola",
    bg: "linear-gradient(160deg,#1a1520,#231c2a,#2a1e2e)",
    card: "#231c2a",
    hdr: "linear-gradient(135deg,#7d5464,#4a2e3e)",
    border: "#7d5464",
    text: "#f0b3e8",
    muted: "#a07590",
    primary: "#c785b2",
    sec: "#a06480",
    accent: "#f0b3e8",
    danger: "#cc4466",
    inp: "#1e1528",
    tag: "#2d1e2f",
    pill: "#5a3048",
    font: "'EB Garamond','Cormorant Garamond',Georgia,serif",
  },
  goth_bw: {
    id: "goth_bw",
    name: "Gothic Noir",
    exclusive: "ket_white",
    bg: "linear-gradient(160deg,#0d0e0e,#16181a,#38363f)",
    card: "#16181a",
    hdr: "linear-gradient(135deg,#38363f,#16181a)",
    border: "#cccccc",
    text: "#e0e0e0",
    muted: "#888888",
    primary: "#ffffff",
    sec: "#cccccc",
    accent: "#d0d0d0",
    danger: "#cc0000",
    inp: "#0d0e0e",
    tag: "#1e1e22",
    pill: "#38363f",
    font: "'Cinzel','Cormorant Garamond',Georgia,serif",
  },
  vii_aether: {
      id: "vii_aether",
      name: "Aether Chess",
      exclusive: "vii_imperator",
      bg: "linear-gradient(160deg,#020d12,#071825,#0c2030)",
      card: "#071218",
      hdr: "linear-gradient(135deg,#0d2840,#071218)",
      border: "#03B0D3",
      text: "#caf0f8",
      muted: "#48cae4",
      primary: "#03B0D3",
      sec: "#48cae4",
      accent: "#90e0ef",
      danger: "#cc3366",
      inp: "#030c12",
      tag: "#071825",
      pill: "#0d2840",
      font: "'Cinzel','Cormorant Garamond',Georgia,serif",
    },
  pastel_rose: {
      id: "pastel_rose",
      name: "Pastel Rose Garden",
      exclusive: "rosenia_elle",
      bg: "linear-gradient(160deg,#FCF5E3,#FFDBEA,#F9CCE2)",
      card: "#FFFAFD",
      hdr: "linear-gradient(135deg,#FFE8F5,#FFDBEA)",
      border: "#FFDBEA",
      text: "#4a2040",
      muted: "#b888aa",
      primary: "#E2B5E1",
      sec: "#ACC2EF",
      accent: "#F9CCE2",
      danger: "#cc3366",
      inp: "#FFF5FB",
      tag: "#FFE8F5",
      pill: "#FFD4EE",
      font: "'Quicksand','Inter',sans-serif",
    },
  dark_amethyst: {
    id: "dark_amethyst",
    name: "Velvet Compendium",
    exclusive: "yvonne_everleigh",
    bg: "linear-gradient(160deg,#100c1a,#1a1428,#241535)",
    card: "#1e162e",
    hdr: "linear-gradient(135deg,#3d2868,#1e162e)",
    border: "#5a3d8a",
    text: "#e8d8f8",
    muted: "#9070b8",
    primary: "#b08edf",
    sec: "#7a55a8",
    accent: "#c8a8f0",
    danger: "#c84080",
    inp: "#120e1e",
    tag: "#251b40",
    pill: "#3d2868",
    font: "'Cinzel','IM Fell English',Georgia,serif",
  },
};

const COV = {
  crowns: {
    name: "Covenant of Crowns",
    emoji: "👑",
    color: "#d4af37",
    desc: "Power. Ambition. Authority.",
  },
  shadows: {
    name: "Covenant of Shadows",
    emoji: "🌑",
    color: "#9944cc",
    desc: "Knowledge. Secrets. Control.",
  },
  blades: {
    name: "Covenant of Blades",
    emoji: "⚔️",
    color: "#7a9ab0",
    desc: "Strength. Loyalty. Honor.",
  },
  silk: {
    name: "Covenant of Silk",
    emoji: "🦋",
    color: "#ff69b4",
    desc: "Influence. Charm. Desire.",
  },
};

// ═══════════════════════════════════════════════════════
// ── PRONOUNS — per student NPC ────────────────────────────────────────────────
const PRONOUNS_MAP: Record<string, string> = {
  "vii_imperator":       "they/them",
  "sebastian_blackwood": "he/him",
  "cordelia_vane":       "she/her",
  "arabella_voss":       "she/her",
  "felix_crowne":        "he/him",
  "lysander_grey":       "he/him",
  "isadora_silk":        "she/her",
  "margot_delacroix":    "she/her",
  "cassius_ward":        "he/him",
  "viola_nightshade":    "she/her",
  "emery_black":         "they/them",
  "damien_holt":         "he/him",
  "seraphina_cross":     "she/her",
  "ronan_ashcroft":      "he/him",
  "celeste_beaumont":    "she/her",
  "theo_vale":           "he/him",
  "ophelia_march":       "she/her",
  "trent_morrison":      "he/him",
  "npc_bully_1":         "they/them",
  "npc_bully_2":         "she/her",
  "npc_bully_3":         "he/him",
  "npc_bully_4":         "she/her",
  "npc_bully_5":         "they/them",
  "npc_bully_6":         "he/him",
  "npc_bully_7":         "he/him",
};

// ── NPC SENIORITY SCORES — used in leaderboard ───────────────────────────────
// Deterministic hash so scores stay stable between renders
/** Render a pic field as an <img> if it's a URL, or as an emoji span otherwise. */
// Per-NPC emoji fallback used when their image URL fails to load (file not
// uploaded yet, 404, etc.). Lets the UI show SOMETHING instead of a broken
// image icon. Maps the image path back to a sensible character emoji.
const PIC_EMOJI_FALLBACK: Record<string, string> = {
  "/cyrus.jpeg": "🏊‍♂️",
  "/trent_locker.jpeg": "🐺",
  "/trent_pool.webp": "🐺",
};

function renderPic(pic: string | undefined | null, size = 22, extraStyle?: React.CSSProperties): React.ReactNode {
  const p = pic || "🌑";
  if (p.startsWith("/") || p.startsWith("http") || p.startsWith("data:")) {
    const fallbackEmoji = PIC_EMOJI_FALLBACK[p] || "🌑";
    return (
      <img
        src={p}
        alt=""
        onError={(e) => {
          // Swap the broken <img> for an inline emoji span so the user sees something.
          const el = e.currentTarget;
          const span = document.createElement("span");
          span.textContent = fallbackEmoji;
          span.style.fontSize = `${size * 0.85}px`;
          span.style.lineHeight = "1";
          span.style.display = "inline-flex";
          span.style.alignItems = "center";
          span.style.justifyContent = "center";
          span.style.width = `${size}px`;
          span.style.height = `${size}px`;
          span.style.verticalAlign = "middle";
          el.replaceWith(span);
        }}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, display: "inline-block", verticalAlign: "middle", ...extraStyle }}
      />
    );
  }
  return <span style={{ fontSize: size * 0.85, lineHeight: 1, flexShrink: 0, ...extraStyle }}>{p}</span>;
}

// ═══════════════════════════════════════════════════════
// PROFESSORS — 15 rich profiles
// ═══════════════════════════════════════════════════════
const AppCtx = createContext({});
const useApp = () => useContext(AppCtx);

// ═══════════════════════════════════════════════════════
// POST CARD — top-level so hooks are stable across renders
// ═══════════════════════════════════════════════════════
const PostCard = memo(
  ({
    post,
    idx,
    T,
    user,
    uid,
    ACCTS_REF,
    react,
    delPost,
    delC,
    viewProf,
    pushPosts,
    setPosts,
    EMOJIS,
    inp,
    card,
    lbl,
    bdg,
    framedAvatar,
    getFrame,
  }) => {
    const [showC, setShowC] = useState(false);
    const [localCTxt, setLocalCTxt] = useState("");
    const [localMenu, setLocalMenu] = useState(false);
    const [replyTo, setReplyTo] = useState<string|null>(null);
    const [replyTxt, setReplyTxt] = useState("");
    const ACCTS = ACCTS_REF;
    const pu = post.uid ? ACCTS[post.uid] : null;
    const name = pu?.un || post._un || post.anonName || "[ Anonymous ]";
    const postPic = pu?.pic || post._pic || "🌑";
    const canDel = user?.isAdmin || post.uid === uid;
    const submitC = (parentId?: string|null, txt?: string) => {
      const finalTxt = (txt ?? localCTxt).trim();
      if (!finalTxt || !user) return;
      const cId = `nc${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      fetch(`/api/posts/${post.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cId, userId: user.id, username: user.un, text: finalTxt, parentId: parentId || null }),
      }).catch(() => {});
      setPosts((prev) => {
        const n = prev.map((p) =>
          p.id !== post.id
            ? p
            : {
                ...p,
                c: [
                  ...p.c,
                  { id: cId, uid: user.id, un: user.un, t: finalTxt, parentId: parentId || null },
                ],
              }
        );
        pushPosts(n);
        return n;
      });
      if (parentId) { setReplyTo(null); setReplyTxt(""); }
      else setLocalCTxt("");
    };
    return (
      <div
        id={`post-${post.id}`}
        style={{
          ...card,
          marginBottom: 10,
          overflow: "hidden",
          animation: `fadeUp ${0.1 + idx * 0.03}s ease forwards`,
        }}
      >
        {post.apexOnly && (
          <div
            style={{
              background: `${T.primary}12`,
              borderBottom: `1px solid ${T.border}`,
              padding: "4px 14px",
            }}
          >
            <span style={{ ...lbl, color: T.primary }}>
              {post.apexLabel || "🔒 APEX RESTRICTED"}
            </span>
          </div>
        )}
        {post.isConfession && (
          <div
            style={{
              background: "rgba(139,26,26,.08)",
              borderBottom: `1px solid ${T.border}`,
              padding: "4px 14px",
            }}
          >
            <span style={{ ...lbl, color: "#cc4444" }}>
              🔖 CONFESSION · ANONYMOUS
            </span>
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            padding: "12px 12px 0",
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (post.uid) viewProf(post.uid);
            }}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              flexShrink: 0,
              borderRadius: "50%",
            }}
          >
            {framedAvatar ? framedAvatar(postPic, 38, getFrame ? getFrame(post.uid || "") : "none") : (
              <div style={{ width: 38, height: 38, borderRadius: "50%", border: `2px solid ${pu?.bColor || T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, background: T.tag }}>
                {postPic && (postPic.startsWith("/") || postPic.startsWith("http"))
                  ? <img src={postPic} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                  : postPic}
              </div>
            )}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 14, color: T.text }}>
                {name}
              </span>
              {pu?.isVerified && (
                <span style={{ color: T.primary, fontSize: 11 }}>✓</span>
              )}
              {pu?.badge && <span style={bdg(pu.bColor)}>{pu.badge}</span>}
            </div>
            <span style={{ fontSize: 11, color: T.muted }}>{post._createdAt ? timeAgo(post._createdAt) : post.ts}</span>
          </div>
          {canDel && (
            <div style={{ position: "relative", flexShrink: 0 }}>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setLocalMenu((m) => !m);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: T.muted,
                  fontSize: 18,
                  padding: "0 4px",
                  lineHeight: 1,
                }}
              >
                ⋮
              </button>
              {localMenu && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "100%",
                    background: T.hdr,
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    zIndex: 300,
                    minWidth: 110,
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      delPost(post.id);
                      setLocalMenu(false);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "10px 14px",
                      background: "none",
                      border: "none",
                      color: "#cc4444",
                      fontSize: 13,
                      textAlign: "left",
                      fontFamily: "inherit",
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ padding: "10px 12px" }}>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.7,
              color: T.text,
              whiteSpace: "pre-wrap",
              fontFamily: "'IM Fell English',serif",
            }}
          >
            {post.content}
          </p>
          {post.image && (
            <img
              src={post.image}
              alt=""
              style={{
                width: "100%",
                borderRadius: 8,
                marginTop: 10,
                maxHeight: 340,
                objectFit: "cover",
              }}
              onError={(e) => (e.target.style.display = "none")}
            />
          )}
        </div>
        <div
          style={{
            padding: "0 10px 8px",
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
          }}
        >
          {Object.entries(post.r)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([e, v]) => (
              <button
                key={e}
                type="button"
                className="b"
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  react(post.id, e);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  background: T.tag,
                  border: `1px solid ${T.border}`,
                  borderRadius: 20,
                  fontSize: 12,
                  color: T.muted,
                }}
              >
                {e}
                <span style={{ fontSize: 11 }}>{v}</span>
              </button>
            ))}
          {EMOJIS.filter((e) => !post.r[e])
            .slice(0, 2)
            .map((e) => (
              <button
                key={e}
                type="button"
                className="b"
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  react(post.id, e);
                }}
                style={{
                  padding: "3px 6px",
                  background: "transparent",
                  border: `1px dashed ${T.border}`,
                  borderRadius: 20,
                  fontSize: 12,
                  color: T.border,
                }}
              >
                {e}
              </button>
            ))}
        </div>
        <div
          style={{ borderTop: `1px solid ${T.border}`, padding: "7px 12px" }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowC((s) => !s);
            }}
            style={{
              background: "none",
              border: "none",
              color: T.muted,
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            💬 {post.c.length}
          </button>
        </div>
        {showC && (
          <div
            style={{
              borderTop: `1px solid ${T.border}`,
              padding: "10px 12px",
              animation: "fadeIn .2s ease",
            }}
          >
            {post.c.filter((c) => !c.parentId).map((c) => {
              const canDelC = user?.isAdmin || c.uid === uid;
              const replies = post.c.filter((r) => r.parentId === c.id);
              return (
                <div key={c.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 15, flexShrink: 0, display: "flex", alignItems: "center" }}>
                      {renderPic(c.uid && ACCTS[c.uid] ? ACCTS[c.uid].pic : "🌑", 22)}
                    </span>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: T.text, marginRight: 5 }}>{c.un}</span>
                      <span style={{ fontSize: 14, color: T.muted, fontFamily: "'IM Fell English',serif" }}>{c.t}</span>
                      <div style={{ marginTop: 3 }}>
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setReplyTo(replyTo === c.id ? null : c.id); setReplyTxt(""); }}
                          style={{ background: "none", border: "none", color: T.muted, fontSize: 11, cursor: "pointer", padding: 0 }}
                        >↩ Reply{replies.length > 0 ? ` (${replies.length})` : ""}</button>
                      </div>
                    </div>
                    {canDelC && (
                      <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); delC(post.id, c.id); }}
                        style={{ background: "none", border: "none", color: T.danger, fontSize: 12, flexShrink: 0 }}>×</button>
                    )}
                  </div>
                  {replies.map((r) => (
                    <div key={r.id} style={{ display: "flex", gap: 8, marginTop: 6, marginLeft: 24, alignItems: "flex-start", borderLeft: `2px solid ${T.border}`, paddingLeft: 8 }}>
                      <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>{renderPic(r.uid && ACCTS[r.uid] ? ACCTS[r.uid].pic : "🌑", 18)}</span>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: T.text, marginRight: 4 }}>{r.un}</span>
                        <span style={{ fontSize: 13, color: T.muted, fontFamily: "'IM Fell English',serif" }}>{r.t}</span>
                      </div>
                    </div>
                  ))}
                  {replyTo === c.id && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, marginLeft: 24 }}>
                      <input
                        value={replyTxt}
                        onChange={(e) => setReplyTxt(e.target.value)}
                        placeholder={`Reply to ${c.un}…`}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitC(c.id, replyTxt); } }}
                        style={{ ...inp, flex: 1, fontSize: 13, padding: "5px 8px" }}
                        autoFocus
                      />
                      <button type="button" onClick={(e) => { e.preventDefault(); submitC(c.id, replyTxt); }}
                        style={{ background: T.primary, border: "none", color: "#000", fontSize: 12, borderRadius: 6, padding: "5px 10px", fontWeight: 700, cursor: "pointer" }}>↩</button>
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                value={localCTxt}
                onChange={(e) => setLocalCTxt(e.target.value)}
                placeholder="Comment…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitC();
                  }
                }}
                style={{
                  ...inp,
                  borderRadius: 20,
                  padding: "8px 14px",
                  fontSize: 13,
                }}
              />
              <button
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  submitC();
                }}
                style={{
                  padding: "8px 14px",
                  background: T.tag,
                  border: `1px solid ${T.border}`,
                  color: T.primary,
                  borderRadius: 20,
                  fontSize: 14,
                }}
              >
                →
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
);

// ═══════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// CLUBS & CHAMPS data (module-level to avoid TDZ)
// ═══════════════════════════════════════════════════════
export default function Umbra() {
  const [uid, setUid] = useState<string|null>(() => {
    try {
      const s = JSON.parse(localStorage.getItem("umbra_session") || "{}");
      if (s.userId && ACCTS[s.userId]) return s.userId;
    } catch {}
    return null;
  });
  const [screen, setScreen] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem("umbra_session") || "{}");
      if (s.userId && ACCTS[s.userId]) return "app";
    } catch {}
    return "landing";
  });
  const [themeId, setThemeId] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem("umbra_session") || "{}");
      if (s.theme) return s.theme;
    } catch {}
    return "dark";
  });

  // Quiz / reg
  const [qStep, setQStep] = useState(0);
  const [qAns, setQAns] = useState({});
  const [qRes, setQRes] = useState(null);
  const [regPhase, setRegPhase] = useState("quiz");
  const [apexScore, setApexScore] = useState(0);
  const [apexStep, setApexStep] = useState(0);
  const [newUN, setNewUN] = useState("");
  // Live username availability check (runs as the user types on the "claim your name" step)
  const [unStatus, setUnStatus] = useState<"idle" | "checking" | "available" | "taken" | "tooshort" | "invalid">("idle");
  const [unSuggestion, setUnSuggestion] = useState<string>("");
  const [newPW, setNewPW] = useState("");
  const [newPWConfirm, setNewPWConfirm] = useState("");
  const [newGender, setNewGender] = useState("");
  const [newPronouns, setNewPronouns] = useState("");
  const [newMajor, setNewMajor] = useState("");
  const [newBio, setNewBio] = useState("");
  const [newQuote, setNewQuote] = useState("");
  const [academicFocus, setAcademicFocus] = useState<string[]>([]);
  const [personalityTraits, setPersonalityTraits] = useState<string[]>([]);
  const [tierStep, setTierStep] = useState(0);
  const [tierScore, setTierScore] = useState(0);
  const [showWelcome, setShowWelcome] = useState(false);
  // Avatar selection during signup
  const [newPicData, setNewPicData] = useState("");
  const [avatarMode, setAvatarMode] = useState<"preset"|"ai"|"upload">("preset");
  const [aiGenLoading, setAiGenLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [regDone, setRegDone] = useState(false);
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regError, setRegError] = useState("");
  const [pendingTags, setPendingTags] = useState<string[]>([]);

  // ── Live username availability check (debounced 400ms) ──────────────────────
  // Fires whenever `newUN` changes on the signup screen. Checks both NPC names
  // (offline) and real users in Supabase. Sets `unStatus` for inline UI feedback.
  useEffect(() => {
    const raw = newUN.trim();
    if (!raw) { setUnStatus("idle"); setUnSuggestion(""); return; }
    if (raw.length < 2) { setUnStatus("tooshort"); setUnSuggestion(""); return; }
    if (!/^[a-zA-Z0-9 _.-]+$/.test(raw)) { setUnStatus("invalid"); setUnSuggestion(""); return; }
    const cleaned = raw.toLowerCase().replace(/\s+/g, "_");
    setUnStatus("checking");
    setUnSuggestion("");
    let cancelled = false;
    const handle = setTimeout(async () => {
      // 1. Check NPC accounts (synchronous, in-memory) — always works
      const npcTaken = (Object.values(ACCTS) as any[]).some(
        (u: any) => u.un?.toLowerCase() === raw.toLowerCase() || u.un?.toLowerCase().replace(/\s+/g, "_") === cleaned
      );
      if (npcTaken) {
        if (!cancelled) {
          setUnStatus("taken");
          setUnSuggestion(`${cleaned}_${Math.floor(Math.random() * 900) + 100}`);
        }
        return;
      }
      // 2. Race the Supabase check against a hard 3-second timeout. If Supabase
      //    is slow/paused/rate-limited, we optimistically say "available" — the
      //    actual signup flow will catch any real duplicate. This guarantees the
      //    check never spins forever and blocks the user from proceeding.
      let dbTaken = false;
      if (supabase) {
        try {
          const result = await Promise.race([
            supabase.from("profiles").select("id").eq("username", cleaned).maybeSingle(),
            new Promise<{ data: null; error: any }>((resolve) =>
              setTimeout(() => resolve({ data: null, error: new Error("timeout") }), 3000)
            ),
          ]);
          if (result && (result as any).data) dbTaken = true;
        } catch {}
      }
      if (cancelled) return;
      if (dbTaken) {
        setUnStatus("taken");
        setUnSuggestion(`${cleaned}_${Math.floor(Math.random() * 900) + 100}`);
      } else {
        setUnStatus("available");
        setUnSuggestion("");
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [newUN]);

  // Login
  const [lid, setLid] = useState("");
  const [lpw, setLpw] = useState("");
  const [lerr, setLerr] = useState("");

  // Nav
  const [nav, setNav] = useState("feed");
  const [subPages, setSubPages] = useState({});
  const subPage = subPages[nav] || null;
  const setSubPage = useCallback(
    (s) => setSubPages((p) => ({ ...p, [nav]: s })),
    [nav]
  );
  const [profId, setProfId] = useState(null);
  const [serverProfileTraits, setServerProfileTraits] = useState<Record<string, string[]>>({});
  const [serverProfilePics, setServerProfilePics] = useState<Record<string, string>>({});
  // Tracks pids we've already attempted so we never re-fetch (even on 404)
  const profileFetchTriedRef = useRef(new Set<string>());

  // Feed
  const [posts, setPosts] = useState(() => {
    // Restore from localStorage so likes/comments/reactions survive page refresh
    try {
      const saved = localStorage.getItem("umbra:posts:v1");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return INIT_POSTS;
  });
    const [compose, setCompose] = useState(false);
  const [pTxt, setPTxt] = useState("");
  const [pImg, setPImg] = useState("");
  const [imgUploading, setImgUploading] = useState(false);
  const [activeC, setActiveC] = useState(null);
  const [cTxt, setCTxt] = useState("");
  const [menuPost, setMenuPost] = useState(null);
  const [feedTab, setFeedTab] = useState("all");

  // Social
  const [follows, setFollows] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("umbra_follows") || "[]")); } catch { return new Set(); }
  });
  const [myFollowingDelta, setMyFollowingDelta] = useState(0);

  // DMs
  const [dmOpen, setDmOpen] = useState(false);
  const [dmConvId, setDmConvId] = useState<string|null>(null);
  const dmConvIdRef = useRef<string|null>(null); // stable ref for use inside loadDms closure
  const msgBottomRef = useRef<HTMLDivElement>(null); // scroll-to-bottom for DM conversation
  const [dmMessages, setDmMessages] = useState<any[]>([]);
  const [dmTxt, setDmTxt] = useState("");
  const [dmSending, setDmSending] = useState(false);
  const [dmTyping, setDmTyping] = useState(false);
  const [dmLastSeen, setDmLastSeen] = useState<Record<string,string>>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_dm_seen") || "{}"); } catch { return {}; }
  });
  const dmPicRef = useRef<HTMLInputElement>(null);

  // Portal — first-come-first-serve claims
  const [portalClaims, setPortalClaims] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_portal_claims") || "{}"); } catch { return {}; }
  });
  const [portalTab, setPortalTab] = useState<"pets"|"favors"|"virginity">("pets");
  const [bagTab, setBagTab] = useState("all");
  const [interactionModal, setInteractionModal] = useState<{open:boolean; listing:any; response:string|null; action:string|null}>({ open:false, listing:null, response:null, action:null });
  const [loanModal, setLoanModal] = useState<{open:boolean; petId:string|null; search:string; targetId:string|null; terms:string}>({ open:false, petId:null, search:"", targetId:null, terms:"Standard loan — 2 weeks. No modification. Return in original condition." });

  // Trent relationship
  const [trentRel, setTrentRel] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_trent_rel") || "{}"); } catch { return {}; }
  });

  // Trent long-term memory (per user, persisted server-side in profile.trentMemory)
  const [trentMemory, setTrentMemory] = useState<string>("");

  // Cyrus relationship — parallel to Trent's. Points keyed by current uid.
  const [cyrusRel, setCyrusRel] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_cyrus_rel") || "{}"); } catch { return {}; }
  });

  // Auction
  const [aTab, setATab] = useState("live");
  const [liveBid, setLiveBid] = useState(34500);
  const [liveBidCount, setLiveBidCount] = useState(14);
  const [bidInput, setBidInput] = useState("");
  const [myBids, setMyBids] = useState([]);
  const [selectedLot, setSelectedLot] = useState(null);

  // Confessions
  const [confs, setConfs] = useState(INIT_CONFS);
  const [confTxt, setConfTxt] = useState("");
  const [showConfC, setShowConfC] = useState(false);
  const [activeConfC, setActiveConfC] = useState(null);
  const [confCTxt, setConfCTxt] = useState("");

  // QnA
  const [qna, setQna] = useState(QNA_INIT);
  const [qTxt, setQTxt] = useState("");
  const [qTab, setQTab] = useState("all");

  // Twisted
  const [tVotes, setTVotes] = useState({});

  // Parties
  const [activeEventC, setActiveEventC] = useState(null);
  const [eventCTxt, setEventCTxt] = useState("");
  const [parties, setParties] = useState(PARTIES);

  // Notif
  const [notif, setNotif] = useState(null);

  // University
  const [viewingProfId, setViewingProfId] = useState<string|null>(null);
  const [profDMHistory, setProfDMHistory] = useState<Record<string,{role:string,content:string}[]>>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_prof_dm_history") || "{}"); } catch { return {}; }
  });
  const [profDMInput, setProfDMInput] = useState("");
  const [profDMLoading, setProfDMLoading] = useState(false);
  const [profBookingType, setProfBookingType] = useState("Grade Review");
  const [profBookingsDone, setProfBookingsDone] = useState<Record<string,boolean>>({});

  // Admin panel
  const [adminFundTarget, setAdminFundTarget] = useState("");
  const [adminFundAmt, setAdminFundAmt] = useState("");

  // Clubs & Championships state (hoisted to fix hook ordering bug)
  const [selClub, setSelClub] = useState(null);
  const [clubCTxt, setClubCTxt] = useState("");
  const [clubsData, setClubsData] = useState(CLUBS);
  const [selChamp, setSelChamp] = useState(null);
  const [champCTxt, setChampCTxt] = useState("");
  const [champsData, setChampsData] = useState(CHAMPS);

  // Inventory (purchased pets / items)
  const [inventory, setInventory] = useState<any[]>(() => {
    // loaded via useEffect per-user
    return [];
  });

  // Timetable state
  const [ttCov, setTtCov] = useState("crowns");
  const [ttYear, setTtYear] = useState("Freshman");

  // Hottest rankings state (hoisted — called conditionally as function)
  const [hCat, setHCat] = useState(0);
  const [hVotes, setHVotes] = useState<Record<string,boolean>>({});
  const [hCommentOpen, setHCommentOpen] = useState<string|null>(null);
  const [hCTxt, setHCTxt] = useState("");
  const [hottestData, setHottestData] = useState(HOTTEST_CATS);

  // Shop category state (hoisted from ChampPage)
  const [localShopCat, setLocalShopCat] = useState("all");

  // Pet management state (for masters)
  const [clubQuiz, setClubQuiz] = useState<{clubId:string,step:number,score:number,done:boolean}|null>(null);
  const [viewingPetId, setViewingPetId] = useState<string|null>(null);
  const [petActionLog, setPetActionLog] = useState<Record<string,string[]>>({});
  const [petNav, setPetNav] = useState("collar");
  const [completedCmds, setCompletedCmds] = useState<string[]>([]);
  const [collarBattery, setCollarBattery] = useState(72);

  // Club notice board
  const [noticeTxt, setNoticeTxt] = useState("");
  const [clubNotices, setClubNotices] = useState<any[]>([
    { id: "cn1", clubId: "cl1", author: "Vii Imperator", text: "Crowns open recruitment — Apex/Ascendant applications only. Submit pedigree to senate office.", ts: "2h" },
    { id: "cn2", clubId: "cl2", author: "Sebastian Blackwood", text: "Blackwood Society: invitation night this Friday. Formal dress. Omertà applies.", ts: "1d" },
    { id: "cn3", clubId: "cl4", author: "Marcus Vale", text: "Blades Combat Society: tryouts Monday at Garrison. Show up ready.", ts: "3h" },
  ]);

  // ── PROFILE EDITING ──
  const [editProfile, setEditProfile] = useState(false);
  const [editUn, setEditUn] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editHandle, setEditHandle] = useState("");
  const [editPw, setEditPw] = useState("");

  // ── AI Credentials (stored locally only, never in DB) ────────────────────
  const AI_CREDS_KEY = "umbra_ai_creds";
  const getAiCreds = (): { apiBase: string; apiKey: string; model: string } => {
    try { return JSON.parse(localStorage.getItem(AI_CREDS_KEY) || "{}"); } catch { return { apiBase: "", apiKey: "", model: "" }; }
  };
  const saveAiCreds = (creds: { apiBase: string; apiKey: string; model: string }) => {
    try { localStorage.setItem(AI_CREDS_KEY, JSON.stringify(creds)); } catch {}
  };
  const [aiApiBase, setAiApiBase] = useState(() => getAiCreds().apiBase || "");
  const [aiApiKey, setAiApiKey] = useState(() => getAiCreds().apiKey || "");
  const [aiModel, setAiModel] = useState(() => getAiCreds().model || "");
  // Test-connection state for Settings UI
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showDmAiPanel, setShowDmAiPanel] = useState(false);
  const hasUserAiKey = Boolean(aiApiBase.trim() && aiApiKey.trim() && aiModel.trim());
  const [editSaving, setEditSaving] = useState(false);
  const [profileFrame, setProfileFrame] = useState<string>("none");
  useEffect(() => {
    if (!uid) return;
    try {
      const fs = JSON.parse(localStorage.getItem("umbra_frames") || "{}");
      if (fs[uid]) { setProfileFrame(fs[uid]); return; }
      const acct = (Object.values(ACCTS) as any[]).find((u: any) => u.id === uid);
      setProfileFrame(acct?.defFrame || "none");
    } catch {}
  }, [uid]);
  // Reload inventory per-user when account switches
  useEffect(() => {
    if (!uid) return;
    try { setInventory(JSON.parse(localStorage.getItem(`umbra_inventory_${uid}`) || "[]")); } catch {}
  }, [uid]);

  // ── DM MONEY TRANSFER ──
  const [dmMoneyMode, setDmMoneyMode] = useState(false);
  const [dmMoneyAmt, setDmMoneyAmt] = useState("");
  const [dmMoneyNote, setDmMoneyNote] = useState("");

  // ── GROUP CHAT ──
  const [groups, setGroups] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_groups") || "[]"); } catch { return []; }
  });
  const [activeGroupId, setActiveGroupId] = useState<string|null>(null);
  const [groupTxt, setGroupTxt] = useState("");
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState("");
  // Selected member IDs (for the new chip-style picker on group create) and
  // the current search query that drives the @ autocomplete dropdown.
  const [groupMemberPicks, setGroupMemberPicks] = useState<string[]>([]);
  const [groupMemberQuery, setGroupMemberQuery] = useState("");
  // Query for the "start a new DM" search box at the top of the DMs tab.
  const [newDmQuery, setNewDmQuery] = useState("");
  const [messagesTab, setMessagesTab] = useState<"dms"|"groups">("dms");

  // ── FORUM ──
  const [forumPosts, setForumPosts] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem("umbra_forum");
      if (saved) return JSON.parse(saved);
    } catch {}
    return [
      { id: "fp1", uid: "vii_imperator", un: "Vii Imperator", pic: "⚜️", cov: "crowns", ts: "2h ago", title: "What do you actually owe the covenant?", body: "Curious how people interpret the loyalty clause. The wording is deliberately vague.", comments: [{ id: "fc1", uid: "sebastian_blackwood", un: "Sebastian Blackwood", t: "It's vague because ambiguity is a tool. The answer is: whatever is asked of you.", ts: "1h ago" }], votes: 47 },
      { id: "fp2", uid: "elara_saint", un: "Elara Saint", pic: "🌹", cov: "veil", ts: "5h ago", title: "Relief Room — what nobody discusses", body: "Third visit this semester. I have questions I cannot ask anyone in person.", comments: [], votes: 82 },
      { id: "fp3", uid: "dorian_ashford", un: "Dorian Ashford", pic: "🎭", cov: "reverie", ts: "1d ago", title: "The Voss lab is recruiting again", body: "Posted on the faculty board this morning. Research Assistant, NDA required. Compensation: significant. Anyone applied?", comments: [{ id: "fc2", uid: "nadia_maris", un: "Nadia Maris", t: "Applied last week. They called the same day. Interview was not what I expected.", ts: "20h ago" }], votes: 134 },
    ];
  });
  const [forumView, setForumView] = useState<string|null>(null);
  const [forumTxt, setForumTxt] = useState("");
  const [forumCompose, setForumCompose] = useState(false);
  const [forumTitle, setForumTitle] = useState("");
  const [forumBody, setForumBody] = useState("");

  // ── USER SEARCH ──
  const [userSearch, setUserSearch] = useState("");

  // ── NOCTIS WALLET & MARKET ──
  const WALLET_INIT: Record<string,number> = {
    // Apex tier — ₦500,000 base
    ket_white: 500000, vii_imperator: 9999999, sebastian_blackwood: 500000,
    nathaniel_cross: 500000, elara_saint: 500000, mercurial_cosmona: 500000,
    lucian_vane: 500000, sable_cross: 500000, aurelia_vale: 500000,
    roman_blackwood: 500000, caelum_noir: 500000, isadora_knight: 500000,
    // Ascendant tier — ₦50,000 base
    cordelia_vane: 50000, dorian_ashford: 50000, isadora_mercer: 50000,
    vivienne_sterling: 50000, marcus_vale: 50000, tobias_wren: 50000,
    celeste_noir: 50000, dorian_voss: 50000,
    irina_sorel: 50000, alistair_grey: 50000, petra_volkov: 50000,
    emile_beaumont: 50000, seraphine_lace: 50000, dex_harlow: 50000,
    nadia_maris: 50000, theron_ashe: 50000,
    // Merit tier — ₦50,000 base
    remy_noire: 50000, isolde_crane: 50000, felix_harrow: 50000, lyra_dusk: 50000,
    elena_hart: 50000, noah_park: 50000, miriam_cross: 50000, callum_reed: 50000,
    selene_grey: 50000, anya_sol: 50000, kieran_ash: 50000, mei_zhang: 50000,
    jasper_cole: 50000, amara_obi: 50000, luca_romani: 50000, zara_west: 50000,
    ivan_petrov: 50000, grace_adeyemi: 50000, ben_castle: 50000, priya_sharma: 50000,
    tommy_briggs: 50000, yuki_tanaka: 50000,
    // Faculty
    victoria_ashford: 50000,
  };
  const getInitBal = (id: string) => {
    try {
      const saved = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
      if (saved[id] !== undefined) return saved[id];
    } catch (e) {}
    return WALLET_INIT[id] ?? 50000;
  };
  // ── Reusable user-mention matcher ──────────────────────────────────────────
  // Returns up to 8 ACCTS entries whose handle/un loosely matches the query.
  // Used by the send-money search and the DM autocomplete dropdown.
  // - Strips a leading "@" from the query
  // - Matches against u.un, u.handle, u.id (case-insensitive substring)
  // - Excludes guests and an optional list of already-picked IDs
  const userMentionMatches = useCallback((rawQuery: string, excludeIds: string[] = []): any[] => {
    const q = rawQuery.replace(/^@/, "").trim().toLowerCase();
    if (!q || q.length < 1) return [];
    const exclude = new Set(excludeIds);
    return (Object.values(ACCTS) as any[])
      .filter((u: any) => {
        if (!u?.un || u.isGuest) return false;
        if (exclude.has(u.id)) return false;
        const un = (u.un || "").toLowerCase();
        const handle = (u.handle || "").toLowerCase().replace(/^@/, "");
        const id = (u.id || "").toLowerCase();
        return un.includes(q) || handle.includes(q) || id.includes(q);
      })
      .sort((a: any, b: any) => {
        // Prefer real users, then exact-prefix matches, then alpha
        const aReal = a._real || a.isReal ? 0 : 1;
        const bReal = b._real || b.isReal ? 0 : 1;
        if (aReal !== bReal) return aReal - bReal;
        const aStart = (a.un || "").toLowerCase().startsWith(q) ? 0 : 1;
        const bStart = (b.un || "").toLowerCase().startsWith(q) ? 0 : 1;
        if (aStart !== bStart) return aStart - bStart;
        return (a.un || "").localeCompare(b.un || "");
      })
      .slice(0, 8);
    // Empty deps: ACCTS is a module-level mutable object — Object.values()
    // always reads its current state. Adding acctVer here would create a TDZ
    // crash since acctVer is declared later in this component.
  }, []);

  // ── Tier → starting balance helper (single source of truth) ────────────────
  // Apex 500k · Ascendant 100k · Merit 50k. Used by signup AND the one-time
  // migration that bumps existing under-funded accounts to their tier minimum.
  const tierStartBal = (tier: string | undefined): number => {
    const t = (tier || "").toLowerCase();
    if (t === "apex" || t === "faculty") return 500000;
    if (t === "ascendant") return 100000;
    return 50000; // merit / commoner / pet / anything else
  };
  // Safety net: if regSubmitting somehow stays true for > 35s (a hung promise,
  // a runaway state, anything), force-reset it so the button isn't stuck. Set
  // above the signup timeout (30s) so a slow but valid Supabase signup is never
  // killed mid-flight by the safety reset.
  useEffect(() => {
    if (!regSubmitting) return;
    const t = setTimeout(() => {
      console.warn("[safety] regSubmitting stuck >35s, force-resetting");
      setRegSubmitting(false);
    }, 35000);
    return () => clearTimeout(t);
  }, [regSubmitting]);

  // Background drain — retries pending signups every 20s. When network or
  // Supabase recovers, the queued account gets created online and the user's
  // local tempId is silently promoted to the real Supabase UUID. This is what
  // makes "Failed to fetch" survivable: the user enters the app immediately,
  // and within ~20s of the network coming back, their account is cross-device.
  useEffect(() => {
    let stopped = false;
    const drain = async () => {
      if (stopped) return;
      let pending: any[] = [];
      try { pending = JSON.parse(localStorage.getItem("umbra_pending_signups") || "[]"); } catch {}
      if (pending.length === 0) return;
      const next: any[] = [];
      for (const p of pending) {
        if (p.attempts >= 60) continue; // give up after 60 tries (~20min)
        try {
          const r = await fetch("/api/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: p.username, password: p.password, profile: p.profile }),
          });
          if (r.ok) {
            const data = await r.json().catch(() => ({}));
            if (data.user?.id && p.localId) {
              // Promote: replace tempId with real Supabase UUID in all stores
              const realId = data.user.id;
              const tempAcct = ACCTS[p.localId];
              if (tempAcct) {
                ACCTS[realId] = { ...tempAcct, id: realId, _pending: false };
                delete ACCTS[p.localId];
              }
              try {
                const wb = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
                if (wb[p.localId] !== undefined) { wb[realId] = wb[p.localId]; delete wb[p.localId]; localStorage.setItem("umbra_wallets", JSON.stringify(wb)); }
              } catch {}
              try {
                const myKey = `umbra_my_posts_${p.localId}`;
                const backup = JSON.parse(localStorage.getItem(myKey) || "[]");
                if (backup.length) {
                  const remapped = backup.map((post: any) => ({ ...post, userId: realId }));
                  localStorage.setItem(`umbra_my_posts_${realId}`, JSON.stringify(remapped));
                  localStorage.removeItem(myKey);
                }
              } catch {}
              try {
                const pwStore = JSON.parse(localStorage.getItem("umbra_pw_store") || "{}");
                pwStore[realId] = p.password;
                localStorage.setItem("umbra_pw_store", JSON.stringify(pwStore));
              } catch {}
              // If the current user IS the one being promoted, swap their uid
              if (uid === p.localId) {
                setUid(realId);
                saveSession(realId, "dark");
              }
              setAcctVer(v => v + 1);
              console.log(`[drain] ✅ promoted ${p.localId} → ${realId}`);
              toast("✓ Your account is now synced online. Cross-device login is active.");
            }
            continue; // success — drop from queue
          }
          if (r.status === 409) {
            console.log(`[drain] username "${p.username}" taken on server; dropping from queue`);
            continue;
          }
        } catch (err) {
          console.log(`[drain] attempt ${p.attempts + 1} failed for ${p.username}`);
        }
        next.push({ ...p, attempts: (p.attempts || 0) + 1 });
      }
      try { localStorage.setItem("umbra_pending_signups", JSON.stringify(next)); } catch {}
    };
    // Run after 5s, then every 20s
    const initial = setTimeout(drain, 5000);
    const iv = setInterval(drain, 20000);
    return () => { stopped = true; clearTimeout(initial); clearInterval(iv); };
    // Empty deps on purpose — saveSession + toast + setUid are stable (declared
    // later in the component, would trigger a TDZ ReferenceError if included).
    // The drain reads uid via the current setter closure when it promotes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time migration: bring existing real-user wallets up to tier minimum.
  // Runs whenever `uid` changes (i.e. login/refresh). A localStorage flag
  // ensures we never re-pay the same browser session. Only ever INCREASES
  // balances — users who earned more than their tier amount are untouched.
  // We wait for at least one real user to be in ACCTS before marking done,
  // since ACCTS is loaded asynchronously from localStorage + Supabase.
  useEffect(() => {
    try {
      if (localStorage.getItem("umbra_balance_tier_migration_v1") === "done") return;
      const wallets: Record<string, number> = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
      let changed = false;
      let realFound = false;
      Object.values(ACCTS).forEach((u: any) => {
        if (!u?.id || (!u._real && !u.isReal)) return;
        realFound = true;
        const min = tierStartBal(u.tier);
        const cur = wallets[u.id];
        if (cur === undefined || cur < min) {
          wallets[u.id] = min;
          changed = true;
        }
      });
      if (changed) localStorage.setItem("umbra_wallets", JSON.stringify(wallets));
      if (realFound) {
        localStorage.setItem("umbra_balance_tier_migration_v1", "done");
        if (uid && wallets[uid] !== undefined) setWalletBalance(wallets[uid]);
      }
    } catch {}
  }, [uid]);

  // Wallet state
  // ── LIVE AUCTION SYSTEM ──
  const [liveAuctions, setLiveAuctions] = useState<any[]>([]);
  const [auctionHistory, setAuctionHistory] = useState<any[]>([]);
  const [myActiveAuction, setMyActiveAuction] = useState<any>(null);
  const [auctionBidInput, setAuctionBidInput] = useState<Record<string, string>>({});
  const [auctionBidding, setAuctionBidding] = useState<Record<string, boolean>>({});
  const [auctionBidHistory, setAuctionBidHistory] = useState<Record<string, any[]>>({});
  const [isPetStatus, setIsPetStatus] = useState(false);
  const petAuctionPostedRef = useRef(false); // prevents duplicate auction POSTs on every walletBalance sync


  const fetchLiveAuctions = useCallback(async () => {
    try {
      const [aRes, hRes] = await Promise.all([
        fetch("/api/auctions"),
        fetch("/api/auctions/history"),
      ]);
      if (aRes.ok) { const d = await aRes.json(); setLiveAuctions(d.auctions || []); }
      if (hRes.ok) { const d = await hRes.json(); setAuctionHistory(d.auctions || []); }
    } catch {}
  }, []);

  // Poll auctions every 30 seconds when user is on the auction tab
  useEffect(() => {
    fetchLiveAuctions();
    const iv = setInterval(fetchLiveAuctions, 30 * 60 * 1000); // 30 min — auctions last 24h
    return () => clearInterval(iv);
  }, [fetchLiveAuctions]);

  // Check user's own auction status
  useEffect(() => {
    if (!uid) return;
    fetch(`/api/auctions/user/${uid}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.auction) setMyActiveAuction(d.auction); })
      .catch(() => {});
  }, [uid]);

  // ── BANKRUPTCY ──
  const [isBankrupt, setIsBankrupt] = useState(false);
  const [bankruptcyCount, setBankruptcyCount] = useState(() => {
    try { return parseInt(localStorage.getItem("umbra_bankruptcy_count") || "0"); } catch { return 0; }
  });
  const [debtOwed, setDebtOwed] = useState(() => {
    try { return parseInt(localStorage.getItem("umbra_debt_owed") || "0"); } catch { return 0; }
  });

  const [walletBalance, setWalletBalance] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
      const s = JSON.parse(localStorage.getItem("umbra_session") || "{}");
      if (s.userId && saved[s.userId] !== undefined) return saved[s.userId];
    } catch (e) {}
    return 5000;
  });
  const [purchases, setPurchases] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_purchases") || "[]"); } catch (e) { return []; }
  });
  const [reviews, setReviews] = useState<Record<string, any[]>>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_reviews") || "{}"); } catch (e) { return {}; }
  });
  const [wishlist, setWishlist] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("umbra_wishlist") || "[]")); } catch (e) { return new Set(); }
  });
  const [cart, setCart] = useState<any[]>([]);
  const [referralCode, setReferralCode] = useState<string>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_referral") || "{}").code || ""; } catch (e) { return ""; }
  });
  const [referrals, setReferrals] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_referral") || "{}").list || []; } catch (e) { return []; }
  });
  const [dailyClaimed, setDailyClaimed] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_daily") || "{}").claimed || false; } catch (e) { return false; }
  });
  const [dailyStreak, setDailyStreak] = useState<number>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_daily") || "{}").streak || 0; } catch (e) { return 0; }
  });
  const [lastDailyClaim, setLastDailyClaim] = useState<Date | null>(() => {
    try {
      const d = JSON.parse(localStorage.getItem("umbra_daily") || "{}").lastClaim;
      return d ? new Date(d) : null;
    } catch (e) { return null; }
  });
  const [ageVerified, setAgeVerified] = useState<boolean>(false);
  const [shopTab, setShopTab] = useState("shop");
  const [ratingModal, setRatingModal] = useState<{ open: boolean; itemId: string | null; itemName: string }>({ open: false, itemId: null, itemName: "" });
  const [ratingValue, setRatingValue] = useState(5);
  const [ratingComment, setRatingComment] = useState("");
  const [giftModal, setGiftModal] = useState<{ open: boolean; itemId: string | null; itemName: string; price: number }>({ open: false, itemId: null, itemName: "", price: 0 });
  const [giftUser, setGiftUser] = useState("");
  const [giftMessage, setGiftMessage] = useState("");
  const [walletSendTo, setWalletSendTo] = useState("");
  const [walletSendAmt, setWalletSendAmt] = useState("");
  const [walletSendNote, setWalletSendNote] = useState("");
  const [walletPageTab, setWalletPageTab] = useState<"overview"|"send"|"history">("overview");

  // Persist helpers
  const saveWalletToLS = useCallback((id: string, bal: number) => {
    try {
      const saved = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
      saved[id] = bal;
      localStorage.setItem("umbra_wallets", JSON.stringify(saved));
    } catch (e) {}
    // Server sync happens via the 30-min profile PATCH (doSync) — no per-change push needed.
    // Same-device refresh uses localStorage (always current). Cross-device gets balance at next 30-min sync.
  }, []);
  const savePurchasesToLS = useCallback((list: any[]) => {
    try { localStorage.setItem("umbra_purchases", JSON.stringify(list)); } catch (e) {}
  }, []);
  const saveReviewsToLS = useCallback((data: any) => {
    try { localStorage.setItem("umbra_reviews", JSON.stringify(data)); } catch (e) {}
  }, []);
  const saveWishlistToLS = useCallback((arr: string[]) => {
    try { localStorage.setItem("umbra_wishlist", JSON.stringify(arr)); } catch (e) {}
  }, []);
  const saveReferralToLS = useCallback((code: string, list: any[]) => {
    try { localStorage.setItem("umbra_referral", JSON.stringify({ code, list })); } catch (e) {}
  }, []);
  const saveDailyToLS = useCallback((claimed: boolean, streak: number, lastClaim: any) => {
    try { localStorage.setItem("umbra_daily", JSON.stringify({ claimed, streak, lastClaim })); } catch (e) {}
  }, []);

  // ── XP & ACADEMIC PROGRESS ──
  const [userXP, setUserXP] = useState<number>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_xp") || "{}"); return d[uid] ?? 0; } catch { return 0; }
  });
  const [completedLessons, setCompletedLessons] = useState<string[]>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_lessons") || "{}"); return d[uid] ?? []; } catch { return []; }
  });
  const [completedClassQuizzes, setCompletedClassQuizzes] = useState<string[]>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_cquiz") || "{}"); return d[uid] ?? []; } catch { return []; }
  });
  const [enrolledClasses, setEnrolledClasses] = useState<string[]>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_enrolled") || "{}"); return d[uid] ?? []; } catch { return []; }
  });
  const [clubActivitiesDone, setClubActivitiesDone] = useState<string[]>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_club_act") || "{}"); return d[uid] ?? []; } catch { return []; }
  });
  const [academicsView, setAcademicsView] = useState<{classId:string,view:"lessons"|"quiz",lessonIdx?:number,quizIdx?:number}|null>(null);
  const [acSelClass, setAcSelClass] = useState<string|null>(null);
  const [acClassView, setAcClassView] = useState<"lessons"|"quiz">("lessons");
  const [acActiveQuiz, setAcActiveQuiz] = useState<number>(0);
  const [acQuizAnswered, setAcQuizAnswered] = useState<number|null>(null);

  // ── INFLUENCE & POPULARITY ──
  const _infFloor = (t?: string) => t === "apex" ? 1000 : t === "ascendant" ? 500 : t === "pet" ? 0 : 100;
  const [userInfluence, setUserInfluence] = useState<number>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_influence") || "{}"); const tier = (ACCTS[uid] as any)?.tier; const floor = _infFloor(tier); return Math.max(floor, d[uid] ?? floor); } catch { return 100; }
  });
  const [userPopularity, setUserPopularity] = useState<number>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_popularity") || "{}"); return d[uid] ?? 100; } catch { return 100; }
  });
  const addInfluence = useCallback((amount: number) => {
    setUserInfluence(prev => {
      const n = Math.max(0, prev + amount);
      try { const d = JSON.parse(localStorage.getItem("umbra_influence") || "{}"); d[uid] = n; localStorage.setItem("umbra_influence", JSON.stringify(d)); } catch {}
      return n;
    });
  }, [uid]);

  // ── ACHIEVEMENTS ──
  const [userAchievements, setUserAchievements] = useState<string[]>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_achievements") || "{}"); return d[uid] ?? []; } catch { return []; }
  });
  const unlockAchievement = useCallback((id: string, name: string, reward: {money?: number; influence?: number; xp?: number}) => {
    setUserAchievements(prev => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      try { const d = JSON.parse(localStorage.getItem("umbra_achievements") || "{}"); d[uid] = next; localStorage.setItem("umbra_achievements", JSON.stringify(d)); } catch {}
      if (reward.money) setWalletBalance(b => { const nb = b + reward.money!; try { const d = JSON.parse(localStorage.getItem("umbra_wallets")||"{}"); d[uid]=nb; localStorage.setItem("umbra_wallets",JSON.stringify(d)); } catch {} return nb; });
      if (reward.influence) addInfluence(reward.influence);
      if (reward.xp) setUserXP(x => { const nx = x + reward.xp!; try { const d = JSON.parse(localStorage.getItem("umbra_xp")||"{}"); d[uid]=nx; localStorage.setItem("umbra_xp",JSON.stringify(d)); } catch {} return nx; });
      toast(`🏅 Achievement Unlocked: ${name}!`);
      return next;
    });
  }, [uid, addInfluence]);

  // ── WARNINGS & PENALTIES ──
  const [userWarnings, setUserWarnings] = useState<number>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_warnings") || "{}"); return d[uid] ?? 0; } catch { return 0; }
  });

  // ── RELOAD ALL USER-SCOPED STATE ON UID CHANGE ──────────────────────────────
  // Fixes: influence/xp/progress missing on refresh for real (non-hardcoded) users
  // because uid=null when lazy initializers run, and influence/popularity were never
  // restored in any login path.
  useEffect(() => {
    if (!uid) return;
    try { const d = JSON.parse(localStorage.getItem("umbra_xp") || "{}"); if (d[uid] !== undefined) setUserXP(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_influence") || "{}"); const tier = (ACCTS[uid] as any)?.tier; const floor = _infFloor(tier); const inf = d[uid] ?? floor; const clamped = Math.max(floor, inf); if (clamped !== d[uid]) { d[uid] = clamped; localStorage.setItem("umbra_influence", JSON.stringify(d)); } setUserInfluence(clamped); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_popularity") || "{}"); if (d[uid] !== undefined) setUserPopularity(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_lessons") || "{}"); if (d[uid] !== undefined) setCompletedLessons(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_cquiz") || "{}"); if (d[uid] !== undefined) setCompletedClassQuizzes(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_enrolled") || "{}"); if (d[uid] !== undefined) setEnrolledClasses(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_club_act") || "{}"); if (d[uid] !== undefined) setClubActivitiesDone(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_achievements") || "{}"); if (d[uid] !== undefined) setUserAchievements(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_warnings") || "{}"); if (d[uid] !== undefined) setUserWarnings(d[uid]); } catch {}
    try { const d = JSON.parse(localStorage.getItem("umbra_job_hours") || "{}"); const saved = d[uid]; if (saved && Date.now() - saved.ts <= 7*24*60*60*1000) setJobHoursThisWeek(saved.hours ?? 0); else if (saved) setJobHoursThisWeek(0); } catch {}
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── JOB SYSTEM ──
  const [jobHoursThisWeek, setJobHoursThisWeek] = useState<number>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_job_hours") || "{}"); const saved = d[uid]; if (!saved) return 0; if (Date.now() - saved.ts > 7*24*60*60*1000) return 0; return saved.hours ?? 0; } catch { return 0; }
  });
  const [jobWorking, setJobWorking] = useState<boolean>(false);
  const [jobProgress, setJobProgress] = useState<number>(0);
  const [jobBonusEvent, setJobBonusEvent] = useState<string|null>(null);

  // ── CASINO ──
  const [casinoGame, setCasinoGame] = useState<"blackjack"|"roulette"|"slots">("blackjack");
  const [casinoBet, setCasinoBet] = useState<number>(500);
  // Blackjack state
  const [bjDeck, setBjDeck] = useState<number[]>([]);
  const [bjPlayer, setBjPlayer] = useState<number[]>([]);
  const [bjDealer, setBjDealer] = useState<number[]>([]);
  const [bjPhase, setBjPhase] = useState<"idle"|"playing"|"done">("idle");
  const [bjResult, setBjResult] = useState<string>("");
  // Roulette state
  const [rlBetType, setRlBetType] = useState<"red"|"black"|"number"|"odd"|"even">("red");
  const [rlNumber, setRlNumber] = useState<number>(7);
  const [rlResult, setRlResult] = useState<number|null>(null);
  const [rlSpinning, setRlSpinning] = useState(false);
  // Slots state
  const [slotsReels, setSlotsReels] = useState<string[]>(["🌹","💎","🌑"]);
  const [slotsSpinning, setSlotsSpinning] = useState(false);
  const [slotsResult, setSlotsResult] = useState<string>("");
  const [casinoWins, setCasinoWins] = useState<number>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_casino") || "{}"); return d[uid]?.wins ?? 0; } catch { return 0; }
  });
  const [casinoLosses, setCasinoLosses] = useState<number>(() => {
    try { const d = JSON.parse(localStorage.getItem("umbra_casino") || "{}"); return d[uid]?.losses ?? 0; } catch { return 0; }
  });

  // ── GOSSIP ──
  const [gossipPosts, setGossipPosts] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_gossip") || "[]"); } catch { return []; }
  });
  const [gossipLoading, setGossipLoading] = useState(false);
  const [forumGossipTab, setForumGossipTab] = useState<"forum"|"gossip">("forum");
  const [gossipTarget, setGossipTarget] = useState("");
  const [gossipText, setGossipText] = useState("");
  const [gossipDrafting, setGossipDrafting] = useState(false);
  const [gossipPosting, setGossipPosting] = useState(false);

  // ── LEADERBOARD (lifted from LeaderboardPage to fix hooks error) ──
  const [lbTab, setLbTab] = useState<"reputation"|"wealth"|"xp"|"posts">("reputation");
  const [lbData, setLbData] = useState<any[]>(() => {
    try { const c = JSON.parse(localStorage.getItem("umbra_lb_cache") || "null"); return Array.isArray(c) ? c : []; } catch { return []; }
  });
  const [lbLoading, setLbLoading] = useState(false);
  const [lbUpdatedAt, setLbUpdatedAt] = useState<string>(() => {
    try { return localStorage.getItem("umbra_lb_updated_at") || ""; } catch { return ""; }
  });

  // ── GOSSIP-PAGE-INNER (lifted to fix hooks error) ──
  const [gossipPageExpanded, setGossipPageExpanded] = useState<string|null>(null);
  const [gossipPageReplyTxt, setGossipPageReplyTxt] = useState("");
  const [gossipPagePosts, setGossipPagePosts] = useState<any[]>([]);

  // ── RUMOURS ──
  const [rumours, setRumours] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("umbra_rumours") || "[]"); } catch { return []; }
  });
  const [rumourLoading, setRumourLoading] = useState(false);
  const [spreadRumourTarget, setSpreadRumourTarget] = useState<string>("");
  const [spreadRumourType, setSpreadRumourType] = useState<string>("romantic");
  const [showRumourModal, setShowRumourModal] = useState(false);

  const saveXPToLS = useCallback((id: string, xp: number) => {
    try { const d = JSON.parse(localStorage.getItem("umbra_xp") || "{}"); d[id] = xp; localStorage.setItem("umbra_xp", JSON.stringify(d)); } catch {}
  }, []);
  const addXP = useCallback((amount: number) => {
    setUserXP(prev => {
      const n = prev + amount;
      saveXPToLS(uid, n);
      // Sync XP to Supabase so the leaderboard shows it on all devices
      if (uid && !(ACCTS[uid] as any)?._npc) {
        fetch("/api/auth/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uid, xp: n }),
        }).catch(() => {});
      }
      return n;
    });
  }, [uid, saveXPToLS]);
  const enrollClass = useCallback((classId: string) => {
    setEnrolledClasses(prev => {
      if (prev.includes(classId)) return prev;
      const next = [...prev, classId];
      try { const d = JSON.parse(localStorage.getItem("umbra_enrolled") || "{}"); d[uid] = next; localStorage.setItem("umbra_enrolled", JSON.stringify(d)); } catch {}
      setTimeout(()=>unlockAchievement("class_first","First Enrollment",{money:1000,influence:5,xp:100}),50);
      addXP(50);
      return next;
    });
  }, [uid, unlockAchievement, addXP]);
  // Wallet functions
  const addToWallet = useCallback((amount: number, reason: string) => {
    setWalletBalance(prev => {
      const newBal = prev + amount;
      const s = JSON.parse(localStorage.getItem("umbra_session") || "{}");
      if (s.userId) saveWalletToLS(s.userId, newBal);
      return newBal;
    });
    setPurchases(prev => {
      const next = [{ id: `tx_${Date.now()}`, type: "deposit", amount, reason, date: new Date().toISOString() }, ...prev];
      savePurchasesToLS(next);
      return next;
    });
  }, [saveWalletToLS, savePurchasesToLS]);

  const deductFromWallet = useCallback((amount: number, reason: string, itemDetails: any = null) => {
    let ok = false;
    setWalletBalance(prev => {
      if (prev < amount) { ok = false; return prev; }
      ok = true;
      const newBal = prev - amount;
      const s = JSON.parse(localStorage.getItem("umbra_session") || "{}");
      if (s.userId) saveWalletToLS(s.userId, newBal);
      return newBal;
    });
    if (ok) {
      setPurchases(prev => {
        const next = [{ id: `tx_${Date.now()}`, type: "purchase", amount, reason, itemDetails, date: new Date().toISOString() }, ...prev];
        savePurchasesToLS(next);
        return next;
      });
    }
    return ok;
  }, [saveWalletToLS, savePurchasesToLS]);

  // ── REAL-TIME SYNC ──
  const RT_POSTS_KEY = "umbra:posts:v1";
  const RT_CONFS_KEY = "umbra:confs:v1";
  const RT_BIDS_KEY = "umbra:bids:v1";
  const [rtReady, setRtReady] = useState(false);
  const lastWriteRef = useRef(0); // timestamp of last local write — pause incoming sync briefly
  const lastSyncPRef = useRef<string | null>(null); // last seen localStorage value for posts
  const lastSyncCRef = useRef<string | null>(null); // last seen localStorage value for confs
  const lastSyncBRef = useRef<string | null>(null); // last seen localStorage value for bids

  const syncFromStorage = useCallback(async () => {
    // skip if we just wrote (wait 5s for our own push to settle)
    if (Date.now() - lastWriteRef.current < 5000) return;
    try {
      const pVal = localStorage.getItem(RT_POSTS_KEY);
      const cVal = localStorage.getItem(RT_CONFS_KEY);
      const bVal = localStorage.getItem(RT_BIDS_KEY);
      // Only update state when localStorage actually changed — avoids re-render on every tick
      // Use startTransition so scroll gestures are never interrupted by these low-priority updates
      startTransition(() => {
        if (pVal && pVal !== lastSyncPRef.current) {
          lastSyncPRef.current = pVal;
          try { const d = JSON.parse(pVal); if (Array.isArray(d) && d.length) setPosts(d); } catch {}
        }
        if (cVal && cVal !== lastSyncCRef.current) {
          lastSyncCRef.current = cVal;
          try { const d = JSON.parse(cVal); if (Array.isArray(d) && d.length) setConfs(d); } catch {}
        }
        if (bVal && bVal !== lastSyncBRef.current) {
          lastSyncBRef.current = bVal;
          try {
            const d = JSON.parse(bVal);
            if (d?.liveBid && d.liveBid > 0) { setLiveBid(d.liveBid); setLiveBidCount(d.bidCount || 14); }
          } catch {}
        }
      });
    } catch (e) {}
  }, []);

  const pushPosts = useCallback(async (newPosts) => {
    lastWriteRef.current = Date.now();
    try {
      const v = JSON.stringify(newPosts);
      lastSyncPRef.current = v; // track our own write so sync doesn't re-apply it
      localStorage.setItem(RT_POSTS_KEY, v);
    } catch (e) {}
  }, []);
  const pushConfs = useCallback(async (newConfs) => {
    lastWriteRef.current = Date.now();
    try {
      const v = JSON.stringify(newConfs);
      lastSyncCRef.current = v;
      localStorage.setItem(RT_CONFS_KEY, v);
    } catch (e) {}
  }, []);
  const pushBids = useCallback(async (bid, count) => {
    lastWriteRef.current = Date.now();
    try {
      const v = JSON.stringify({ liveBid: bid, bidCount: count });
      lastSyncBRef.current = v;
      localStorage.setItem(RT_BIDS_KEY, v);
    } catch (e) {}
  }, []);

  const RT_ACCTS_KEY = "umbra:accts:v1";

  // Load from localStorage on mount
  useEffect(() => {
    injectCSS();
    const init = async () => {
      // Kick off network fetches immediately — they run in parallel with sync localStorage work
      const _postsFetchP = fetch("/api/posts", { cache: "no-store" });
      const _usersFetchP = fetch("/api/users?q=&limit=2000", { cache: "no-store" });
      // 1. Load shared accounts from localStorage
      try {
        const aVal = localStorage.getItem(RT_ACCTS_KEY);
        if (aVal) {
          const ca = JSON.parse(aVal);
          Object.keys(ca).forEach(id => {
            if (ACCTS[id]) Object.assign(ACCTS[id], ca[id]);
            else ACCTS[id] = ca[id];
          });
        }
      } catch (e) {}
      // 2. Also merge localStorage accounts (same-device fallback)
      try {
        const savedAccts = localStorage.getItem("umbra_custom_accts");
        if (savedAccts) {
          const ca = JSON.parse(savedAccts);
          Object.keys(ca).forEach(id => {
            if (ACCTS[id]) Object.assign(ACCTS[id], ca[id]);
            else ACCTS[id] = ca[id];
          });
        }
      } catch (e) {}
      // 3. Fetch real users from API and merge into ACCTS (cross-device visibility)
      try {
        const uRes = await _usersFetchP;
        if (uRes.ok) {
          const uData = await uRes.json();
          const users = Array.isArray(uData) ? uData : (uData.users || []);
          const newFollowerMap: Record<string,number> = {};
          users.forEach((u: any) => {
            if (!u.id) return;
            const existing = ACCTS[u.id] as any;
            const cov = u.covenant || u.profile?.covenant || "silk";
            const cv = COV[cov as string] || { emoji:"🌑", color:"#888888", name:"Unknown" };
            const fol = u.followers ?? u.profile?.followers ?? 0;
            const fing = u.following ?? u.profile?.following ?? 0;
            if (!existing) {
              ACCTS[u.id] = {
                id: u.id,
                un: u.username,
                handle: `@${u.username}`,
                pic: u.profile?.pic || cv.emoji,
                bio: u.profile?.bio || "",
                cov,
                tier: u.profile?.tier || "merit",
                role: "student",
                followers: fol,
                following: fing,
                _real: true,
              } as any;
            } else {
              if (!existing._real) return;
              if (u.profile?.pic) (ACCTS[u.id] as any).pic = u.profile.pic;
              if (u.username) (ACCTS[u.id] as any).un = u.username;
              if (fol) (ACCTS[u.id] as any).followers = fol;
            }
            if (fol) newFollowerMap[u.id] = fol;
          });
          if (Object.keys(newFollowerMap).length) {
            setFollowerCounts(prev => ({ ...prev, ...newFollowerMap }));
          }
        }
      } catch {}
      // 4. Restore session — if the user has a saved session, ALWAYS restore it.
      // If their profile isn't in ACCTS yet, fetch it directly from Supabase
      // before giving up. This is what makes cross-device + refresh work.
      try {
        const saved = localStorage.getItem("umbra_session");
        if (saved) {
          const { userId, theme: t } = JSON.parse(saved);
          if (userId) {
            // Ensure ACCTS has this user — if not, fetch from Supabase
            if (!ACCTS[userId] && supabase) {
              try {
                const { data: prof } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
                if (prof) {
                  ACCTS[userId] = {
                    id: prof.id,
                    un: prof.username,
                    handle: `@${prof.username}`,
                    pic: prof.pic || "🌑",
                    bio: prof.bio || "",
                    cov: prof.cov || "silk",
                    tier: prof.tier || "merit",
                    major: prof.major || "Undeclared",
                    year: prof.year || "Freshman",
                    wealth: prof.wealth || "Self-Made",
                    rep: prof.rep || "New Arrival",
                    followers: prof.followers || 0,
                    following: prof.following || 0,
                    traits: prof.traits || [],
                    role: "student",
                    canPost: true, canTheme: true,
                    defTheme: "dark", badge: "🌑 STUDENT", bColor: "#888",
                    _real: true, isReal: true,
                  } as any;
                  console.log("[init] restored session user from Supabase:", userId);
                }
              } catch (err) { console.warn("[init] could not fetch profile for session restore:", err); }
            }
            if (ACCTS[userId]) {
              setUid(userId);
              setThemeId(t || ACCTS[userId].defTheme || "dark");
              setWalletBalance(getInitBal(userId));
              setScreen("app");
              fetch(`/api/wallet/${userId}`).then(async (r) => {
                if (r.ok) {
                  const { balance } = await r.json();
                  if (balance !== null && balance !== undefined) {
                    const localBal = (() => { try { const w = JSON.parse(localStorage.getItem("umbra_wallets") || "{}"); return w[userId]; } catch { return undefined; } })();
                    if (localBal === undefined || localBal === null) {
                      saveWalletToLS(userId, balance);
                      setWalletBalance(balance);
                    }
                  }
                }
              }).catch(() => {});
            } else {
              console.warn("[init] session has userId but no profile found anywhere; clearing session");
              try { localStorage.removeItem("umbra_session"); } catch {}
            }
          }
        }
      } catch (e) { console.warn("[init] session restore failed:", e); }
      // 4. Fetch real posts from API and merge into feed + localStorage
      try {
        const pRes = await _postsFetchP;
        const apiPosts: any[] = pRes.ok ? ((await pRes.json()).posts || []) : [];
        // Reclaim any of the user's own posts that the API forgot (Supabase insert
        // failed, post is older than the NPC-post window, etc.) from the backup.
        const reclaimed: any[] = [];
        try {
          const session = JSON.parse(localStorage.getItem("umbra_session") || "{}");
          if (session?.userId) {
            const key = `umbra_my_posts_${session.userId}`;
            const backup: any[] = JSON.parse(localStorage.getItem(key) || "[]");
            const apiIdSet = new Set(apiPosts.map((p: any) => p.id));
            for (const b of backup) {
              if (!apiIdSet.has(b.id)) reclaimed.push(b);
            }
            if (reclaimed.length) console.log(`[init] reclaimed ${reclaimed.length} user post(s) from backup`);
          }
        } catch {}
        const allApi = [...apiPosts, ...reclaimed].sort((a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        if (allApi.length > 0) {
          const shaped = allApi.map((p: any) => ({
            id: p.id,
            uid: p.userId,
            type: p.image ? "image" : "text",
            content: p.content,
            image: p.image || null,
            ts: new Date(p.createdAt).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }),
            _createdAt: new Date(p.createdAt).getTime(),
            r: { "❤️": p.likes || 0, "💀": p.skulls || 0, "🔥": p.flames || 0 },
            c: (p.comments || []).map((c: any) => ({ id: c.id, uid: c.userId, un: c.username, t: c.text, parentId: c.parentId || null })),
            apexOnly: false,
            _un: p.username,
            _pic: p.pic,
            _cov: p.covenant,
            _tier: p.tier,
            _real: true,
          }));
          setPosts((prev) => {
            const prevById = new Map(prev.map((p: any) => [p.id, p]));
            const apiIds = new Set(shaped.map((p: any) => p.id));
            // Rebuild using API order (newest first), merging in any local comment additions
            const apiOrdered = shaped.map((s: any) => {
              const local = prevById.get(s.id);
              if (!local) return s;
              const localCIds = new Set((local.c || []).map((c: any) => c.id));
              const freshC = s.c.filter((c: any) => !localCIds.has(c.id));
              return { ...s, r: s.r, c: [...(local.c || []), ...freshC], _pic: s._pic || local._pic };
            });
            // Local-only posts (NPC seeds, optimistic posts not yet in DB) go after real posts
            const localOnly = prev.filter((p: any) => !apiIds.has(p.id));
            const merged = [...apiOrdered, ...localOnly];
            lastWriteRef.current = Date.now();
            try { localStorage.setItem(RT_POSTS_KEY, JSON.stringify(merged)); } catch {}
            return merged;
          });
        }
      } catch (err) { console.error("[init posts fetch]", err); }
      // 4b. Fetch live bids from API
      try {
        const bRes = await fetch("/api/bids", { cache: "no-store" });
        if (bRes.ok) {
          const { topBid, count } = await bRes.json();
          if (topBid && topBid > 34500) { setLiveBid(topBid); setLiveBidCount(count || 14); }
        }
      } catch {}
      // 5. Start real-time polling
      await syncFromStorage();
      setRtReady(true);
    };

    const fetchApiPosts = async () => {
      try {
        const pRes = await fetch("/api/posts", { cache: "no-store" });
        if (!pRes.ok) return;
        const { posts: apiPostsRaw } = await pRes.json();
        if (!Array.isArray(apiPostsRaw)) return;
        // Reclaim user-post backup on every poll too
        let apiPosts = apiPostsRaw;
        try {
          const session = JSON.parse(localStorage.getItem("umbra_session") || "{}");
          if (session?.userId) {
            const backup: any[] = JSON.parse(localStorage.getItem(`umbra_my_posts_${session.userId}`) || "[]");
            const apiIdSet = new Set(apiPostsRaw.map((p: any) => p.id));
            const reclaimed = backup.filter((b: any) => !apiIdSet.has(b.id));
            if (reclaimed.length) apiPosts = [...apiPostsRaw, ...reclaimed].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          }
        } catch {}
        if (apiPosts.length === 0) return;
        let deletedCommentIds: string[] = [];
        try { deletedCommentIds = JSON.parse(localStorage.getItem("umbra_deleted_comments") || "[]"); } catch {}
        const shaped = apiPosts.map((p: any) => ({
          id: p.id,
          uid: p.userId,
          type: p.image ? "image" : "text",
          content: p.content,
          image: p.image || null,
          ts: new Date(p.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
          _createdAt: new Date(p.createdAt).getTime(),
          r: { "❤️": p.likes || 0, "💀": p.skulls || 0, "🔥": p.flames || 0 },
          c: (p.comments || []).map((c: any) => ({ id: c.id, uid: c.userId, un: c.username, t: c.text, parentId: c.parentId || null })).filter((c: any) => !deletedCommentIds.includes(c.id)),
          apexOnly: false,
          _un: p.username,
          _pic: p.pic,
          _cov: p.covenant,
          _tier: p.tier,
          _real: true,
        }));
        setPosts((prev) => {
          const prevById = new Map(prev.map((p: any) => [p.id, p]));
          const apiIds = new Set(shaped.map((p: any) => p.id));
          // Use API order (newest first), merging local comment additions and filtering deleted
          const apiOrdered = shaped.map((s: any) => {
            const local = prevById.get(s.id);
            if (!local) return s;
            const localIds = new Set((local.c || []).map((c: any) => c.id));
            const newComments = s.c.filter((c: any) => !localIds.has(c.id) && !deletedCommentIds.includes(c.id));
            const mergedC = [...(local.c || []).filter((c: any) => !deletedCommentIds.includes(c.id)), ...newComments];
            return { ...s, c: mergedC };
          });
          // Local-only posts (NPC seeds, optimistic) go after
          const localOnly = prev.filter((p: any) => !apiIds.has(p.id));
          const merged = [...apiOrdered, ...localOnly];
          lastWriteRef.current = Date.now();
          try { localStorage.setItem(RT_POSTS_KEY, JSON.stringify(merged)); } catch {}
          return merged;
        });
      } catch {}
    };

    init();
    const interval = setInterval(syncFromStorage, 5000);
    const apiInterval = setInterval(fetchApiPosts, 45 * 1000); // 45s — keep feed live with other users' posts
    return () => { clearInterval(interval); clearInterval(apiInterval); };
  }, [syncFromStorage]);

  const saveSession = useCallback((userId, t) => {
    try {
      localStorage.setItem(
        "umbra_session",
        JSON.stringify({ userId, theme: t })
      );
    } catch (e) {}
  }, []);

  // ── REAL ACCOUNT HELPERS ──
  const getJWT = () => { try { return localStorage.getItem("umbra_jwt") || ""; } catch { return ""; } };
  const setJWT = (t: string) => { try { localStorage.setItem("umbra_jwt", t); } catch {} };

  const buildRealUser = (u: { id: string; username: string; pic?: string; covenant?: string; tier?: string; bio?: string; followers?: number; following?: number }) => {
    const cov = u.covenant || "silk";
    const tier = u.tier || "commoner";
    const cv = COV[cov] || { emoji: "🌑", color: "#888888", name: "Unknown" };
    return {
      id: u.id,
      un: u.username,
      handle: `@${u.username}`,
      pw: "",
      cov,
      tier,
      pic: u.pic || cv.emoji,
      bio: u.bio || "",
      followers: u.followers ?? (800 + Math.floor(Math.random() * 1200)),
      following: u.following ?? (20 + Math.floor(Math.random() * 150)),
      gaze: 0,
      defTheme: "dark",
      canPost: true,
      canTheme: true,
      badge: `${cv.emoji} ${tier.toUpperCase()}`,
      bColor: cv.color,
      cover: cv.emoji,
      major: "Undeclared",
      year: "Freshman",
      greek: "None",
      canSeeAuction: false,
      canSeeRelief: false,
      wealth: "Self-Made",
      rep: "New Arrival",
      isReal: true,
      _real: true,
    };
  };

  const saveRealUser = (acct: ReturnType<typeof buildRealUser>) => {
    ACCTS[acct.id] = acct;
    try {
      const saved = JSON.parse(localStorage.getItem("umbra_custom_accts") || "{}");
      saved[acct.id] = acct;
      localStorage.setItem("umbra_custom_accts", JSON.stringify(saved));
    } catch {}
  };

  const [acctVer, setAcctVer] = useState(0);
  const user = useMemo(() => (uid ? ACCTS[uid] : null), [uid, acctVer]);

  const picEl = (pic: string | undefined | null, size = 22, style?: React.CSSProperties) => {
    const p = pic || "🌑";
    return (p.startsWith("/") || p.startsWith("http") || p.startsWith("data:"))
      ? <img src={p} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, ...style }} />
      : <span style={{ fontSize: size * 0.85, lineHeight: 1, flexShrink: 0, ...style }}>{p}</span>;
  };

  const T = useMemo(() => {
    if (user?.canTheme === false) return TH[user.defTheme] || TH.dark;
    return TH[themeId] || TH.dark;
  }, [themeId, user]);

  const isApex =
    user?.tier === "apex" || user?.tier === "faculty" || user?.isAdmin;
  const isAsc = user?.tier === "ascendant";

  const toast = useCallback((m) => {
    setNotif(m);
    setTimeout(() => setNotif(null), 2500);
  }, []);

  // Place a live auction bid (for real-user pet auctions)
  const placeLiveAuctionBid = useCallback(async (auctionId: string, amount: number) => {
    if (!uid || !user) return;
    setAuctionBidding(prev => ({ ...prev, [auctionId]: true }));
    try {
      const res = await fetch(`/api/auctions/${auctionId}/bid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bidderId: uid,
          bidderName: (user as any)?.un || uid,
          bidderCov: (user as any)?.cov || "shadows",
          amount,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        deductFromWallet(amount, `Auction bid on ${data.auction?.subjectName || "lot"}`);
        setLiveAuctions(prev => prev.map((a: any) => a.id === auctionId ? data.auction : a));
        toast(`🔨 Bid of ₦${amount.toLocaleString()} placed!`);
        setAuctionBidInput(prev => ({ ...prev, [auctionId]: "" }));
      } else {
        toast(data.error || "Bid failed.");
      }
    } catch {
      toast("Could not place bid. Try again.");
    } finally {
      setAuctionBidding(prev => ({ ...prev, [auctionId]: false }));
    }
  }, [uid, user, deductFromWallet, toast, fetchLiveAuctions]); // eslint-disable-line react-hooks/exhaustive-deps

  const markLesson = useCallback((key: string, xp: number, money: number) => {
    setCompletedLessons(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      try { const d = JSON.parse(localStorage.getItem("umbra_lessons") || "{}"); d[uid] = next; localStorage.setItem("umbra_lessons", JSON.stringify(d)); } catch {}
      return next;
    });
    addXP(xp); addToWallet(money, "Lesson completed"); toast(`+${xp} XP · +₦${money} earned`);
  }, [uid, addXP, addToWallet, toast]);
  const markClassQuiz = useCallback((key: string, xp: number, money: number) => {
    setCompletedClassQuizzes(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      try { const d = JSON.parse(localStorage.getItem("umbra_cquiz") || "{}"); d[uid] = next; localStorage.setItem("umbra_cquiz", JSON.stringify(d)); } catch {}
      return next;
    });
    addXP(xp); addToWallet(money, "Quiz completed"); toast(`✓ Correct! +${xp} XP · +₦${money}`);
  }, [uid, addXP, addToWallet, toast]);
  const markClubActivity = useCallback((key: string) => {
    setClubActivitiesDone(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      try { const d = JSON.parse(localStorage.getItem("umbra_club_act") || "{}"); d[uid] = next; localStorage.setItem("umbra_club_act", JSON.stringify(d)); } catch {}
      return next;
    });
    addXP(75); addToWallet(200, "Club activity completed"); toast("+75 XP · +₦200 for club activity");
    unlockAchievement("club_joiner","Society Member",{money:1000,influence:15,xp:100});
    addInfluence(5);
  }, [uid, addXP, addToWallet, toast, unlockAchievement, addInfluence]);
  const go = useCallback((n, s = null) => {
    setNav(n);
    setSubPages((p) => ({ ...p, [n]: s }));
    setMenuPost(null);
  }, []);
  const viewProf = useCallback(
    (id) => {
      setProfId(id);
      go("profile");
    },
    [go]
  );

  // ── INFLUENCE MILESTONE ACHIEVEMENTS ──
  useEffect(() => {
    if (!unlockAchievement) return;
    if (userInfluence >= 1000) unlockAchievement("influence_1000","Noctis Legend",{money:50000,influence:0,xp:1000});
    else if (userInfluence >= 500) unlockAchievement("influence_500","Campus Icon",{money:15000,influence:0,xp:500});
    else if (userInfluence >= 100) unlockAchievement("influence_100","Rising Star",{money:5000,influence:0,xp:200});
    if (walletBalance >= 1000000) unlockAchievement("wallet_1m","Millionaire",{money:0,influence:200,xp:1000});
    else if (walletBalance >= 100000) unlockAchievement("wallet_100k","Centimillionaire",{money:0,influence:50,xp:300});
    if (dailyStreak >= 7) unlockAchievement("daily_7","Devoted Attendee",{money:3000,influence:30,xp:200});
  }, [userInfluence, walletBalance, dailyStreak]);

  // ── QUIZ ACHIEVEMENTS ──
  useEffect(() => {
    if (!uid || completedClassQuizzes.length === 0) return;
    if (completedClassQuizzes.length >= 5) unlockAchievement("quiz_ace", "Quiz Ace", { xp: 300, money: 2000, influence: 20 });
    for (const cls of CLASSES) {
      if (!cls.quiz?.length) continue;
      const allDone = cls.quiz.every((_: any, qi: number) => completedClassQuizzes.includes(`${cls.id}:q${qi}`));
      if (allDone) { unlockAchievement("perfect_gpa", "Academic Elite", { xp: 500, money: 5000, influence: 50 }); break; }
    }
  }, [completedClassQuizzes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BANKRUPTCY DETECTION ──
  useEffect(() => {
    if (!uid || walletBalance > 0 || isBankrupt) return;
    setIsBankrupt(true);
    const newCount = bankruptcyCount + 1;
    setBankruptcyCount(newCount);
    try { localStorage.setItem("umbra_bankruptcy_count", String(newCount)); } catch {}
    addInfluence(-50);
    unlockAchievement("rock_bottom", "Rock Bottom", { money: 0, influence: 0, xp: 50 });
    if (newCount > 1) unlockAchievement("twice_ruined", "Twice Ruined", { money: 0, influence: 0, xp: 100 });
  }, [walletBalance, uid, isBankrupt]); // eslint-disable-line react-hooks/exhaustive-deps

  const recoverFromBankruptcy = useCallback((option: "loan" | "reputation" | "labour" | "covenant") => {
    let amount = 0;
    if (option === "loan") {
      amount = 8000;
      const newDebt = debtOwed + 12000;
      setDebtOwed(newDebt);
      try { localStorage.setItem("umbra_debt_owed", String(newDebt)); } catch {}
    } else if (option === "reputation") {
      amount = 4000;
      addInfluence(-25);
    } else if (option === "labour") {
      amount = 2500;
    } else if (option === "covenant") {
      amount = 1500;
    }
    addToWallet(amount, `Bankruptcy recovery — ${option}`);
    setIsBankrupt(false);
  }, [debtOwed, addInfluence, addToWallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PET THRESHOLD DETECTION ──
  // wallet < 1000 OR influence < 100 → pet status + live auction created
  useEffect(() => {
    if (!uid || !user) return;
    const myInf = (() => { try { return JSON.parse(localStorage.getItem("umbra_influence")||"{}")[uid] ?? 999; } catch { return 999; } })();
    const financialPet = walletBalance < 1000 && walletBalance >= 0;
    const repPet = myInf < 100;
    const shouldBePet = financialPet || repPet;

    if (shouldBePet) {
      setIsPetStatus(true);
      // Only POST to create the auction once per pet session (ref prevents duplicate DB writes)
      if (!petAuctionPostedRef.current) {
        petAuctionPostedRef.current = true;
        const reason = repPet ? "reputation" : "financial";
        fetch("/api/auctions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subjectId: uid,
            subjectType: "user",
            subjectName: (user as any)?.un || uid,
            subjectAvatar: (user as any)?.pic || "🌑",
            subjectData: {
              covenant: (user as any)?.cov,
              tier: (user as any)?.tier,
              major: (user as any)?.major,
              reason: repPet ? `Reputation dropped below 100 (${myInf} pts)` : `Wallet below ₦1,000 (₦${walletBalance})`,
            },
            reason,
            startingBid: 500,
          }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.auction) setMyActiveAuction(d.auction); fetchLiveAuctions(); })
          .catch(() => {});
      }
    } else {
      setIsPetStatus(false);
      petAuctionPostedRef.current = false; // reset so a new drop can trigger a new auction
    }
  }, [walletBalance, uid, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── AUTO GOSSIP — fires when gossip tab opens, refreshes if stale (>10 min) ──
  useEffect(() => {
    if (forumGossipTab !== "gossip") return;
    const lastGenKey = "umbra_gossip_last_gen";
    const lastGen = parseInt(localStorage.getItem(lastGenKey) || "0", 10);
    const stale = Date.now() - lastGen > 10 * 60 * 1000; // 10 minutes
    if (!stale && gossipPosts.length > 0) return; // still fresh
    const currUser = user ? { un: user.un, tier: (user as any).tier || "merit" } : null;
    const platformUsers = (Object.values(ACCTS) as any[])
      .filter((u: any) => !u.isGuest && u.un && u.un !== "Lurker")
      .slice(0, 8)
      .map((u: any) => ({ un: u.un, tier: u.tier || "student", cov: u.cov || "unknown" }));
    if (platformUsers.length < 2) return;
    setGossipLoading(true);
    fetch("/api/ai/gossip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ users: platformUsers, currentUser: currUser, recentEvents: [] }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.snippets?.length) {
          const newPosts = data.snippets.map((text: string, i: number) => ({
            id: `ag_${Date.now()}_${i}`,
            text,
            ts: new Date().toLocaleTimeString(),
            likes: 0,
            auto: true,
          }));
          setGossipPosts(prev => {
            const combined = [...newPosts, ...prev.filter((p: any) => !p.auto)].slice(0, 40);
            try { localStorage.setItem("umbra_gossip", JSON.stringify(combined)); } catch {}
            return combined;
          });
          try { localStorage.setItem(lastGenKey, Date.now().toString()); } catch {}
        }
      })
      .catch(() => {
        // Fallback to template-based gossip if AI is unavailable
        const TEMPLATES = [
          "{a} was seen entering {b}'s room at 3am. Lights were on until dawn.",
          "Sources confirm {a} failed two assessments this semester.",
          "{a} and {b} were spotted in the restricted wing together after midnight.",
          "Rumour: {a} has been corresponding secretly with someone outside Noctis.",
          "The Dean's office has {a}'s file flagged. No one knows why. Yet.",
          "Faculty member {c} has been giving {a} private attention during office hours.",
          "Multiple students saw {a} crying in the east stairwell last Thursday.",
          "{a} purchased something from the Dark Corridor. Onlookers said it was unusual.",
        ];
        const allU = (Object.values(ACCTS) as any[]).filter((u:any)=>!u.isGuest&&u.un&&u.un!=="Lurker");
        const pick=(arr:any[])=>arr[Math.floor(Math.random()*arr.length)];
        const PROF_NAMES_FB = ["Dr. Valcourt","Professor Maren","Dr. Osei"];
        const fallbackSnippets = Array.from({length:3},()=>{
          const a=pick(allU)?.un||"A student";
          let b=pick(allU)?.un||"another student"; while(b===a) b=pick(allU)?.un||"someone";
          const t = TEMPLATES[Math.floor(Math.random()*TEMPLATES.length)];
          return t.replace("{a}",a).replace("{b}",b).replace("{c}",pick(PROF_NAMES_FB));
        });
        const fbPosts = fallbackSnippets.map((text:string,i:number)=>({id:`fb_${Date.now()}_${i}`,text,ts:new Date().toLocaleTimeString(),likes:0,auto:true}));
        setGossipPosts(prev=>{const combined=[...fbPosts,...prev.filter((p:any)=>!p.auto)].slice(0,40);try{localStorage.setItem("umbra_gossip",JSON.stringify(combined));}catch{}return combined;});
      })
      .finally(() => setGossipLoading(false));
  }, [forumGossipTab]);

  // ── NPC ACTIVITY — trigger AI-generated posts saved to DB (visible to all users) ──
  useEffect(() => {
    if (!uid) return;
    const triggerNpcPost = () => {
      const u = user as any;
      const myRep = (() => { try { return JSON.parse(localStorage.getItem("umbra_influence")||"{}")[uid] ?? 0; } catch { return 0; } })();
      const fame = u ? ((u.followers || 0) + myRep) : 0;
      const platformUsers = (Object.values(ACCTS) as any[])
        .filter((a: any) => !a.isGuest && a.un && a.un !== "Lurker" && a._real)
        .slice(0, 8)
        .map((a: any) => ({ un: a.un, tier: a.tier || "merit", cov: a.cov || "shadows" }));
      fetch("/api/ai/npc-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          triggerUserId: uid,
          triggerUsername: u?.un || "",
          fame,
          platformUsers,
        }),
      }).catch(() => {});
      // 20% chance: if user is influential/legendary, an NPC posts about them specifically
      if (myRep >= 4000 && Math.random() < 0.2) {
        fetch("/api/ai/worship-feed-mention", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetUsername: u?.un || uid, targetRep: myRep }),
        }).catch(() => {});
      }
    };
    const t1 = setTimeout(triggerNpcPost, 5 * 60 * 1000); // first trigger: 5 min after mount
    const interval = setInterval(triggerNpcPost, 60 * 60 * 1000); // every 60 min
    return () => { clearTimeout(t1); clearInterval(interval); };
  }, [uid]);

  // ── GOSSIP AUTO-VIEWS — passive view tick on NPC posts (slow, low priority) ──
  useEffect(() => {
    if (forumGossipTab !== "gossip") return;
    const interval = setInterval(() => {
      startTransition(() => {
        setPosts(prev => prev.map((p: any) =>
          p._npc ? { ...p, r: { ...p.r, "❤️": p.r["❤️"] + Math.floor(Math.random()*3), "🔥": p.r["🔥"] + Math.floor(Math.random()*2) } } : p
        ));
      });
    }, 90000); // 90s — was 20s, reducing re-render frequency 4.5×
    return () => clearInterval(interval);
  }, [forumGossipTab]);

  // ── LEADERBOARD FETCH — real-time data from API ──
  const fetchLeaderboard = useCallback(async () => {
    setLbLoading(true);
    try {
      const res = await fetch("/api/leaderboard");
      if (res.ok) {
        const data = await res.json();
        const lb = data.leaderboard || [];
        const updAt = data.updatedAt || new Date().toISOString();
        setLbData(lb);
        setLbUpdatedAt(updAt);
        // Persist so leaderboard survives refresh
        try { localStorage.setItem("umbra_lb_cache", JSON.stringify(lb)); } catch {}
        try { localStorage.setItem("umbra_lb_updated_at", updAt); } catch {}
      }
    } catch {}
    setLbLoading(false);
  }, []);
  // Stable ref so doSync can call fetchLeaderboard without a stale closure
  const fetchLeaderboardRef = useRef(fetchLeaderboard);
  useEffect(() => { fetchLeaderboardRef.current = fetchLeaderboard; }, [fetchLeaderboard]);

  useEffect(() => {
    fetchLeaderboard();
    const iv = setInterval(fetchLeaderboard, 5 * 60 * 1000); // 5 min — matches server cache, reduces compute
    return () => clearInterval(iv);
  }, [fetchLeaderboard]);

  // Persist professor DM history to localStorage so conversations survive page refresh
  useEffect(() => {
    try { localStorage.setItem("umbra_prof_dm_history", JSON.stringify(profDMHistory)); } catch {}
  }, [profDMHistory]);

  // Sync current user's wealth, reputation & XP to DB profile — every 5 min so leaderboard stays current
  useEffect(() => {
    if (!uid || !user) return;
    const doSync = async () => {
      try {
        const myXp = (() => { try { return JSON.parse(localStorage.getItem("umbra_xp")||"{}")[uid] ?? 0; } catch { return 0; } })();
        const myRep = (() => { try { return JSON.parse(localStorage.getItem("umbra_influence")||"{}")[uid] ?? 0; } catch { return 0; } })();
        const bal = (() => { try { const w = JSON.parse(localStorage.getItem("umbra_wallets") || "{}"); return w[uid] ?? walletBalance; } catch { return walletBalance; } })();
        // Build body — only include reputation/xp if non-zero so we never accidentally
        // overwrite a real server value with 0 (e.g. on a fresh device with empty localStorage).
        // The server ALSO enforces MAX so both sides guard against progress wipe.
        const body: Record<string, any> = {
          username: (user as any)?.un || uid,
          pic: (user as any)?.pic,
          cov: (user as any)?.cov,
          tier: (user as any)?.tier,
          major: (user as any)?.major,
          wealth: bal,
        };
        if (myRep > 0) body.reputation = myRep;
        if (myXp > 0) body.xp = myXp;
        const r = await fetch(`/api/users/${uid}/profile`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // After syncing rep to DB, immediately refresh the leaderboard so our rank is current
        if (r.ok) {
          setTimeout(() => fetchLeaderboardRef.current(), 500);
        }
      } catch {}
    };
    // Initial sync after 10s (give app time to settle), then every 5 min
    const t = setTimeout(doSync, 10000);
    const iv = setInterval(doSync, 5 * 60 * 1000); // 5 min — reduces compute costs
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps — intentionally NOT walletBalance

  // Fetch server-stored traits/pic for real users when their profile is opened.
  // Uses a ref-set to ensure we NEVER re-fetch the same pid — even on 404.
  useEffect(() => {
    const pid = profId || uid;
    if (!pid) return;
    if (profileFetchTriedRef.current.has(pid)) return; // already succeeded — no need to re-fetch
    // Skip hardcoded NPC accounts that already have traits baked in AND a real pic URL
    const acct = ACCTS[pid] as any;
    if (acct && Array.isArray(acct.traits) && acct.traits.length > 0) {
      profileFetchTriedRef.current.add(pid);
      return;
    }
    // Mark in-flight ONLY in a temporary set — will add to tried only on success
    if ((profileFetchTriedRef as any)._inflight?.has(pid)) return;
    if (!(profileFetchTriedRef as any)._inflight) (profileFetchTriedRef as any)._inflight = new Set();
    (profileFetchTriedRef as any)._inflight.add(pid);
    fetch(`/api/auth/profile/${pid}`)
      .then(r => r.ok ? r.json() : Promise.resolve(null))
      .then(data => {
        (profileFetchTriedRef as any)._inflight?.delete(pid);
        if (!data?.profile) return; // 404 or error — NOT marked as tried, so retried next visit
        profileFetchTriedRef.current.add(pid); // mark success — no need to fetch again this session
        if (Array.isArray(data.profile.traits) && data.profile.traits.length > 0) {
          setServerProfileTraits(prev => ({ ...prev, [pid]: data.profile.traits }));
        }
        if (data.profile.pic) {
          setServerProfilePics(prev => ({ ...prev, [pid]: data.profile.pic }));
          if (ACCTS[pid]) (ACCTS[pid] as any).pic = data.profile.pic;
        }
        // Enrich ACCTS entry with profile badge data so viewers see correct major/tier/year/etc.
        if (!ACCTS[pid]) {
          // Build a minimal ACCTS entry for real users not yet in local dictionary
          const cov = data.profile.covenant || "shadows";
          const cv = COV[cov] || { emoji: "🌑", color: "#888", name: "Unknown" };
          ACCTS[pid] = {
            id: pid,
            un: data.username || pid,
            handle: `@${data.username || pid}`,
            cov,
            tier: data.profile.tier || "merit",
            pic: data.profile.pic || cv.emoji,
            bio: data.profile.bio || "",
            followers: data.profile.followers || 0, following: data.profile.following || 0, gaze: 0,
            major: data.profile.major || "Undeclared",
            year: data.profile.year || "Freshman",
            wealth: data.profile.wealth || "Self-Made",
            rep: data.profile.rep || "",
            badge: `${cv.emoji} ${(data.profile.tier || "merit").toUpperCase()}`,
            bColor: cv.color, cover: cv.emoji,
            isReal: true, canPost: true, canTheme: true,
          } as any;
        } else {
          const a = ACCTS[pid] as any;
          if (data.profile.covenant) a.cov = data.profile.covenant;
          if (data.profile.tier) a.tier = data.profile.tier;
          if (data.profile.major) a.major = data.profile.major;
          if (data.profile.year) a.year = data.profile.year;
          if (data.profile.wealth) a.wealth = data.profile.wealth;
          if (data.profile.rep) a.rep = data.profile.rep;
          if (data.profile.bio) a.bio = data.profile.bio;
        }
        setAcctVer(v => v + 1);
      })
      .catch(() => {});
  }, [profId, uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── WALLET & MARKET FUNCTIONS (defined after toast) ──
  const adminAddFunds = useCallback(() => {
    if (!user?.isAdmin) { toast("Admin only."); return; }
    const amt = parseInt(adminFundAmt);
    if (!amt || amt <= 0) { toast("Enter a valid amount."); return; }
    const target = adminFundTarget.trim().toLowerCase();
    const recip: any = Object.values(ACCTS).find(
      (u: any) => u.un.toLowerCase() === target || u.id.toLowerCase() === target ||
        (u.handle || "").toLowerCase().replace("@", "") === target.replace("@", "")
    );
    if (!recip) { toast("User not found."); return; }
    try {
      const saved = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
      const curBal = saved[recip.id] !== undefined ? saved[recip.id] : (WALLET_INIT[recip.id] ?? 5000);
      const newBal = curBal + amt;
      saved[recip.id] = newBal;
      localStorage.setItem("umbra_wallets", JSON.stringify(saved));
      if (recip.id === uid) setWalletBalance(newBal);
    } catch (e) {}
    setAdminFundTarget(""); setAdminFundAmt("");
    toast(`✅ ₦${amt.toLocaleString()} added to ${recip.un}'s wallet`);
  }, [user, adminFundAmt, adminFundTarget, uid, toast]);

  // ── PROFILE SAVE ──
  const saveProfile = useCallback(() => {
    if (!uid) return;
    setEditSaving(true);
    const newUn = editUn.trim() || user.un;
    const newBio = editBio.trim();
    const newHandle = editHandle.trim().replace(/^@/, "") || (user.handle || "").replace(/^@/, "");
    const updates: any = { un: newUn, bio: newBio || user.bio, handle: `@${newHandle}` };
    if (editPw.trim()) updates.pw = editPw.trim();
    if (ACCTS[uid]) Object.assign(ACCTS[uid], updates);
    try {
      const existing = JSON.parse(localStorage.getItem("umbra:accts:v1") || "{}");
      existing[uid] = { ...(existing[uid] || {}), ...updates };
      localStorage.setItem("umbra:accts:v1", JSON.stringify(existing));
      const c2 = JSON.parse(localStorage.getItem("umbra_custom_accts") || "{}");
      c2[uid] = { ...(c2[uid] || {}), ...updates };
      localStorage.setItem("umbra_custom_accts", JSON.stringify(c2));
    } catch {}
    setTimeout(() => {
      setEditSaving(false);
      setEditProfile(false);
      setEditPw("");
      setAcctVer(v => v + 1);
      toast("✅ Profile updated");
    }, 400);
  }, [uid, user, editUn, editBio, editHandle, editPw, toast]);

  const saveFrame = useCallback((frameId: string) => {
    setProfileFrame(frameId);
    try {
      const fs = JSON.parse(localStorage.getItem("umbra_frames") || "{}");
      fs[uid] = frameId;
      localStorage.setItem("umbra_frames", JSON.stringify(fs));
    } catch {}
  }, [uid]);

  const getFrame = (userId: string) => {
    try {
      const fs = JSON.parse(localStorage.getItem("umbra_frames") || "{}");
      if (fs[userId]) return fs[userId];
      // Fall back to defFrame for special accounts
      const acct = (Object.values(ACCTS) as any[]).find((u: any) => u.id === userId);
      return (acct?.defFrame) || "none";
    } catch { return "none"; }
  };

  const FRAME_SVG: Record<string, React.ReactNode> = {
    wings: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        {/* ── Left demon wing ── */}
        {/* Main membrane */}
        <path d="M 22,56 C 10,50 -6,42 -14,16 C -7,28 -1,32 3,37 C -7,46 -5,62 -2,70 C 5,67 13,62 22,60 Z" fill="#161616" opacity=".97"/>
        {/* Digit fingers */}
        <path d="M -14,16 C -24,1 -22,-5 -17,-2 C -14,6 -9,18 -4,30 Z" fill="#222" opacity=".93"/>
        <path d="M -2,33 C -17,18 -18,9 -13,12 C -9,20 -5,29 2,37 Z" fill="#1e1e1e" opacity=".9"/>
        <path d="M 2,46 C -13,42 -15,32 -11,35 C -7,40 -2,46 5,50 Z" fill="#1a1a1a" opacity=".9"/>
        {/* Membrane highlight */}
        <path d="M -14,16 C -5,32 0,44 -2,70" fill="none" stroke="#3a3a3a" strokeWidth=".8" opacity=".6"/>
        <path d="M -8,12 C -4,22 -1,34 1,48" fill="none" stroke="#2e2e2e" strokeWidth=".5" opacity=".4"/>
        {/* ── Right demon wing (mirror) ── */}
        <path d="M 78,56 C 90,50 106,42 114,16 C 107,28 101,32 97,37 C 107,46 105,62 102,70 C 95,67 87,62 78,60 Z" fill="#161616" opacity=".97"/>
        <path d="M 114,16 C 124,1 122,-5 117,-2 C 114,6 109,18 104,30 Z" fill="#222" opacity=".93"/>
        <path d="M 102,33 C 117,18 118,9 113,12 C 109,20 105,29 98,37 Z" fill="#1e1e1e" opacity=".9"/>
        <path d="M 98,46 C 113,42 115,32 111,35 C 107,40 102,46 95,50 Z" fill="#1a1a1a" opacity=".9"/>
        <path d="M 114,16 C 105,32 100,44 102,70" fill="none" stroke="#3a3a3a" strokeWidth=".8" opacity=".6"/>
        <path d="M 108,12 C 104,22 101,34 99,48" fill="none" stroke="#2e2e2e" strokeWidth=".5" opacity=".4"/>
        {/* Subtle inner ring */}
        <circle cx="50" cy="50" r="33" fill="none" stroke="#1e1e1e" strokeWidth="1.2"/>
      </svg>
    ),
    roses: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        {/* ── Dark rose wreath — wraps around the bottom half ── */}
        {/* Main vine/stem arc */}
        <path d="M 14,50 Q 18,78 36,89 Q 50,96 64,89 Q 82,78 86,50" fill="none" stroke="#2d0a3a" strokeWidth="2.2"/>
        <path d="M 14,50 Q 18,78 36,89 Q 50,96 64,89 Q 82,78 86,50" fill="none" stroke="#5b1a70" strokeWidth="1" opacity=".55"/>
        {/* Thorns */}
        <path d="M 23,70 L 19,65" stroke="#4a1060" strokeWidth=".9" strokeLinecap="round"/>
        <path d="M 34,84 L 30,79" stroke="#4a1060" strokeWidth=".9" strokeLinecap="round"/>
        <path d="M 50,92 L 50,86" stroke="#4a1060" strokeWidth=".9" strokeLinecap="round"/>
        <path d="M 66,84 L 70,79" stroke="#4a1060" strokeWidth=".9" strokeLinecap="round"/>
        <path d="M 77,70 L 81,65" stroke="#4a1060" strokeWidth=".9" strokeLinecap="round"/>
        {/* ── Rose 1: bottom-left ── */}
        <g transform="translate(20,66)">
          <ellipse cx="-4.5" cy="1" rx="5.5" ry="4.2" fill="#1e0728" transform="rotate(-25)"/>
          <ellipse cx="4.5" cy="1" rx="5.5" ry="4.2" fill="#1e0728" transform="rotate(25)"/>
          <ellipse cx="0" cy="-4.5" rx="4.2" ry="5.5" fill="#260a32"/>
          <ellipse cx="0" cy="4.5" rx="4" ry="5" fill="#260a32"/>
          <ellipse cx="-3.5" cy="-2.5" rx="4" ry="3.2" fill="#34104a" transform="rotate(-35)"/>
          <ellipse cx="3.5" cy="-2.5" rx="4" ry="3.2" fill="#34104a" transform="rotate(35)"/>
          <circle r="3.2" fill="#140520"/>
          <circle r="1.6" fill="#1e0728" opacity=".9"/>
        </g>
        {/* Leaf 1 */}
        <path d="M 18,62 Q 11,56 13,48 Q 18,55 21,60 Z" fill="#1a2e0a" opacity=".9"/>
        {/* ── Rose 2: bottom-center ── */}
        <g transform="translate(50,90)">
          <ellipse cx="-4" cy="1" rx="5" ry="3.8" fill="#240830" transform="rotate(-20)"/>
          <ellipse cx="4" cy="1" rx="5" ry="3.8" fill="#240830" transform="rotate(20)"/>
          <ellipse cx="0" cy="-4" rx="3.8" ry="5" fill="#2c0a3a"/>
          <ellipse cx="-3" cy="-2" rx="3.8" ry="3" fill="#3c1254" transform="rotate(-30)"/>
          <ellipse cx="3" cy="-2" rx="3.8" ry="3" fill="#3c1254" transform="rotate(30)"/>
          <circle r="3" fill="#140520"/>
        </g>
        {/* Leaf 2 */}
        <path d="M 50,88 Q 44,82 46,74 Q 50,80 54,86 Z" fill="#1a2e0a" opacity=".85"/>
        {/* ── Rose 3: bottom-right ── */}
        <g transform="translate(80,66)">
          <ellipse cx="4.5" cy="1" rx="5.5" ry="4.2" fill="#1e0728" transform="rotate(25)"/>
          <ellipse cx="-4.5" cy="1" rx="5.5" ry="4.2" fill="#1e0728" transform="rotate(-25)"/>
          <ellipse cx="0" cy="-4.5" rx="4.2" ry="5.5" fill="#260a32"/>
          <ellipse cx="0" cy="4.5" rx="4" ry="5" fill="#260a32"/>
          <ellipse cx="3.5" cy="-2.5" rx="4" ry="3.2" fill="#34104a" transform="rotate(35)"/>
          <ellipse cx="-3.5" cy="-2.5" rx="4" ry="3.2" fill="#34104a" transform="rotate(-35)"/>
          <circle r="3.2" fill="#140520"/>
          <circle r="1.6" fill="#1e0728" opacity=".9"/>
        </g>
        {/* Leaf 3 */}
        <path d="M 82,62 Q 89,56 87,48 Q 82,55 79,60 Z" fill="#1a2e0a" opacity=".9"/>
        {/* ── Small bud on left stem ── */}
        <g transform="translate(30,82)">
          <ellipse cx="-2.5" cy="0" rx="3" ry="2.5" fill="#260a32" transform="rotate(-15)"/>
          <ellipse cx="2.5" cy="0" rx="3" ry="2.5" fill="#260a32" transform="rotate(15)"/>
          <circle r="2" fill="#140520"/>
        </g>
        {/* ── Small bud on right stem ── */}
        <g transform="translate(70,82)">
          <ellipse cx="2.5" cy="0" rx="3" ry="2.5" fill="#260a32" transform="rotate(15)"/>
          <ellipse cx="-2.5" cy="0" rx="3" ry="2.5" fill="#260a32" transform="rotate(-15)"/>
          <circle r="2" fill="#140520"/>
        </g>
        {/* Ring */}
        <circle cx="50" cy="50" r="33" fill="none" stroke="#2d0a3a" strokeWidth="1.2"/>
      </svg>
    ),
    butterfly: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        <defs>
          <radialGradient id="nebBg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#5b21b6" stopOpacity=".35"/>
            <stop offset="55%" stopColor="#7c3aed" stopOpacity=".18"/>
            <stop offset="100%" stopColor="#4c1d95" stopOpacity="0"/>
          </radialGradient>
          <filter id="buttGlow"><feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {/* Soft nebula cloud around the avatar */}
        <circle cx="50" cy="50" r="42" fill="url(#nebBg)"/>
        {/* Wispy nebula texture */}
        <ellipse cx="20" cy="38" rx="12" ry="7" fill="#7c3aed" opacity=".1" transform="rotate(-20,20,38)"/>
        <ellipse cx="80" cy="62" rx="12" ry="7" fill="#6d28d9" opacity=".1" transform="rotate(20,80,62)"/>
        {/* Stardust */}
        <g className="frm-twink"><circle cx="16" cy="32" r="1.3" fill="#a78bfa" opacity=".75"/></g>
        <g className="frm-twink2"><circle cx="82" cy="26" r="1.1" fill="#c4b5fd" opacity=".7"/></g>
        <g className="frm-twink3"><circle cx="10" cy="60" r="1" fill="#a78bfa" opacity=".65"/></g>
        <g className="frm-twink"><circle cx="88" cy="68" r="1.2" fill="#ddd6fe" opacity=".6"/></g>
        <g className="frm-twink2"><circle cx="70" cy="10" r=".9" fill="#c4b5fd" opacity=".6"/></g>
        <g className="frm-twink3"><circle cx="28" cy="88" r="1" fill="#a78bfa" opacity=".55"/></g>
        {/* ── Butterfly perched at top-center ── */}
        <g transform="translate(50,19)" filter="url(#buttGlow)">
          {/* Upper left wing — icy blue */}
          <path d="M -1.5,-1 C -14,-18 -24,-10 -20,2 C -16,9 -6,5 -1.5,-1 Z" fill="#22d3ee" opacity=".88"/>
          <path d="M -1.5,-1 C -14,-18 -24,-10 -20,2 C -16,9 -6,5 -1.5,-1 Z" fill="none" stroke="#67e8f9" strokeWidth=".6" opacity=".8"/>
          <path d="M -9,-8 C -17,-12 -19,-6 -14,-1" fill="none" stroke="#a5f3fc" strokeWidth=".6" opacity=".75"/>
          <path d="M -15,-2 C -18,2 -16,6 -12,6" fill="none" stroke="#cffafe" strokeWidth=".5" opacity=".6"/>
          {/* Upper right wing — purple */}
          <path d="M 1.5,-1 C 14,-18 24,-10 20,2 C 16,9 6,5 1.5,-1 Z" fill="#c084fc" opacity=".88"/>
          <path d="M 1.5,-1 C 14,-18 24,-10 20,2 C 16,9 6,5 1.5,-1 Z" fill="none" stroke="#d8b4fe" strokeWidth=".6" opacity=".8"/>
          <path d="M 9,-8 C 17,-12 19,-6 14,-1" fill="none" stroke="#e9d5ff" strokeWidth=".6" opacity=".75"/>
          <path d="M 15,-2 C 18,2 16,6 12,6" fill="none" stroke="#f3e8ff" strokeWidth=".5" opacity=".6"/>
          {/* Lower left wing */}
          <path d="M -1.5,0 C -14,4 -12,14 -5,12 C -1,10 -1.5,4 -1.5,0 Z" fill="#0891b2" opacity=".82"/>
          {/* Lower right wing */}
          <path d="M 1.5,0 C 14,4 12,14 5,12 C 1,10 1.5,4 1.5,0 Z" fill="#9333ea" opacity=".82"/>
          {/* Body */}
          <ellipse cx="0" cy="4" rx="1.4" ry="7" fill="#1a0828"/>
          <ellipse cx="0" cy="4" rx=".7" ry="6" fill="#2a0840" opacity=".6"/>
          {/* Head */}
          <circle cy="-3.5" r="1.8" fill="#1a0828"/>
          {/* Antennae */}
          <path d="M -.7,-5 Q -6,-16 -5,-19" fill="none" stroke="#c084fc" strokeWidth=".8" strokeLinecap="round"/>
          <circle cx="-5" cy="-19" r="1.2" fill="#e879f9"/>
          <path d="M .7,-5 Q 6,-16 5,-19" fill="none" stroke="#22d3ee" strokeWidth=".8" strokeLinecap="round"/>
          <circle cx="5" cy="-19" r="1.2" fill="#67e8f9"/>
        </g>
        {/* 4-pt sparkles in nebula */}
        <g className="frm-twink3" transform="translate(20,22)"><path d="M0,-4 L.7,-.7 L4,0 L.7,.7 L0,4 L-.7,.7 L-4,0 L-.7,-.7Z" fill="#c4b5fd" opacity=".8"/></g>
        <g className="frm-twink" transform="translate(80,78)"><path d="M0,-3 L.5,-.5 L3,0 L.5,.5 L0,3 L-.5,.5 L-3,0 L-.5,-.5Z" fill="#a78bfa" opacity=".7"/></g>
        <circle cx="50" cy="50" r="33" fill="none" stroke="#4c1d95" strokeWidth="1.2"/>
      </svg>
    ),
    bloodmoon: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        <defs>
          <radialGradient id="bmGrad" cx="38%" cy="32%" r="65%">
            <stop offset="0%" stopColor="#ff7040"/>
            <stop offset="35%" stopColor="#cc2200"/>
            <stop offset="70%" stopColor="#7a0000"/>
            <stop offset="100%" stopColor="#200000"/>
          </radialGradient>
          <radialGradient id="bmAtm" cx="50%" cy="50%" r="52%">
            <stop offset="68%" stopColor="transparent"/>
            <stop offset="100%" stopColor="#ff220044"/>
          </radialGradient>
          <filter id="bmGlow"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {/* Atmospheric rim glow */}
        <circle cx="64" cy="34" r="30" fill="url(#bmAtm)" filter="url(#bmGlow)"/>
        {/* Moon body — large, overlapping avatar top-right */}
        <circle cx="64" cy="34" r="26" fill="url(#bmGrad)"/>
        {/* Craters */}
        <circle cx="55" cy="30" r="4.5" fill="#9a1000" opacity=".55"/>
        <circle cx="70" cy="24" r="3" fill="#9a1000" opacity=".45"/>
        <circle cx="74" cy="40" r="2.5" fill="#880000" opacity=".4"/>
        <circle cx="60" cy="44" r="2" fill="#9a1000" opacity=".38"/>
        <circle cx="68" cy="32" r="1.2" fill="#cc2200" opacity=".3"/>
        {/* Surface highlight (top-left of moon) */}
        <ellipse cx="52" cy="24" rx="7" ry="4.5" fill="white" opacity=".07" transform="rotate(-20,52,24)"/>
        {/* Outer glow ring */}
        <circle cx="64" cy="34" r="26" fill="none" stroke="#ff220055" strokeWidth="2.5"/>
        {/* Stars around the scene */}
        <g className="frm-twink"><circle cx="8" cy="18" r="1.2" fill="white" opacity=".82"/></g>
        <g className="frm-twink2"><circle cx="22" cy="8" r=".9" fill="white" opacity=".7"/></g>
        <g className="frm-twink3"><circle cx="6" cy="52" r="1" fill="white" opacity=".65"/></g>
        <g className="frm-twink"><circle cx="12" cy="76" r=".8" fill="white" opacity=".6"/></g>
        <g className="frm-twink2"><circle cx="88" cy="78" r="1.1" fill="white" opacity=".6"/></g>
        {/* 4-pt star sparkle */}
        <g className="frm-twink3" transform="translate(14,30)"><path d="M0,-3.5 L.6,-.6 L3.5,0 L.6,.6 L0,3.5 L-.6,.6 L-3.5,0 L-.6,-.6Z" fill="white" opacity=".65"/></g>
        {/* Ring */}
        <circle cx="50" cy="50" r="33" fill="none" stroke="#3a0000" strokeWidth="1.2"/>
      </svg>
    ),
    twilight: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        <defs>
          <radialGradient id="twiRim" cx="50%" cy="50%" r="50%">
            <stop offset="60%" stopColor="transparent"/>
            <stop offset="100%" stopColor="#ffffff28"/>
          </radialGradient>
          <filter id="twiBlur"><feGaussianBlur stdDeviation="3"/></filter>
          <filter id="twiBlur2"><feGaussianBlur stdDeviation="5"/></filter>
        </defs>
        {/* Soft cosmic dust ring — heavy glow blobs */}
        <circle cx="50" cy="50" r="40" fill="url(#twiRim)"/>
        {/* Cardinal blobs */}
        <ellipse cx="50" cy="11" rx="16" ry="10" fill="white" opacity=".22" filter="url(#twiBlur)"/>
        <ellipse cx="89" cy="50" rx="10" ry="16" fill="white" opacity=".2" filter="url(#twiBlur)"/>
        <ellipse cx="50" cy="89" rx="16" ry="10" fill="white" opacity=".22" filter="url(#twiBlur)"/>
        <ellipse cx="11" cy="50" rx="10" ry="16" fill="white" opacity=".2" filter="url(#twiBlur)"/>
        {/* Inter-cardinal softer blobs */}
        <ellipse cx="22" cy="20" rx="13" ry="10" fill="white" opacity=".14" filter="url(#twiBlur2)"/>
        <ellipse cx="78" cy="20" rx="13" ry="10" fill="white" opacity=".14" filter="url(#twiBlur2)"/>
        <ellipse cx="78" cy="80" rx="13" ry="10" fill="white" opacity=".14" filter="url(#twiBlur2)"/>
        <ellipse cx="22" cy="80" rx="13" ry="10" fill="white" opacity=".14" filter="url(#twiBlur2)"/>
        {/* Stars */}
        <g className="frm-twink"><circle cx="6" cy="33" r="1.3" fill="white" opacity=".9"/></g>
        <g className="frm-twink2"><circle cx="94" cy="40" r="1.1" fill="white" opacity=".85"/></g>
        <g className="frm-twink3"><circle cx="36" cy="4" r="1.2" fill="white" opacity=".8"/></g>
        <g className="frm-twink"><circle cx="66" cy="5" r=".9" fill="white" opacity=".75"/></g>
        <g className="frm-twink2"><circle cx="5" cy="66" r=".9" fill="white" opacity=".7"/></g>
        <g className="frm-twink3"><circle cx="96" cy="62" r="1.1" fill="white" opacity=".75"/></g>
        <g className="frm-twink"><circle cx="18" cy="95" r="1" fill="white" opacity=".65"/></g>
        <g className="frm-twink2"><circle cx="80" cy="96" r="1.2" fill="white" opacity=".7"/></g>
        {/* 4-pt sparkles */}
        <g className="frm-twink3" transform="translate(9,20)"><path d="M0,-4 L.7,-.7 L4,0 L.7,.7 L0,4 L-.7,.7 L-4,0 L-.7,-.7Z" fill="white" opacity=".75"/></g>
        <g className="frm-twink" transform="translate(91,80)"><path d="M0,-3.5 L.6,-.6 L3.5,0 L.6,.6 L0,3.5 L-.6,.6 L-3.5,0 L-.6,-.6Z" fill="white" opacity=".65"/></g>
        <g className="frm-twink2" transform="translate(50,4)"><path d="M0,-2.8 L.5,-.5 L2.8,0 L.5,.5 L0,2.8 L-.5,.5 L-2.8,0 L-.5,-.5Z" fill="white" opacity=".7"/></g>
        {/* Thin glowing ring */}
        <circle cx="50" cy="50" r="33.5" fill="none" stroke="white" strokeWidth="1" opacity=".28"/>
        <circle cx="50" cy="50" r="33.5" fill="none" stroke="white" strokeWidth="4" opacity=".07"/>
      </svg>
    ),
    electric: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        <defs>
          <filter id="elecGlow1"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="elecGlow2"><feGaussianBlur stdDeviation="1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {/* Outer diffuse glow ring */}
        <circle cx="50" cy="50" r="36" fill="none" stroke="#b8f0ff" strokeWidth="4" opacity=".18" filter="url(#elecGlow1)"/>
        {/* Main icy ring */}
        <circle cx="50" cy="50" r="34.5" fill="none" stroke="#e0f8ff" strokeWidth="1.8" filter="url(#elecGlow2)" className="frm-glow"/>
        <circle cx="50" cy="50" r="33" fill="none" stroke="#7de8ff" strokeWidth="1" opacity=".7"/>
        {/* Inner dim ring */}
        <circle cx="50" cy="50" r="31" fill="none" stroke="#a8edff" strokeWidth=".5" opacity=".4"/>
        {/* Cardinal arc sparks */}
        {/* Top */}
        <g className="frm-twink" filter="url(#elecGlow2)">
          <path d="M 46,16 Q 48,13 50,11 Q 52,13 54,16" fill="none" stroke="#c8f4ff" strokeWidth="1.6" strokeLinecap="round"/>
          <circle cx="50" cy="10.5" r="1.8" fill="#a8edff"/>
        </g>
        {/* Bottom */}
        <g className="frm-twink2" filter="url(#elecGlow2)">
          <path d="M 46,84 Q 48,87 50,89 Q 52,87 54,84" fill="none" stroke="#c8f4ff" strokeWidth="1.6" strokeLinecap="round"/>
          <circle cx="50" cy="89.5" r="1.8" fill="#a8edff"/>
        </g>
        {/* Left */}
        <g className="frm-twink3" filter="url(#elecGlow2)">
          <path d="M 16,46 Q 13,48 11,50 Q 13,52 16,54" fill="none" stroke="#c8f4ff" strokeWidth="1.6" strokeLinecap="round"/>
          <circle cx="10.5" cy="50" r="1.8" fill="#a8edff"/>
        </g>
        {/* Right */}
        <g className="frm-twink" filter="url(#elecGlow2)">
          <path d="M 84,46 Q 87,48 89,50 Q 87,52 84,54" fill="none" stroke="#c8f4ff" strokeWidth="1.6" strokeLinecap="round"/>
          <circle cx="89.5" cy="50" r="1.8" fill="#a8edff"/>
        </g>
        {/* Small arc details */}
        <path d="M 56,15.5 Q 60,14 64,16" fill="none" stroke="#7de8ff" strokeWidth=".9" opacity=".55"/>
        <path d="M 36,15.5 Q 40,14 44,16" fill="none" stroke="#7de8ff" strokeWidth=".9" opacity=".55"/>
        <path d="M 56,84.5 Q 60,86 64,84" fill="none" stroke="#7de8ff" strokeWidth=".9" opacity=".45"/>
        <path d="M 36,84.5 Q 40,86 44,84" fill="none" stroke="#7de8ff" strokeWidth=".9" opacity=".45"/>
      </svg>
    ),
    fire: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        <defs>
          <filter id="fireGlw"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {/* ── Fire ring: 8 flames, each pointing OUTWARD from center ── */}
        {/* rotate(θ) where θ=0 at 12-o-clock going clockwise; flame tip is at local y=-16 (up), so rotate(θ) tilts it outward */}
        <g filter="url(#fireGlw)">
          {/* 12 o'clock — outward = UP, no rotation needed */}
          <g className="frm-flicker" transform="translate(50,17) rotate(0)">
            <path d="M -5.5,3 Q -3,-10 0,-16 Q 3,-10 5.5,3 Q 2.5,6 0,6 Q -2.5,6 -5.5,3Z" fill="#ff4500"/>
            <path d="M -3.2,2 Q -1.5,-6 0,-11 Q 1.5,-6 3.2,2 Q 1.5,4 0,4 Q -1.5,4 -3.2,2Z" fill="#ffa500"/>
            <path d="M -1.5,1.5 Q 0,-2 0,-5 Q 0,-2 1.5,1.5 Q .7,3 0,3 Q -.7,3 -1.5,1.5Z" fill="#ffdd00"/>
          </g>
          {/* 1:30 — rotate 45° (upper-right) */}
          <g className="frm-flicker2" transform="translate(73,27) rotate(45)">
            <path d="M -4.5,2.5 Q -2.5,-8 0,-13 Q 2.5,-8 4.5,2.5 Q 2,5 0,5 Q -2,5 -4.5,2.5Z" fill="#ff4500"/>
            <path d="M -2.5,2 Q -1,-5 0,-9 Q 1,-5 2.5,2 Q 1,3.5 0,3.5 Q -1,3.5 -2.5,2Z" fill="#ff8c00"/>
            <path d="M -1,1 Q 0,-2 0,-4 Q 0,-2 1,1 Q .4,2.5 0,2.5 Q -.4,2.5 -1,1Z" fill="#ffcc00"/>
          </g>
          {/* 3 o'clock — rotate 90° (outward = RIGHT) */}
          <g className="frm-flicker" transform="translate(83,50) rotate(90)">
            <path d="M -5.5,3 Q -3,-10 0,-16 Q 3,-10 5.5,3 Q 2.5,6 0,6 Q -2.5,6 -5.5,3Z" fill="#ff4500"/>
            <path d="M -3.2,2 Q -1.5,-6 0,-11 Q 1.5,-6 3.2,2 Q 1.5,4 0,4 Q -1.5,4 -3.2,2Z" fill="#ff8c00"/>
            <path d="M -1.5,1.5 Q 0,-2 0,-5 Q 0,-2 1.5,1.5 Q .7,3 0,3 Q -.7,3 -1.5,1.5Z" fill="#ffdd00"/>
          </g>
          {/* 4:30 — rotate 135° (lower-right) */}
          <g className="frm-flicker2" transform="translate(73,73) rotate(135)">
            <path d="M -4.5,2.5 Q -2.5,-8 0,-13 Q 2.5,-8 4.5,2.5 Q 2,5 0,5 Q -2,5 -4.5,2.5Z" fill="#ff4500"/>
            <path d="M -2.5,2 Q -1,-5 0,-9 Q 1,-5 2.5,2 Q 1,3.5 0,3.5 Q -1,3.5 -2.5,2Z" fill="#ffa500"/>
            <path d="M -1,1 Q 0,-2 0,-4 Q 0,-2 1,1 Q .4,2.5 0,2.5 Q -.4,2.5 -1,1Z" fill="#ffdd00"/>
          </g>
          {/* 6 o'clock — rotate 180° (outward = DOWN) */}
          <g className="frm-flicker" transform="translate(50,83) rotate(180)">
            <path d="M -5.5,3 Q -3,-10 0,-16 Q 3,-10 5.5,3 Q 2.5,6 0,6 Q -2.5,6 -5.5,3Z" fill="#ff4500"/>
            <path d="M -3.2,2 Q -1.5,-6 0,-11 Q 1.5,-6 3.2,2 Q 1.5,4 0,4 Q -1.5,4 -3.2,2Z" fill="#ffa500"/>
            <path d="M -1.5,1.5 Q 0,-2 0,-5 Q 0,-2 1.5,1.5 Q .7,3 0,3 Q -.7,3 -1.5,1.5Z" fill="#ffdd00"/>
          </g>
          {/* 7:30 — rotate 225° (lower-left) */}
          <g className="frm-flicker2" transform="translate(27,73) rotate(225)">
            <path d="M -4.5,2.5 Q -2.5,-8 0,-13 Q 2.5,-8 4.5,2.5 Q 2,5 0,5 Q -2,5 -4.5,2.5Z" fill="#ff4500"/>
            <path d="M -2.5,2 Q -1,-5 0,-9 Q 1,-5 2.5,2 Q 1,3.5 0,3.5 Q -1,3.5 -2.5,2Z" fill="#ff8c00"/>
            <path d="M -1,1 Q 0,-2 0,-4 Q 0,-2 1,1 Q .4,2.5 0,2.5 Q -.4,2.5 -1,1Z" fill="#ffcc00"/>
          </g>
          {/* 9 o'clock — rotate 270° (outward = LEFT) */}
          <g className="frm-flicker" transform="translate(17,50) rotate(270)">
            <path d="M -5.5,3 Q -3,-10 0,-16 Q 3,-10 5.5,3 Q 2.5,6 0,6 Q -2.5,6 -5.5,3Z" fill="#ff4500"/>
            <path d="M -3.2,2 Q -1.5,-6 0,-11 Q 1.5,-6 3.2,2 Q 1.5,4 0,4 Q -1.5,4 -3.2,2Z" fill="#ff8c00"/>
            <path d="M -1.5,1.5 Q 0,-2 0,-5 Q 0,-2 1.5,1.5 Q .7,3 0,3 Q -.7,3 -1.5,1.5Z" fill="#ffdd00"/>
          </g>
          {/* 10:30 — rotate 315° (upper-left) */}
          <g className="frm-flicker2" transform="translate(27,27) rotate(315)">
            <path d="M -4.5,2.5 Q -2.5,-8 0,-13 Q 2.5,-8 4.5,2.5 Q 2,5 0,5 Q -2,5 -4.5,2.5Z" fill="#ff4500"/>
            <path d="M -2.5,2 Q -1,-5 0,-9 Q 1,-5 2.5,2 Q 1,3.5 0,3.5 Q -1,3.5 -2.5,2Z" fill="#ffa500"/>
            <path d="M -1,1 Q 0,-2 0,-4 Q 0,-2 1,1 Q .4,2.5 0,2.5 Q -.4,2.5 -1,1Z" fill="#ffdd00"/>
          </g>
        </g>
        {/* Glowing ember ring base */}
        <circle cx="50" cy="50" r="33" fill="none" stroke="#ff330077" strokeWidth="1.5"/>
        {/* Flying embers */}
        <g className="frm-twink"><circle cx="50" cy="8" r="1.4" fill="#ffaa00" opacity=".9"/></g>
        <g className="frm-twink2"><circle cx="88" cy="28" r="1.1" fill="#ff8c00" opacity=".85"/></g>
        <g className="frm-twink3"><circle cx="88" cy="72" r="1.2" fill="#ffcc00" opacity=".8"/></g>
        <g className="frm-twink"><circle cx="12" cy="28" r="1" fill="#ff6600" opacity=".8"/></g>
        <g className="frm-twink2"><circle cx="12" cy="72" r="1.1" fill="#ff8c00" opacity=".75"/></g>
      </svg>
    ),
    sunflower: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        {/* ── Sunflower wreath: 6 flowers around the avatar ── */}
        {/* Green vine connecting them */}
        <circle cx="50" cy="50" r="34" fill="none" stroke="#1a4a08" strokeWidth="2.8"/>
        <circle cx="50" cy="50" r="34" fill="none" stroke="#2d7a14" strokeWidth="1.4" strokeDasharray="5 3" opacity=".6"/>
        {/* ── Sunflower helper: petals = 8 ellipses in a ring, using rotate ── */}
        {/* Sunflower 1 — 12 o'clock */}
        <g transform="translate(50,13)">
          {([0,45,90,135,180,225,270,315] as number[]).map((a,i) => (
            <g key={i} transform={`rotate(${a})`}>
              <ellipse cx="0" cy="-6" rx="2.4" ry="4.2" fill={i%2===0?"#f59e0b":"#fbbf24"} opacity=".95"/>
            </g>
          ))}
          <circle r="3.8" fill="#78350f"/>
          <circle r="2.2" fill="#92400e" opacity=".75"/>
          <circle r="1" fill="#451a03" opacity=".5"/>
        </g>
        {/* Sunflower 2 — 2 o'clock */}
        <g transform="translate(79,27)">
          {([0,45,90,135,180,225,270,315] as number[]).map((a,i) => (
            <g key={i} transform={`rotate(${a})`}>
              <ellipse cx="0" cy="-5.5" rx="2.2" ry="3.8" fill={i%2===0?"#fbbf24":"#f59e0b"} opacity=".92"/>
            </g>
          ))}
          <circle r="3.4" fill="#78350f"/>
          <circle r="2" fill="#92400e" opacity=".7"/>
        </g>
        {/* Sunflower 3 — 4 o'clock */}
        <g transform="translate(79,73)">
          {([0,45,90,135,180,225,270,315] as number[]).map((a,i) => (
            <g key={i} transform={`rotate(${a})`}>
              <ellipse cx="0" cy="-5.5" rx="2.2" ry="3.8" fill={i%2===0?"#f59e0b":"#fbbf24"} opacity=".92"/>
            </g>
          ))}
          <circle r="3.4" fill="#78350f"/>
          <circle r="2" fill="#92400e" opacity=".7"/>
        </g>
        {/* Sunflower 4 — 6 o'clock */}
        <g transform="translate(50,87)">
          {([0,45,90,135,180,225,270,315] as number[]).map((a,i) => (
            <g key={i} transform={`rotate(${a})`}>
              <ellipse cx="0" cy="-6" rx="2.4" ry="4.2" fill={i%2===0?"#fbbf24":"#f59e0b"} opacity=".95"/>
            </g>
          ))}
          <circle r="3.8" fill="#78350f"/>
          <circle r="2.2" fill="#92400e" opacity=".75"/>
          <circle r="1" fill="#451a03" opacity=".5"/>
        </g>
        {/* Sunflower 5 — 8 o'clock */}
        <g transform="translate(21,73)">
          {([0,45,90,135,180,225,270,315] as number[]).map((a,i) => (
            <g key={i} transform={`rotate(${a})`}>
              <ellipse cx="0" cy="-5.5" rx="2.2" ry="3.8" fill={i%2===0?"#f59e0b":"#fbbf24"} opacity=".92"/>
            </g>
          ))}
          <circle r="3.4" fill="#78350f"/>
          <circle r="2" fill="#92400e" opacity=".7"/>
        </g>
        {/* Sunflower 6 — 10 o'clock */}
        <g transform="translate(21,27)">
          {([0,45,90,135,180,225,270,315] as number[]).map((a,i) => (
            <g key={i} transform={`rotate(${a})`}>
              <ellipse cx="0" cy="-5.5" rx="2.2" ry="3.8" fill={i%2===0?"#fbbf24":"#f59e0b"} opacity=".92"/>
            </g>
          ))}
          <circle r="3.4" fill="#78350f"/>
          <circle r="2" fill="#92400e" opacity=".7"/>
        </g>
        {/* Leaves between flowers */}
        <path d="M 50,17 Q 58,20 65,24" fill="none" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M 65,24 Q 70,28 73,33" fill="none" stroke="#16a34a" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M 50,83 Q 42,80 35,76" fill="none" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M 35,76 Q 30,72 27,67" fill="none" stroke="#16a34a" strokeWidth="1.6" strokeLinecap="round"/>
        {/* Leaf blades */}
        <path d="M 62,22 Q 66,17 70,20 Q 66,25 62,22Z" fill="#16a34a" opacity=".9"/>
        <path d="M 38,78 Q 34,83 30,80 Q 34,75 38,78Z" fill="#16a34a" opacity=".9"/>
        <path d="M 28,32 Q 23,28 24,24 Q 28,28 29,33Z" fill="#16a34a" opacity=".85"/>
        <path d="M 72,68 Q 77,72 76,76 Q 72,72 71,67Z" fill="#16a34a" opacity=".85"/>
      </svg>
    ),
    lolita_charms: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        {/* ── Lolita lace ring ── */}
        {/* Outer ring */}
        <circle cx="50" cy="50" r="44" fill="none" stroke="#c785b2" strokeWidth="1.4" opacity=".8"/>
        {/* Inner lace border */}
        <circle cx="50" cy="50" r="40" fill="none" stroke="#7d5464" strokeWidth="0.8" strokeDasharray="2 3" opacity=".9" className="lace-pulse"/>
        {/* Lace dot border — 24 dots around the ring */}
        {Array.from({length:24}).map((_,i) => {
          const a = (i/24)*2*Math.PI - Math.PI/2;
          const r = 42;
          return <circle key={i} cx={50+r*Math.cos(a)} cy={50+r*Math.sin(a)} r={i%3===0?1.8:1.1} fill={i%3===0?"#f0b3e8":"#c785b2"} opacity={i%3===0?.9:.6} className={i%4===0?"lace-pulse":""}/>;
        })}
        {/* ── Bows at cardinal points ── */}
        {/* Top bow */}
        <g transform="translate(50,7)">
          <path d="M-5,0 Q-8,-5 -5,-8 Q-2,-3 0,-2 Q2,-3 5,-8 Q8,-5 5,0 Q2,3 0,2 Q-2,3 -5,0Z" fill="#c785b2" opacity=".9"/>
          <ellipse cx="0" cy="0" rx="1.5" ry="1.5" fill="#f0b3e8"/>
          <path d="M0,2 Q0,5 -3,7" fill="none" stroke="#c785b2" strokeWidth=".8"/>
          <path d="M0,2 Q0,5 3,7" fill="none" stroke="#c785b2" strokeWidth=".8"/>
        </g>
        {/* Left bow */}
        <g transform="translate(7,50)">
          <path d="M0,-5 Q-5,-8 -8,-5 Q-3,-2 -2,0 Q-3,2 -8,5 Q-5,8 0,5 Q3,2 2,0 Q3,-2 0,-5Z" fill="#7d5464" opacity=".85"/>
          <ellipse cx="0" cy="0" rx="1.5" ry="1.5" fill="#f0b3e8"/>
        </g>
        {/* Right bow */}
        <g transform="translate(93,50)">
          <path d="M0,-5 Q5,-8 8,-5 Q3,-2 2,0 Q3,2 8,5 Q5,8 0,5 Q-3,2 -2,0 Q-3,-2 0,-5Z" fill="#7d5464" opacity=".85"/>
          <ellipse cx="0" cy="0" rx="1.5" ry="1.5" fill="#f0b3e8"/>
        </g>
        {/* Bottom bow (above hanging charms) */}
        <g transform="translate(50,93)">
          <path d="M-5,0 Q-8,-5 -5,-8 Q-2,-3 0,-2 Q2,-3 5,-8 Q8,-5 5,0 Q2,3 0,2 Q-2,3 -5,0Z" fill="#c785b2" opacity=".9"/>
          <ellipse cx="0" cy="0" rx="1.5" ry="1.5" fill="#f0b3e8"/>
        </g>
        {/* Small roses at diagonal points */}
        {[[-6,-6],[6,-6],[-6,6],[6,6]].map(([dx,dy],i) => (
          <g key={i} transform={`translate(${50+dx*5.6},${50+dy*5.6})`} opacity=".75">
            <circle r="2.8" fill="#7d5464"/>
            <circle r="1.6" fill="#c785b2"/>
            <circle r=".7" fill="#f0b3e8"/>
          </g>
        ))}
      </svg>
    ),
    goth_charms: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        {/* ── Gothic cathedral ring ── */}
        {/* Outer silver ring */}
        <circle cx="50" cy="50" r="44" fill="none" stroke="#cccccc" strokeWidth="1.6" opacity=".9" className="gothic-glow"/>
        {/* Inner dark ring */}
        <circle cx="50" cy="50" r="40" fill="none" stroke="#38363f" strokeWidth="1.2" opacity=".8"/>
        {/* Gothic arch pattern dots — 20 dots with cross-shaped highlights at cardinals */}
        {Array.from({length:20}).map((_,i) => {
          const a = (i/20)*2*Math.PI - Math.PI/2;
          const r = 42;
          const isCardinal = i % 5 === 0;
          return <circle key={i} cx={50+r*Math.cos(a)} cy={50+r*Math.sin(a)} r={isCardinal?2.2:1} fill={isCardinal?"#ffffff":"#cccccc"} opacity={isCardinal?1:.6} className={isCardinal?"gothic-pulse":""}/>;
        })}
        {/* ── Gothic cross at top ── */}
        <g transform="translate(50,6)" className="gothic-glow">
          <rect x="-1.2" y="-7" width="2.4" height="14" fill="#ffffff" rx=".4"/>
          <rect x="-5" y="-2" width="10" height="2.4" fill="#ffffff" rx=".4"/>
          <circle cx="0" cy="-7" r="1" fill="#cccccc"/>
        </g>
        {/* ── Bat wings at diagonal positions ── */}
        {/* Top-right bat */}
        <g transform="translate(76,24)" opacity=".8">
          <path d="M0,0 Q6,-4 10,-2 Q8,2 4,2 Q2,4 0,0Z" fill="#cccccc"/>
          <path d="M0,0 Q-6,-4 -10,-2 Q-8,2 -4,2 Q-2,4 0,0Z" fill="#cccccc"/>
          <circle cx="0" cy="0" r="1.5" fill="#ffffff"/>
        </g>
        {/* Top-left bat */}
        <g transform="translate(24,24)" opacity=".8">
          <path d="M0,0 Q6,-4 10,-2 Q8,2 4,2 Q2,4 0,0Z" fill="#cccccc"/>
          <path d="M0,0 Q-6,-4 -10,-2 Q-8,2 -4,2 Q-2,4 0,0Z" fill="#cccccc"/>
          <circle cx="0" cy="0" r="1.5" fill="#ffffff"/>
        </g>
        {/* ── Gothic pointed arch accents at sides ── */}
        {/* Left arch */}
        <path d="M8,40 Q6,50 8,60" fill="none" stroke="#cccccc" strokeWidth="1.2" strokeLinecap="round" opacity=".6"/>
        {/* Right arch */}
        <path d="M92,40 Q94,50 92,60" fill="none" stroke="#cccccc" strokeWidth="1.2" strokeLinecap="round" opacity=".6"/>
        {/* Bottom arch point */}
        <path d="M44,92 Q50,97 56,92" fill="none" stroke="#cccccc" strokeWidth="1.2" strokeLinecap="round" opacity=".7"/>
        {/* Diamond accents at 3/6/9 o'clock */}
        <polygon points="94,50 96,52 94,54 92,52" fill="#ffffff" opacity=".8" className="gothic-pulse"/>
        <polygon points="6,50 8,52 6,54 4,52" fill="#ffffff" opacity=".8" className="gothic-pulse"/>
        <polygon points="50,94 52,96 50,98 48,96" fill="#cccccc" opacity=".7"/>
      </svg>
    ),
    amethyst_charms: (
      <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
        {/* ── Amethyst outer ring ── */}
        <circle cx="50" cy="50" r="44" fill="none" stroke="#b08edf" strokeWidth="1.5" opacity=".85" className="amethyst-shimmer"/>
        {/* Mid ring — dark velvet */}
        <circle cx="50" cy="50" r="40.5" fill="none" stroke="#3d2868" strokeWidth="1" opacity=".7"/>
        {/* Inner ring */}
        <circle cx="50" cy="50" r="38" fill="none" stroke="#5a3d8a" strokeWidth="0.6" strokeDasharray="3 4" opacity=".6"/>
        {/* ── Gem dots around the ring (16) — alternating amethyst sizes ── */}
        {Array.from({length:16}).map((_,i) => {
          const a = (i/16)*2*Math.PI - Math.PI/2;
          const r = 42;
          const isGem = i % 4 === 0;
          return <circle key={i} cx={50+r*Math.cos(a)} cy={50+r*Math.sin(a)} r={isGem?2.4:1.2} fill={isGem?"#c8a8f0":"#7a55a8"} opacity={isGem?.95:.6} className={isGem?"amethyst-pulse":""}/>;
        })}
        {/* ── Open book at top ── */}
        <g transform="translate(50,6.5)">
          {/* Left page */}
          <path d="M0,-4.5 L-8,-3 L-8,4 L0,2.5 Z" fill="#1e162e" stroke="#b08edf" strokeWidth=".8" opacity=".9"/>
          {/* Right page */}
          <path d="M0,-4.5 L8,-3 L8,4 L0,2.5 Z" fill="#241535" stroke="#b08edf" strokeWidth=".8" opacity=".9"/>
          {/* Spine */}
          <line x1="0" y1="-4.5" x2="0" y2="2.5" stroke="#c8a8f0" strokeWidth="1" opacity=".8"/>
          {/* Text lines left page */}
          <line x1="-6.5" y1="-1.5" x2="-1.2" y2="-2" stroke="#9070b8" strokeWidth=".4" opacity=".7"/>
          <line x1="-6.5" y1=".5" x2="-1.2" y2="0" stroke="#9070b8" strokeWidth=".4" opacity=".7"/>
          {/* Text lines right page */}
          <line x1="1.2" y1="-2" x2="6.5" y2="-1.5" stroke="#9070b8" strokeWidth=".4" opacity=".7"/>
          <line x1="1.2" y1="0" x2="6.5" y2=".5" stroke="#9070b8" strokeWidth=".4" opacity=".7"/>
          {/* Gem on spine */}
          <circle cx="0" cy="-4.5" r="1.3" fill="#c8a8f0" className="amethyst-pulse"/>
        </g>
        {/* ── Quill at left ── */}
        <g transform="translate(7,50) rotate(-15)">
          <path d="M0,-9 Q3,-5 1,0 Q-1,4 0,8" fill="none" stroke="#b08edf" strokeWidth="1" strokeLinecap="round" opacity=".9" className="amethyst-shimmer"/>
          <path d="M0,-9 Q-3,-5 -1,0 Q1,4 0,8" fill="none" stroke="#7a55a8" strokeWidth=".8" strokeLinecap="round" opacity=".7"/>
          <line x1="0" y1="-9" x2="0" y2="8" stroke="#c8a8f0" strokeWidth=".5" opacity=".5"/>
          <circle cx="0" cy="-9" r="1" fill="#c8a8f0" opacity=".9"/>
        </g>
        {/* ── Inkwell at right ── */}
        <g transform="translate(93,50)">
          <ellipse cx="0" cy="2" rx="5" ry="3" fill="#3d2868" stroke="#7a55a8" strokeWidth=".7" opacity=".9"/>
          <rect x="-3.5" y="-4" width="7" height="6" rx="1.5" fill="#241535" stroke="#5a3d8a" strokeWidth=".7" opacity=".9"/>
          <ellipse cx="0" cy="-4" rx="3.5" ry="1.2" fill="#3d2868" stroke="#7a55a8" strokeWidth=".6" opacity=".8"/>
          <circle cx="0" cy="-4" r=".8" fill="#c8a8f0" className="amethyst-pulse"/>
        </g>
        {/* ── Key at bottom (above charms) ── */}
        <g transform="translate(50,93)">
          <circle cx="0" cy="0" r="3" fill="none" stroke="#b08edf" strokeWidth="1.2" opacity=".85" className="amethyst-shimmer"/>
          <line x1="3" y1="0" x2="9" y2="0" stroke="#b08edf" strokeWidth="1.2" opacity=".85"/>
          <line x1="7" y1="0" x2="7" y2="2.5" stroke="#b08edf" strokeWidth="1" opacity=".7"/>
          <line x1="9" y1="0" x2="9" y2="-2" stroke="#b08edf" strokeWidth="1" opacity=".7"/>
          <circle cx="0" cy="0" r="1.2" fill="#c8a8f0" opacity=".6"/>
        </g>
        {/* ── Small amethyst gem clusters at diagonal positions ── */}
        {[[-7,-7],[7,-7],[-7,7],[7,7]].map(([dx,dy],i) => (
          <g key={i} transform={`translate(${50+dx*5},${50+dy*5})`} opacity=".8">
            <polygon points="0,-3 2.6,1.5 -2.6,1.5" fill="#7a55a8" opacity=".9"/>
            <polygon points="0,-1.8 1.6,.9 -1.6,.9" fill="#c8a8f0" opacity=".7"/>
            <circle cx="0" cy="-1" r=".6" fill="#e8d8f8" opacity=".8" className="amethyst-pulse"/>
          </g>
        ))}
      </svg>
    ),
      pastel_charms: (
        <svg viewBox="0 0 100 100" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", overflow:"visible" }}>
          {/* Outer pastel ring */}
          <circle cx="50" cy="50" r="44" fill="none" stroke="#F9CCE2" strokeWidth="2" opacity=".8"/>
          <circle cx="50" cy="50" r="40" fill="none" stroke="#FFDBEA" strokeWidth="0.8" strokeDasharray="3 4" opacity=".7" className="pastel-float"/>
          {/* Rainbow dots — pastel MLP palette */}
          {Array.from({length:30}).map((_,i) => {
            const a = (i/30)*2*Math.PI - Math.PI/2;
            const r = 42;
            const colors = ["#F9CCE2","#E2B5E1","#ACC2EF","#C4E3F2","#FFDBEA","#E2B5E1","#F9CCE2"];
            return <circle key={i} cx={50+r*Math.cos(a)} cy={50+r*Math.sin(a)} r={i%5===0?2.2:1.2} fill={colors[i%colors.length]} opacity={i%5===0?1:.7} className={i%5===0?"pastel-sparkle":""}/>;
          })}
          {/* Top star */}
          <g transform="translate(50,6)" className="pastel-sparkle">
            <polygon points="0,-6 1.4,-2 5.7,-2 2.4,1 3.5,5.4 0,3 -3.5,5.4 -2.4,1 -5.7,-2 -1.4,-2" fill="#E2B5E1" stroke="#F9CCE2" strokeWidth=".5"/>
          </g>
          {/* Left heart */}
          <g transform="translate(6,50)" opacity=".9">
            <path d="M0,3 Q-5,-2 -5,-6 Q-5,-11 0,-8 Q5,-11 5,-6 Q5,-2 0,3Z" fill="#F9CCE2" stroke="#FFDBEA" strokeWidth=".5"/>
          </g>
          {/* Right cloud */}
          <g transform="translate(93,50)" opacity=".85">
            <ellipse cx="-1" cy="0" rx="4" ry="2.8" fill="#C4E3F2"/>
            <ellipse cx="2" cy="-1" rx="3" ry="2.4" fill="#C4E3F2"/>
            <ellipse cx="4" cy="0" rx="2.5" ry="2" fill="#C4E3F2"/>
          </g>
          {/* Sparkle stars at diagonals */}
          {([[-6,-6],[6,-6],[-6,6],[6,6]] as [number,number][]).map(([dx,dy],i) => (
            <g key={i} transform={`translate(${50+dx*5.6},${50+dy*5.6})`} className="pastel-sparkle">
              <polygon points="0,-3 .7,-1 2,-1 1.2,.8 1.8,2.6 0,1.4 -1.8,2.6 -1.2,.8 -2,-1 -.7,-1" fill="#E2B5E1" opacity=".8"/>
            </g>
          ))}
          {/* Bottom bow */}
          <g transform="translate(50,93)">
            <path d="M-6,0 Q-9,-5 -6,-8 Q-2,-3 0,-2 Q2,-3 6,-8 Q9,-5 6,0 Q2,3 0,2 Q-2,3 -6,0Z" fill="#F9CCE2" stroke="#E2B5E1" strokeWidth=".6"/>
            <ellipse cx="0" cy="0" rx="1.2" ry="1.2" fill="#FFDBEA"/>
          </g>
        </svg>
      ),
    chess_aura: (
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",zIndex:2,overflow:"visible"}}>
        <defs>
          <filter id="viiGlowF1" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="viiGlowF2" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        {/* Deep outer glow halo */}
        <circle cx="50" cy="50" r="48" fill="none" stroke="#03B0D3" strokeWidth="1.5" opacity=".18" filter="url(#viiGlowF2)"/>
        {/* 16 chess squares around the ring */}
        {(Array.from({length:16}) as undefined[]).map((_,i)=>{
          const ang=(i/16)*2*Math.PI;
          const cx2=50+41.5*Math.sin(ang);
          const cy2=50-41.5*Math.cos(ang);
          const deg=(i/16)*360;
          const isDark=i%2===0;
          return <rect key={i} x={cx2-3.5} y={cy2-3.5} width={7} height={7}
            fill={isDark?"#03B0D3":"#caf0f8"} opacity={isDark?.85:.5}
            transform={`rotate(${deg},${cx2},${cy2})`} rx={0.6}/>;
        })}
        {/* Dashed inner ring with rotation animation */}
        <circle cx="50" cy="50" r="37.5" fill="none" stroke="#48cae4" strokeWidth="1.4" opacity=".65" filter="url(#viiGlowF1)" strokeDasharray="5 3" className="vii-ring"/>
        {/* Main glowing ring */}
        <circle cx="50" cy="50" r="43" fill="none" stroke="#03B0D3" strokeWidth="2.5" opacity=".92" filter="url(#viiGlowF1)" className="frm-glow"/>
        {/* Chess pieces at cardinal points */}
        <text x="50" y="9" textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="#caf0f8" opacity=".95" filter="url(#viiGlowF1)" className="chess-drift">♔</text>
        <text x="50" y="95" textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="#48cae4" opacity=".88" filter="url(#viiGlowF1)" className="chess-drift2">♛</text>
        <text x="6" y="51" textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="#90e0ef" opacity=".82" filter="url(#viiGlowF1)" className="chess-drift3">♜</text>
        <text x="94" y="51" textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="#90e0ef" opacity=".82" filter="url(#viiGlowF1)" className="chess-drift3">♜</text>
        {/* Diagonal minor pieces */}
        <text x="15" y="16" textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="#48cae4" opacity=".68" className="chess-drift2">♞</text>
        <text x="85" y="16" textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="#48cae4" opacity=".68" className="chess-drift">♞</text>
        <text x="15" y="87" textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="#48cae4" opacity=".65" className="chess-drift3">♝</text>
        <text x="85" y="87" textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="#48cae4" opacity=".65" className="chess-drift2">♝</text>
      </svg>
    ),
  };

  // Gothic hanging charms rendered below the avatar circle (no mask)
  const gothCharmsSVG = (size: number) => {
    const pad = Math.round(size * 0.38);
    const outer = size + pad * 2;
    const cx = outer / 2;
    const cy = outer / 2 + size / 2 + pad * 0.12;
    return (
      <svg
        viewBox={`0 0 ${outer} ${outer + 44}`}
        style={{ position:"absolute", top:0, left:0, width:outer, height:outer + 44, pointerEvents:"none", overflow:"visible", zIndex:3 }}
      >
        {/* Chain threads */}
        <line x1={cx-20} y1={cy} x2={cx-20} y2={cy+20} stroke="#cccccc" strokeWidth=".8" opacity=".6"/>
        <line x1={cx} y1={cy} x2={cx} y2={cy+24} stroke="#cccccc" strokeWidth=".8" opacity=".7"/>
        <line x1={cx+20} y1={cy} x2={cx+20} y2={cy+20} stroke="#cccccc" strokeWidth=".8" opacity=".6"/>
        {/* Left charm: gothic cross */}
        <g transform={`translate(${cx-20},${cy+20})`} className="charm-swing2">
          <rect x="-1.5" y="-8" width="3" height="16" fill="#cccccc" rx=".5" stroke="#ffffff" strokeWidth=".3"/>
          <rect x="-6" y="-3" width="12" height="3" fill="#cccccc" rx=".5" stroke="#ffffff" strokeWidth=".3"/>
          <circle cx="0" cy="-8" r="1.2" fill="#ffffff"/>
        </g>
        {/* Centre charm: skull */}
        <g transform={`translate(${cx},${cy+24})`} className="charm-swing">
          {/* Skull dome */}
          <ellipse cx="0" cy="-8" rx="7" ry="6" fill="#e0e0e0" stroke="#cccccc" strokeWidth=".5"/>
          {/* Eye sockets */}
          <ellipse cx="-2.5" cy="-9" rx="2" ry="2" fill="#16181a"/>
          <ellipse cx="2.5" cy="-9" rx="2" ry="2" fill="#16181a"/>
          {/* Nose */}
          <ellipse cx="0" cy="-6" rx="1" ry="1.2" fill="#38363f"/>
          {/* Teeth */}
          <rect x="-4" y="-3" width="2.2" height="2.5" fill="#16181a" rx=".3"/>
          <rect x="-1" y="-3" width="2" height="2.5" fill="#16181a" rx=".3"/>
          <rect x="1.8" y="-3" width="2.2" height="2.5" fill="#16181a" rx=".3"/>
        </g>
        {/* Right charm: black moon crescent */}
        <g transform={`translate(${cx+20},${cy+20})`} className="charm-swing3">
          <path d="M0,-9 Q8,-6 8,0 Q8,7 0,9 Q4,6 4,0 Q4,-6 0,-9Z" fill="#cccccc" stroke="#ffffff" strokeWidth=".4"/>
          <circle cx="-1" cy="0" r="1" fill="#ffffff" opacity=".5" className="gothic-pulse"/>
        </g>
      </svg>
    );
  };

  // Yvonne Everleigh hanging charms — literary: ink-drop, open-book, amethyst gem
  const yvonneCharmsSVG = (size: number) => {
    const pad = Math.round(size * 0.38);
    const outer = size + pad * 2;
    const cx = outer / 2;
    const cy = outer / 2 + size / 2 + pad * 0.12;
    return (
      <svg
        viewBox={`0 0 ${outer} ${outer + 44}`}
        style={{ position:"absolute", top:0, left:0, width:outer, height:outer + 44, pointerEvents:"none", overflow:"visible", zIndex:3 }}
      >
        {/* Chain threads — amethyst purple */}
        <line x1={cx-22} y1={cy} x2={cx-22} y2={cy+18} stroke="#9070b8" strokeWidth=".8" opacity=".7"/>
        <line x1={cx} y1={cy} x2={cx} y2={cy+26} stroke="#b08edf" strokeWidth=".9" opacity=".8"/>
        <line x1={cx+22} y1={cy} x2={cx+22} y2={cy+18} stroke="#9070b8" strokeWidth=".8" opacity=".7"/>
        {/* Left charm: open mini book */}
        <g transform={`translate(${cx-22},${cy+18})`} className="charm-swing2">
          <path d="M0,-6 L-5.5,-4.5 L-5.5,4.5 L0,3 Z" fill="#1e162e" stroke="#b08edf" strokeWidth=".7" opacity=".9"/>
          <path d="M0,-6 L5.5,-4.5 L5.5,4.5 L0,3 Z" fill="#241535" stroke="#b08edf" strokeWidth=".7" opacity=".9"/>
          <line x1="0" y1="-6" x2="0" y2="3" stroke="#c8a8f0" strokeWidth=".8" opacity=".8"/>
          <line x1="-4" y1="-1" x2="-0.8" y2="-1.3" stroke="#7a55a8" strokeWidth=".4" opacity=".6"/>
          <line x1="0.8" y1="-1.3" x2="4" y2="-1" stroke="#7a55a8" strokeWidth=".4" opacity=".6"/>
          <circle cx="0" cy="-6" r=".9" fill="#c8a8f0" className="amethyst-pulse"/>
        </g>
        {/* Centre charm: amethyst gem */}
        <g transform={`translate(${cx},${cy+26})`} className="charm-swing">
          {/* Gem facets */}
          <polygon points="0,-10 7,-4 7,4 0,8 -7,4 -7,-4" fill="#3d2868" stroke="#b08edf" strokeWidth=".8" opacity=".9"/>
          <polygon points="0,-10 7,-4 0,-2" fill="#7a55a8" opacity=".7"/>
          <polygon points="0,-10 -7,-4 0,-2" fill="#9070b8" opacity=".7"/>
          <polygon points="7,-4 7,4 0,-2" fill="#5a3d8a" opacity=".8"/>
          <polygon points="-7,-4 -7,4 0,-2" fill="#6a4a9a" opacity=".8"/>
          <polygon points="0,8 7,4 0,-2" fill="#4a2868" opacity=".9"/>
          <polygon points="0,8 -7,4 0,-2" fill="#3d2060" opacity=".9"/>
          <circle cx="0" cy="-3" r="2" fill="#e8d8f8" opacity=".5" className="amethyst-pulse"/>
        </g>
        {/* Right charm: quill and ink drop */}
        <g transform={`translate(${cx+22},${cy+18})`} className="charm-swing3">
          {/* Quill shaft */}
          <line x1="0" y1="-9" x2="0" y2="5" stroke="#b08edf" strokeWidth=".9" strokeLinecap="round" opacity=".9" className="amethyst-shimmer"/>
          <path d="M0,-9 Q3,-5 2,0 Q0,4 0,5" fill="none" stroke="#c8a8f0" strokeWidth=".7" opacity=".7"/>
          <path d="M0,-9 Q-3,-5 -2,0 Q0,4 0,5" fill="none" stroke="#9070b8" strokeWidth=".6" opacity=".6"/>
          <circle cx="0" cy="-9" r="1.2" fill="#c8a8f0" opacity=".9" className="amethyst-pulse"/>
          {/* Ink drop at base */}
          <path d="M0,5 Q-2,7 0,10 Q2,7 0,5Z" fill="#7a55a8" opacity=".8"/>
          <circle cx="0" cy="8" r=".7" fill="#c8a8f0" opacity=".5"/>
        </g>
      </svg>
    );
  };

  // Lolita hanging charms rendered below the avatar circle (no mask)
  const lolitaCharmsSVG = (size: number) => {
    const pad = Math.round(size * 0.38);
    const outer = size + pad * 2;
    const cx = outer / 2;
    const cy = outer / 2 + size / 2 + pad * 0.1;
    return (
      <svg
        viewBox={`0 0 ${outer} ${outer + 40}`}
        style={{ position:"absolute", top:0, left:0, width:outer, height:outer + 40, pointerEvents:"none", overflow:"visible", zIndex:3 }}
      >
        {/* Charm chains — 3 ribbons hanging from bottom arc */}
        {/* Left charm: heart */}
        <line x1={cx-18} y1={cy} x2={cx-18} y2={cy+18} stroke="#c785b2" strokeWidth=".9" opacity=".7"/>
        <g transform={`translate(${cx-18},${cy+18})`} className="charm-swing2">
          <path d="M0,0 Q-5,-4 -5,-8 Q-5,-14 0,-10 Q5,-14 5,-8 Q5,-4 0,0Z" fill="#c785b2" stroke="#f0b3e8" strokeWidth=".5"/>
          <circle cx="0" cy="-10" r="1" fill="#f0b3e8" opacity=".8"/>
        </g>
        {/* Centre charm: ribbon bow */}
        <line x1={cx} y1={cy} x2={cx} y2={cy+22} stroke="#7d5464" strokeWidth=".9" opacity=".8"/>
        <g transform={`translate(${cx},${cy+22})`} className="charm-swing">
          <path d="M-7,-3 Q-10,-7 -7,-10 Q-3,-6 0,-5 Q3,-6 7,-10 Q10,-7 7,-3 Q3,1 0,0 Q-3,1 -7,-3Z" fill="#c785b2" stroke="#f0b3e8" strokeWidth=".5"/>
          <ellipse cx="0" cy="-2.5" rx="1.2" ry="1.2" fill="#f0b3e8"/>
          <line x1="-1" y1="0" x2="-2" y2="5" stroke="#c785b2" strokeWidth=".7"/>
          <line x1="1" y1="0" x2="2" y2="5" stroke="#c785b2" strokeWidth=".7"/>
        </g>
        {/* Right charm: star */}
        <line x1={cx+18} y1={cy} x2={cx+18} y2={cy+18} stroke="#c785b2" strokeWidth=".9" opacity=".7"/>
        <g transform={`translate(${cx+18},${cy+20})`} className="charm-swing3">
          <polygon points="0,-7 1.6,-2.2 6.7,-2.2 2.6,0.8 4.1,5.7 0,2.8 -4.1,5.7 -2.6,0.8 -6.7,-2.2 -1.6,-2.2" fill="#f0b3e8" stroke="#c785b2" strokeWidth=".5" opacity=".9"/>
        </g>
      </svg>
    );
  };

    const viiCharmsSVG = (size: number) => {
    const pad = Math.round(size * 0.38);
    const outer = size + pad * 2;
    const cx = outer / 2;
    const cy = outer / 2 + size / 2 + pad * 0.1;
    return (
      <svg viewBox={`0 0 ${outer} ${outer+44}`}
        style={{position:"absolute",top:0,left:0,width:outer,height:outer+44,pointerEvents:"none",overflow:"visible",zIndex:3}}>
        <defs>
          <filter id="viiCGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        {/* Chains */}
        <line x1={cx-20} y1={cy} x2={cx-20} y2={cy+28} stroke="#03B0D3" strokeWidth=".9" opacity=".55"/>
        <line x1={cx} y1={cy} x2={cx} y2={cy+24} stroke="#48cae4" strokeWidth=".9" opacity=".7"/>
        <line x1={cx+20} y1={cy} x2={cx+20} y2={cy+28} stroke="#03B0D3" strokeWidth=".9" opacity=".55"/>
        {/* Left — King ♔ */}
        <text x={cx-20} y={cy+40} textAnchor="middle" fontSize="14" fill="#caf0f8" opacity=".92"
          filter="url(#viiCGlow)" className="chess-drift3">♔</text>
        {/* Centre — Queen ♛ (largest, most glowing) */}
        <text x={cx} y={cy+37} textAnchor="middle" fontSize="16" fill="#03B0D3" opacity="1"
          filter="url(#viiCGlow)" className="vii-pulse">♛</text>
        {/* Right — Knight ♞ */}
        <text x={cx+20} y={cy+40} textAnchor="middle" fontSize="14" fill="#48cae4" opacity=".88"
          filter="url(#viiCGlow)" className="chess-drift">♞</text>
      </svg>
    );
  };

    const pastelCharmsSVG = (size: number) => {
      const pad = Math.round(size * 0.38);
      const outer = size + pad * 2;
      const cx = outer / 2;
      const cy = outer / 2 + size / 2 + pad * 0.1;
      return (
        <svg
          viewBox={`0 0 ${outer} ${outer + 40}`}
          style={{ position:"absolute", top:0, left:0, width:outer, height:outer + 40, pointerEvents:"none", overflow:"visible", zIndex:3 }}
        >
          {/* Left charm: star */}
          <line x1={cx-18} y1={cy} x2={cx-18} y2={cy+18} stroke="#E2B5E1" strokeWidth=".9" opacity=".7"/>
          <g transform={`translate(${cx-18},${cy+20})`} className="charm-swing2">
            <polygon points="0,-7 1.6,-2.2 6.7,-2.2 2.6,0.8 4.1,5.7 0,2.8 -4.1,5.7 -2.6,0.8 -6.7,-2.2 -1.6,-2.2" fill="#F9CCE2" stroke="#E2B5E1" strokeWidth=".5"/>
            <circle cx="0" cy="-7" r=".8" fill="#FFDBEA" opacity=".9"/>
          </g>
          {/* Centre charm: bow */}
          <line x1={cx} y1={cy} x2={cx} y2={cy+22} stroke="#F9CCE2" strokeWidth=".9" opacity=".8"/>
          <g transform={`translate(${cx},${cy+22})`} className="charm-swing">
            <path d="M-7,-3 Q-10,-7 -7,-10 Q-3,-6 0,-5 Q3,-6 7,-10 Q10,-7 7,-3 Q3,1 0,0 Q-3,1 -7,-3Z" fill="#E2B5E1" stroke="#FFDBEA" strokeWidth=".5"/>
            <ellipse cx="0" cy="-2.5" rx="1.2" ry="1.2" fill="#F9CCE2"/>
            <line x1="-1" y1="0" x2="-2" y2="5" stroke="#E2B5E1" strokeWidth=".7"/>
            <line x1="1" y1="0" x2="2" y2="5" stroke="#E2B5E1" strokeWidth=".7"/>
          </g>
          {/* Right charm: heart */}
          <line x1={cx+18} y1={cy} x2={cx+18} y2={cy+18} stroke="#F9CCE2" strokeWidth=".9" opacity=".7"/>
          <g transform={`translate(${cx+18},${cy+18})`} className="charm-swing3">
            <path d="M0,4 Q-5,-1 -5,-5 Q-5,-10 0,-7 Q5,-10 5,-5 Q5,-1 0,4Z" fill="#F9CCE2" stroke="#FFDBEA" strokeWidth=".5"/>
            <circle cx="0" cy="-7" r=".8" fill="#FFDBEA" opacity=".8"/>
          </g>
        </svg>
      );
    };
  
  const framedAvatar = (pic: string | undefined | null, size: number, frameId: string) => {
    const p = pic || "🌑";
    const isImg = p.startsWith("/") || p.startsWith("http") || p.startsWith("data:");
    const picInner = isImg
      ? <img src={p} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
      : <span style={{ fontSize: size * 0.82, lineHeight: 1 }}>{p}</span>;
    if (!frameId || frameId === "none") {
      return (
        <div style={{ width: size, height: size, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0, background: "rgba(0,0,0,.3)" }}>
          {picInner}
        </div>
      );
    }
    const pad = Math.round(size * 0.38);
    const outer = size + pad * 2;
    const frameSvg = FRAME_SVG[frameId];
    // Mask cuts out the avatar circle so frame art only appears in the surrounding ring.
    // 39–42% matches the avatar radius (~40% of the farthest-corner gradient radius for any size).
    const ringMask = "radial-gradient(circle at center, transparent 39%, white 42%)";
    const isLolita = frameId === "lolita_charms";
    const isGoth = frameId === "goth_charms";
    const isAmethyst = frameId === "amethyst_charms";
    const isPastel = frameId === "pastel_charms";
    const isChessAura = frameId === "chess_aura";
    const hasCharms = isLolita || isGoth || isAmethyst || isPastel || isChessAura;
    return (
      <div style={{ position: "relative", width: outer, height: hasCharms ? outer + 44 : outer, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <div style={{ position: "absolute", top: pad, left: pad, right: pad, bottom: hasCharms ? pad + 44 : pad, borderRadius: "50%", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.4)", zIndex: 1 }}>
          {picInner}
        </div>
        {frameSvg && (
          <div style={{ position: "absolute", top: 0, left: 0, width: outer, height: outer, zIndex: 2, pointerEvents: "none", WebkitMaskImage: ringMask, maskImage: ringMask }}>
            {frameSvg}
          </div>
        )}
        {isLolita && lolitaCharmsSVG(size)}
        {isGoth && gothCharmsSVG(size)}
        {isAmethyst && yvonneCharmsSVG(size)}
        {isPastel && pastelCharmsSVG(size)}
        {isChessAura && viiCharmsSVG(size)}
      </div>
    );
  };

  // ── DM MONEY SEND ──
  const sendDmMoney = useCallback(() => {
    const amt = parseInt(dmMoneyAmt);
    if (!amt || amt <= 0 || !dmConvId) { toast("Invalid amount."); return; }
    if (amt > walletBalance) { toast("Insufficient funds."); return; }
    // Resolve recipient — try ACCTS first, then fall back to DM message metadata
    // (new accounts may not be in the ACCTS dictionary yet)
    const recipId = dmConvId;
    const recipFromAccts = (Object.values(ACCTS) as any[]).find((u: any) => u.id === recipId);
    const recipFromLS = (() => { try { const a = { ...JSON.parse(localStorage.getItem("umbra:accts:v1") || "{}"), ...JSON.parse(localStorage.getItem("umbra_custom_accts") || "{}") }; return a[recipId]; } catch { return null; } })();
    const recipName = recipFromAccts?.un
      || recipFromLS?.un
      || dmMessages.find((m: any) => m.fromId === recipId)?.fromUsername
      || dmMessages.find((m: any) => m.toId === recipId)?.toUsername
      || "them";
    deductFromWallet(amt, `DM transfer to ${recipName}${dmMoneyNote.trim() ? ` — ${dmMoneyNote.trim()}` : ""}`, { type: "send", to: recipName });
    const recipCurrentBal = (() => { try { const s = JSON.parse(localStorage.getItem("umbra_wallets") || "{}"); return s[recipId] !== undefined ? s[recipId] : (WALLET_INIT[recipId] ?? 5000); } catch { return 5000; } })();
    saveWalletToLS(recipId, recipCurrentBal + amt);
    const newSenderBal = walletBalance - amt;
    setDmMoneyAmt(""); setDmMoneyNote(""); setDmMoneyMode(false);
    toast(`💎 ₦${amt.toLocaleString()} sent to ${recipName}`);
    const noteMsg = `[💸 TRANSFER] ₦${amt.toLocaleString()}${dmMoneyNote.trim() ? ` — ${dmMoneyNote.trim()}` : ""}`;
    fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: uid, recipientId: recipId, text: noteMsg }),
    }).catch(() => {});
    // Persist wallet changes server-side for cross-device sync
    fetch("/api/wallet/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromId: uid, toId: recipId, amount: amt, fromBalance: newSenderBal }),
    }).then(async (r) => {
      if (r.ok) {
        const data = await r.json();
        // Update recipient's localStorage with confirmed server balance
        saveWalletToLS(recipId, data.toBalance);
      }
    }).catch(() => {});
  }, [dmMoneyAmt, dmMoneyNote, dmConvId, dmMessages, walletBalance, uid, deductFromWallet, saveWalletToLS, toast]);

  // ── GROUP CHAT ──
  const saveGroups = useCallback((g: any[]) => {
    try { localStorage.setItem("umbra_groups", JSON.stringify(g)); } catch {}
  }, []);
  const createGroup = useCallback(() => {
    if (!newGroupName.trim()) { toast("Group needs a name."); return; }
    // Prefer the new chip-picker selections; fall back to the legacy comma string for back-compat.
    const fromPicks = groupMemberPicks.slice();
    const fromLegacy = newGroupMembers.split(",").map(s => s.trim()).filter(Boolean);
    const memberIds = fromPicks.length > 0 ? fromPicks : fromLegacy;
    if (memberIds.length === 0) { toast("Add at least one member."); return; }
    const allIds = [...new Set([uid, ...memberIds])];
    const newGroup = {
      id: `grp_${Date.now()}`,
      name: newGroupName.trim(),
      members: allIds,
      messages: [],
      createdAt: Date.now(),
    };
    const updated = [newGroup, ...groups];
    setGroups(updated);
    saveGroups(updated);
    setActiveGroupId(newGroup.id);
    setNewGroupName(""); setNewGroupMembers(""); setGroupMemberPicks([]); setGroupMemberQuery(""); setShowCreateGroup(false);
    toast(`💬 Group "${newGroup.name}" created with ${allIds.length} members`);
  }, [newGroupName, newGroupMembers, groupMemberPicks, uid, groups, saveGroups, toast]);
  const sendGroupMessage = useCallback(() => {
    if (!groupTxt.trim() || !activeGroupId) return;
    const msg = { id: `gm_${Date.now()}`, uid, un: user.un, pic: user.pic, t: groupTxt.trim(), ts: Date.now() };
    const updated = groups.map((g: any) =>
      g.id === activeGroupId ? { ...g, messages: [...(g.messages || []), msg] } : g
    );
    setGroups(updated);
    saveGroups(updated);
    setGroupTxt("");
  }, [groupTxt, activeGroupId, uid, user, groups, saveGroups]);

  // ── FORUM ──
  const saveForumPosts = useCallback((fp: any[]) => {
    try { localStorage.setItem("umbra_forum", JSON.stringify(fp)); } catch {}
  }, []);
  const postForum = useCallback(() => {
    if (!forumTitle.trim() || !forumBody.trim()) { toast("Fill in title and body."); return; }
    const newPost = {
      id: `fp_${Date.now()}`,
      uid,
      un: user.un,
      pic: user.pic || "🌑",
      cov: user.cov,
      ts: "just now",
      title: forumTitle.trim(),
      body: forumBody.trim(),
      comments: [],
      votes: 1,
    };
    const updated = [newPost, ...forumPosts];
    setForumPosts(updated);
    saveForumPosts(updated);
    setForumTitle(""); setForumBody(""); setForumCompose(false);
    setForumView(newPost.id);
    toast("Posted to forum");
    unlockAchievement("forum_thread","Discourse Leader",{money:500,influence:10,xp:100});
    addInfluence(20);
  }, [forumTitle, forumBody, uid, user, forumPosts, saveForumPosts, toast, unlockAchievement, addInfluence]);
  const replyForum = useCallback((fid: string) => {
    if (!forumTxt.trim()) return;
    const reply = { id: `fc_${Date.now()}`, uid, un: user.un, t: forumTxt.trim(), ts: "just now" };
    const updated = forumPosts.map((fp: any) =>
      fp.id === fid ? { ...fp, comments: [...(fp.comments || []), reply] } : fp
    );
    setForumPosts(updated);
    saveForumPosts(updated);
    setForumTxt("");
  }, [forumTxt, uid, user, forumPosts, saveForumPosts]);
  const voteForum = useCallback((fid: string, delta: number) => {
    const updated = forumPosts.map((fp: any) => fp.id === fid ? { ...fp, votes: (fp.votes || 0) + delta } : fp);
    setForumPosts(updated);
    saveForumPosts(updated);
  }, [forumPosts, saveForumPosts]);

  const findUserByQuery = useCallback((query: string) => {
    const q = query.trim().toLowerCase().replace(/^@/, "");
    if (!q) return null;
    const matcher = (u: any) => {
      const un = (u.un || "").toLowerCase();
      const handle = (u.handle || "").toLowerCase().replace(/^@/, "");
      const id = (u.id || "").toLowerCase();
      return un === q || handle === q || id === q;
    };
    // Search ACCTS (built-in + device-local custom accounts)
    const fromAccts = (Object.values(ACCTS) as any[]).find(matcher);
    if (fromAccts) return fromAccts;
    // Also check the shared and custom localStorage stores for accounts from other devices
    try {
      const shared = JSON.parse(localStorage.getItem("umbra:accts:v1") || "{}");
      const custom = JSON.parse(localStorage.getItem("umbra_custom_accts") || "{}");
      const allExtra = [...Object.values(shared), ...Object.values(custom)];
      return allExtra.find(matcher) || null;
    } catch { return null; }
  }, []);

  const getRecipCurrentBal = useCallback((recipId: string) => {
    try {
      const saved = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
      return saved[recipId] !== undefined ? saved[recipId] : getInitBal(recipId);
    } catch { return getInitBal(recipId); }
  }, []);

  const walletSend = useCallback(() => {
    const amt = parseInt(walletSendAmt);
    if (!amt || amt <= 0) { toast("Invalid amount."); return; }
    if (amt > walletBalance) { toast("Insufficient funds."); return; }
    const recip = findUserByQuery(walletSendTo) as any;
    if (!recip || recip.id === uid) { toast("Recipient not found. Try their display name, @handle, or user ID."); return; }
    deductFromWallet(amt, `Transfer to ${recip.un}${walletSendNote.trim() ? ` — ${walletSendNote.trim()}` : ""}`, { type: "send", to: recip.un });
    saveWalletToLS(recip.id, getRecipCurrentBal(recip.id) + amt);
    setWalletSendTo(""); setWalletSendAmt(""); setWalletSendNote("");
    toast(`💎 ₦${amt.toLocaleString()} transferred to ${recip.un}`);
  }, [walletBalance, walletSendTo, walletSendAmt, walletSendNote, uid, deductFromWallet, saveWalletToLS, findUserByQuery, getRecipCurrentBal, toast]);

  const getItemPrice = useCallback((item: any) => {
    const flash = FLASH_SALES.find(fs => fs.itemId === item.id);
    if (flash) return flash.salePrice;
    const deal = DAILY_DEALS.find(dd => dd.itemId === item.id);
    if (deal) return Math.floor(item.price * (1 - deal.discount / 100));
    return item.price;
  }, []);

  const removeFromCart = useCallback((itemId: string) => {
    setCart(prev => prev.filter((i: any) => i.id !== itemId));
  }, []);

  const updateCartQuantity = useCallback((itemId: string, quantity: number) => {
    if (quantity <= 0) { removeFromCart(itemId); return; }
    setCart(prev => prev.map((i: any) => i.id === itemId ? { ...i, quantity } : i));
  }, [removeFromCart]);

  const addToCart = useCallback((item: any) => {
    if (item.apexOnly && !isApex) { toast("Apex tier required."); return; }
    setCart(prev => {
      const ex = prev.find((i: any) => i.id === item.id);
      if (ex) return prev.map((i: any) => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { ...item, quantity: 1, price: getItemPrice(item) }];
    });
    toast(`${item.icon} ${item.name} added to cart`);
  }, [getItemPrice, isApex, toast]);

  const checkout = useCallback(() => {
    if (cart.length === 0) { toast("Cart is empty"); return; }
    const total = cart.reduce((s: number, i: any) => s + (i.price * i.quantity), 0);
    if (walletBalance < total) { toast(`Insufficient funds. Need ₦${total.toLocaleString()}`); return; }
    const hasAdult = cart.some((i: any) => i.adult);
    if (hasAdult && !isApex) { toast("Apex tier required for Vault items."); return; }
    const newInvItems: any[] = [];
    // Track stock consumed
    const stockUsed: Record<string, number> = {};
    cart.forEach((item: any) => {
      stockUsed[item.id] = (stockUsed[item.id] || 0) + item.quantity;
      for (let i = 0; i < item.quantity; i++) {
        deductFromWallet(item.price, `Purchase: ${item.name}`, { itemId: item.id, name: item.name, quantity: item.quantity });
        newInvItems.push({
          invId: `inv_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
          itemId: item.id,
          name: item.name,
          icon: item.icon,
          desc: item.desc || "",
          price: item.price,
          purchasedAt: new Date().toISOString(),
          type: item.isGift ? "gift" : item.isPet ? "pet" : "item",
          giftTarget: item.giftTarget || null,
          category: item.category || "general",
          relPoints: item.relPoints || null,
        });
      }
    });
    // Persist stock changes
    try {
      const savedStock = JSON.parse(localStorage.getItem("umbra_stock") || "{}");
      Object.entries(stockUsed).forEach(([id, qty]) => {
        savedStock[id] = Math.max(0, (savedStock[id] ?? 999) - (qty as number));
      });
      localStorage.setItem("umbra_stock", JSON.stringify(savedStock));
    } catch {}
    setInventory((prev: any[]) => {
      const next = [...prev, ...newInvItems];
      try { localStorage.setItem(`umbra_inventory_${uid}`, JSON.stringify(next)); } catch {}
      return next;
    });
    setCart([]);
    toast(`✅ Purchase complete! ₦${total.toLocaleString()} spent · ${newInvItems.length} item(s) added to Inventory`);
  }, [cart, walletBalance, isApex, deductFromWallet, toast]);

  const addToWishlist = useCallback((itemId: string) => {
    setWishlist(prev => {
      const next = new Set(prev); next.add(itemId);
      saveWishlistToLS(Array.from(next));
      return next;
    });
    toast("Added to wishlist ❤️");
  }, [saveWishlistToLS, toast]);

  const removeFromWishlist = useCallback((itemId: string) => {
    setWishlist(prev => {
      const next = new Set(prev); next.delete(itemId);
      saveWishlistToLS(Array.from(next));
      return next;
    });
    toast("Removed from wishlist");
  }, [saveWishlistToLS, toast]);

  // ── PORTAL CLAIM ──
  const claimPortalListing = useCallback((listingId: string, price: number, listingName: string) => {
    if (!uid || !user) { toast("You must be logged in."); return; }
    if (portalClaims[listingId]) { toast("Already claimed."); return; }
    if (walletBalance < price) { toast(`Insufficient funds. Need ₦${price.toLocaleString()}`); return; }
    deductFromWallet(price, `Portal claim: ${listingName}`, { type: "portal", listingId });
    setPortalClaims(prev => {
      const next = { ...prev, [listingId]: uid };
      try { localStorage.setItem("umbra_portal_claims", JSON.stringify(next)); } catch {}
      return next;
    });
    toast(`✅ Claimed — ₦${price.toLocaleString()} deducted`);
  }, [uid, user, portalClaims, walletBalance, deductFromWallet, toast]);

  // ── TRENT RELATIONSHIP ──
  const getTrentLevel = useCallback((pts: number) => {
    let lv = TRENT_REL_LEVELS[0];
    for (const l of TRENT_REL_LEVELS) { if (pts >= l.min) lv = l; }
    return lv;
  }, []);

  const addTrentPoints = useCallback((userId: string, pts: number) => {
    setTrentRel(prev => {
      const current = prev[userId] || 0;
      const next = { ...prev, [userId]: current + pts };
      try { localStorage.setItem("umbra_trent_rel", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const getTrentReplyPool = useCallback((pts: number): string[] => {
    const level = getTrentLevel(pts).level;
    if (level >= 5) return TRENT_REPLIES_L5;
    if (level >= 4) return TRENT_REPLIES_L4;
    if (level >= 3) return TRENT_REPLIES_L3;
    if (level >= 2) return TRENT_REPLIES_L2;
    if (level >= 1) return TRENT_REPLIES_L1;
    return TRENT_REPLIES_L0;
  }, [getTrentLevel]);

  // ── CYRUS RELATIONSHIP ── (parallel system to Trent; same shape, different vibe)
  const getCyrusLevel = useCallback((pts: number) => {
    let lv = CYRUS_REL_LEVELS[0];
    for (const l of CYRUS_REL_LEVELS) { if (pts >= l.min) lv = l; }
    return lv;
  }, []);

  const addCyrusPoints = useCallback((userId: string, pts: number) => {
    setCyrusRel(prev => {
      const current = prev[userId] || 0;
      const next = { ...prev, [userId]: current + pts };
      try { localStorage.setItem("umbra_cyrus_rel", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const getCyrusReplyPool = useCallback((pts: number): string[] => {
    const level = getCyrusLevel(pts).level;
    if (level >= 5) return CYRUS_REPLIES_L5;
    if (level >= 4) return CYRUS_REPLIES_L4;
    if (level >= 3) return CYRUS_REPLIES_L3;
    if (level >= 2) return CYRUS_REPLIES_L2;
    if (level >= 1) return CYRUS_REPLIES_L1;
    return CYRUS_REPLIES_L0;
  }, [getCyrusLevel]);

  // Send a gift to Trent from inventory
  const giveGiftToTrent = useCallback(async (invItem: any) => {
    if (!uid || !user) return;
    const giftReplies = TRENT_GIFT_REPLIES[invItem.itemId];
    if (!giftReplies) { toast("Trent doesn't seem to want that."); return; }
    // Remove from inventory
    setInventory(prev => {
      const idx = prev.findIndex((i: any) => i.invId === invItem.invId);
      if (idx === -1) return prev;
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      try { localStorage.setItem(`umbra_inventory_${uid}`, JSON.stringify(next)); } catch {}
      return next;
    });
    // Grant relationship points
    const pts = invItem.relPoints || 30;
    addTrentPoints(uid, pts);
    // Auto DM from Trent — AI-powered
    const trent = ACCTS["trent_morrison"];
    const giftMsg = `🎁 ${invItem.name}`;
    const userMsg = { fromId: uid, fromUsername: user.un, fromPic: user.pic || "🌑", toId: "trent_morrison", toUsername: trent?.un || "Trent Morrison", text: giftMsg };
    try {
      const r = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(userMsg) });
      const { message } = await r.json();
      if (message && dmConvId === "trent_morrison") setDmMessages(p => [...p, message]);
    } catch {}
    setTimeout(async () => {
      try {
        const aiRes = await fetch("/api/ai/npc-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ npcId: "trent_morrison", npcProfile: trent, history: [], userMessage: `${user.un} just sent you a gift: ${invItem.name}. React in character.`, username: user.un, ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}) }),
        });
        const { reply } = await aiRes.json();
        const replyText = reply || giftReplies[Math.floor(Math.random() * giftReplies.length)];
        const autoMsg = { fromId: "trent_morrison", fromUsername: trent?.un || "Trent Morrison", fromPic: trent?.pic || "/trent_pool.webp", toId: uid, toUsername: user.un, text: replyText };
        const r2 = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(autoMsg) });
        const { message: m2 } = await r2.json();
        if (m2 && dmConvId === "trent_morrison") setDmMessages(p => [...p, m2]);
      } catch {
        // fallback to static reply
        const replyText = giftReplies[Math.floor(Math.random() * giftReplies.length)];
        const autoMsg = { fromId: "trent_morrison", fromUsername: trent?.un || "Trent Morrison", fromPic: trent?.pic || "/trent_pool.webp", toId: uid, toUsername: user.un, text: replyText };
        fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(autoMsg) }).then(async r => {
          const { message: m2 } = await r.json();
          if (m2 && dmConvId === "trent_morrison") setDmMessages(p => [...p, m2]);
        }).catch(() => {});
      }
    }, 2000 + Math.random() * 2000);
    const newLvl = getTrentLevel((trentRel[uid] || 0) + pts);
    toast(`🎁 Gift sent! +${pts} relationship points · Level: ${newLvl.name}`);
    // Open DM with Trent
    setDmConvId("trent_morrison");
    setDmOpen(true);
  }, [uid, user, addTrentPoints, trentRel, getTrentLevel, dmConvId, toast]);

  // Send a gift to Cyrus from inventory — parallel to giveGiftToTrent
  const giveGiftToCyrus = useCallback(async (invItem: any) => {
    if (!uid || !user) return;
    const giftReplies = CYRUS_GIFT_REPLIES[invItem.itemId];
    if (!giftReplies) { toast("Cyrus doesn't know what to do with that."); return; }
    setInventory(prev => {
      const idx = prev.findIndex((i: any) => i.invId === invItem.invId);
      if (idx === -1) return prev;
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      try { localStorage.setItem(`umbra_inventory_${uid}`, JSON.stringify(next)); } catch {}
      return next;
    });
    const pts = invItem.relPoints || 30;
    addCyrusPoints(uid, pts);
    const cyrus = ACCTS["cyrus_whitmore"];
    const giftMsg = `🎁 ${invItem.name}`;
    const userMsg = { fromId: uid, fromUsername: user.un, fromPic: user.pic || "🌑", toId: "cyrus_whitmore", toUsername: cyrus?.un || "Cyrus Whitmore", text: giftMsg };
    try {
      const r = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(userMsg) });
      const { message } = await r.json();
      if (message && dmConvId === "cyrus_whitmore") setDmMessages(p => [...p, message]);
    } catch {}
    setTimeout(async () => {
      try {
        const aiRes = await fetch("/api/ai/npc-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ npcId: "cyrus_whitmore", npcProfile: cyrus, history: [], userMessage: `${user.un} just sent you a gift: ${invItem.name}. React in character — you are a sweet, flustered, religious water polo player secretly obsessed with them.`, username: user.un, ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}) }),
        });
        const { reply } = await aiRes.json();
        const replyText = reply || giftReplies[Math.floor(Math.random() * giftReplies.length)];
        const autoMsg = { fromId: "cyrus_whitmore", fromUsername: cyrus?.un || "Cyrus Whitmore", fromPic: cyrus?.pic || "/cyrus.jpeg", toId: uid, toUsername: user.un, text: replyText };
        const r2 = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(autoMsg) });
        const { message: m2 } = await r2.json();
        if (m2 && dmConvId === "cyrus_whitmore") setDmMessages(p => [...p, m2]);
      } catch {
        const replyText = giftReplies[Math.floor(Math.random() * giftReplies.length)];
        const autoMsg = { fromId: "cyrus_whitmore", fromUsername: cyrus?.un || "Cyrus Whitmore", fromPic: cyrus?.pic || "/cyrus.jpeg", toId: uid, toUsername: user.un, text: replyText };
        fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(autoMsg) }).then(async r => {
          const { message: m2 } = await r.json();
          if (m2 && dmConvId === "cyrus_whitmore") setDmMessages(p => [...p, m2]);
        }).catch(() => {});
      }
    }, 2000 + Math.random() * 2000);
    const newLvl = getCyrusLevel((cyrusRel[uid] || 0) + pts);
    toast(`🎁 Gift sent to Cyrus! +${pts} relationship points · Level: ${newLvl.name}`);
    setDmConvId("cyrus_whitmore");
    setDmOpen(true);
  }, [uid, user, addCyrusPoints, cyrusRel, getCyrusLevel, dmConvId, toast]);

  // Dispatcher: route to the right gift handler based on the item's giftTarget.
  // Keeps existing call sites working — they can pass any affinity gift here.
  const giveGiftToAffinity = useCallback((invItem: any) => {
    if (invItem?.giftTarget === "cyrus_whitmore") return giveGiftToCyrus(invItem);
    return giveGiftToTrent(invItem);
  }, [giveGiftToTrent, giveGiftToCyrus]);

  const getItemRating = useCallback((itemId: string) => {
    const r = reviews[itemId] || [];
    if (!r.length) return null;
    return { avg: r.reduce((s: number, x: any) => s + x.rating, 0) / r.length, count: r.length };
  }, [reviews]);

  const addReview = useCallback((itemId: string, itemName: string, rating: number, comment: string) => {
    setReviews(prev => {
      const next = { ...prev, [itemId]: [{ id: `rev_${Date.now()}`, userId: uid, userName: user?.un || "Anonymous", rating, comment, date: new Date().toISOString(), verified: true }, ...(prev[itemId] || [])] };
      saveReviewsToLS(next);
      return next;
    });
    toast(`⭐ Review added for ${itemName}`);
    setRatingModal({ open: false, itemId: null, itemName: "" });
    setRatingValue(5); setRatingComment("");
  }, [uid, user, saveReviewsToLS, toast]);

  const generateReferralCode = useCallback(() => {
    if (referralCode) return referralCode;
    const code = `${user?.un?.replace(/\s/g, "").toUpperCase()}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    setReferralCode(code);
    saveReferralToLS(code, referrals);
    return code;
  }, [user, referralCode, referrals, saveReferralToLS]);

  const claimDailyReward = useCallback(() => {
    if (dailyClaimed) { toast("Already claimed today's reward"); return; }
    const lastDate = lastDailyClaim ? new Date(lastDailyClaim).toDateString() : null;
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    const newStreak = Math.min(lastDate === yesterday ? dailyStreak + 1 : 1, 7);
    const reward = 100 + newStreak * 50 + (newStreak === 7 ? 300 : 0);
    addToWallet(reward, `Daily reward — Day ${newStreak} streak`);
    setDailyClaimed(true); setDailyStreak(newStreak); setLastDailyClaim(new Date());
    saveDailyToLS(true, newStreak, new Date().toISOString());
    toast(`🎯 Daily reward! ₦${reward.toLocaleString()} — Day ${newStreak} streak`);
  }, [dailyClaimed, dailyStreak, lastDailyClaim, addToWallet, saveDailyToLS, toast]);

  useEffect(() => {
    const checkReset = () => {
      const lastDate = lastDailyClaim ? new Date(lastDailyClaim).toDateString() : null;
      if (lastDate !== new Date().toDateString() && dailyClaimed) {
        setDailyClaimed(false);
        saveDailyToLS(false, dailyStreak, lastDailyClaim);
      }
    };
    checkReset();
    const iv = setInterval(checkReset, 60000);
    return () => clearInterval(iv);
  }, [lastDailyClaim, dailyClaimed, dailyStreak, saveDailyToLS]);

  const sendGift = useCallback(() => {
    if (!giftUser.trim()) { toast("Enter a username"); return; }
    const recip = Object.values(ACCTS).find((u: any) => u.un.toLowerCase() === giftUser.toLowerCase());
    if (!recip || (recip as any).id === uid) { toast("User not found"); return; }
    const ok = deductFromWallet(giftModal.price, `Gift: ${giftModal.itemName} to ${(recip as any).un}`, { type: "gift", recipient: (recip as any).un, itemName: giftModal.itemName });
    if (ok) {
      toast(`🎁 Gift sent to ${(recip as any).un}!`);
      setGiftModal({ open: false, itemId: null, itemName: "", price: 0 });
      setGiftUser(""); setGiftMessage("");
    }
  }, [giftUser, giftModal, uid, deductFromWallet, toast]);

  // ── QUIZ (Stage 1: Covenant) ──
  const ansQuiz = useCallback(
    (c) => {
      const na = { ...qAns, [qStep]: c };
      setQAns(na);
      if (qStep >= QUIZ.length - 1) {
        const cnt: Record<string,number> = {};
        Object.values(na).forEach((x: any) => { cnt[x] = (cnt[x] || 0) + 1; });
        const res = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
        setQRes(res);
        setTierStep(0);
        setTierScore(0);
        setRegPhase("tier");
      }
      setQStep((s) => s + 1);
    },
    [qAns, qStep]
  );

  // ── TIER QUIZ (Stage 2: 15 background questions) ──
  const ansTier = useCallback(
    (v: number) => {
      const ns = tierScore + v;
      setTierScore(ns);
      if (tierStep >= TIER_QUIZ.length - 1) {
        // Determine tier from total score (max 45)
        const ts = ns;
        let newTier = "merit";
        if (ts >= 30) newTier = "apex";
        else if (ts >= 15) newTier = "ascendant";
        setApexScore(ts); // reuse apexScore for legacy compat
        setRegPhase("identity");
      } else {
        setTierStep((s) => s + 1);
      }
    },
    [tierScore, tierStep]
  );

  const finishReg = useCallback(async () => {
    if (regSubmitting) return;
    setRegError("");
    if (!newUN.trim() || !newPW.trim()) {
      setRegError("Please fill in your username and password before continuing.");
      return;
    }

    const cov = qRes || "shadows";
    const cv = COV[cov];
    let tier = "merit";
    if (apexScore >= 30) tier = "apex";
    else if (apexScore >= 15) tier = "ascendant";
    const startBal = tierStartBal(tier);
    const wealth = tier === "apex" ? "Old Money" : tier === "ascendant" ? "New Money" : "Scholarship";
    const displayBio = newBio.trim() || `${cv.name} | ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;
    const chosenPic = newPicData.trim() || cv.emoji;
    const cleanUN = newUN.trim().toLowerCase().replace(/\s+/g, "_");
    const profileData = {
      covenant: cov, tier, pic: chosenPic, bio: displayBio,
      major: newMajor || "Undeclared", year: "Freshman", wealth,
      gender: newGender || "prefer_not", pronouns: newPronouns || "",
      quote: newQuote.trim(), academicFocus, personality: personalityTraits,
      canSeeAuction: tier === "apex" || tier === "faculty",
      canSeeRelief: tier === "apex" || tier === "faculty",
    };

    // ═══════════════════════════════════════════════════════════════════════
    // INSTANT-ENTRY (optimistic UI). User clicks → immediately navigates to
    // tags screen with a temporary local uid. Supabase signup runs in the
    // background. When it finishes, we swap the temp id for the real
    // Supabase UUID transparently. By the time the user has finished picking
    // tags (~5-10s), the background signup is virtually always complete.
    // ═══════════════════════════════════════════════════════════════════════
    const tempId = `pending_${cleanUN}_${Date.now()}`;
    const tempAcct: any = {
      id: tempId,
      un: newUN.trim(), handle: `@${cleanUN}`,
      pic: chosenPic, bio: displayBio, cov, tier, wealth,
      followers: 0, following: 0, gaze: 0, rep: "New Arrival",
      defTheme: "dark", canPost: true, canTheme: true,
      badge: `${cv.emoji} ${tier.toUpperCase()}`, bColor: cv.color, cover: cv.emoji,
      major: newMajor || "Undeclared", year: "Freshman",
      gender: newGender || "prefer_not", quote: newQuote.trim(),
      academicFocus, personality: personalityTraits,
      canSeeAuction: tier === "apex" || tier === "faculty",
      canSeeRelief: tier === "apex" || tier === "faculty",
      _real: true, _pending: true,
    };
    ACCTS[tempId] = tempAcct;
    try { const wb = JSON.parse(localStorage.getItem("umbra_wallets") || "{}"); wb[tempId] = startBal; localStorage.setItem("umbra_wallets", JSON.stringify(wb)); } catch {}
    setWalletBalance(startBal);
    setAcctVer(v => v + 1);
    setUid(tempId);
    setThemeId("dark");
    saveSession(tempId, "dark");
    setShowWelcome(true);
    setPendingTags([]);
    setRegError("");
    setScreen("tags");

    // Queue the signup as PENDING — the background drain (see useEffect below)
    // will retry every 20s until it succeeds. This survives network glitches,
    // Supabase rate limits, "Failed to fetch", etc. Once it succeeds, the temp
    // uid is promoted to the real Supabase UUID transparently.
    try {
      const pending: any[] = JSON.parse(localStorage.getItem("umbra_pending_signups") || "[]");
      pending.push({ localId: tempId, username: cleanUN, password: newPW.trim(), profile: profileData, attempts: 0, createdAt: Date.now() });
      localStorage.setItem("umbra_pending_signups", JSON.stringify(pending));
    } catch {}

    // Try once IMMEDIATELY (so most users get cross-device on first try). If
    // this attempt fails, the background drain will keep trying.
    fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: cleanUN, password: newPW.trim(), profile: profileData }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.user?.id) {
          const realId = data.user.id;
          const realAcct: any = { ...tempAcct, id: realId, _pending: false };
          ACCTS[realId] = realAcct;
          delete ACCTS[tempId];
          try {
            const wb = JSON.parse(localStorage.getItem("umbra_wallets") || "{}");
            if (wb[tempId] !== undefined) { wb[realId] = wb[tempId]; delete wb[tempId]; localStorage.setItem("umbra_wallets", JSON.stringify(wb)); }
          } catch {}
          try {
            const myKey = `umbra_my_posts_${tempId}`;
            const backup = JSON.parse(localStorage.getItem(myKey) || "[]");
            if (backup.length) {
              const remapped = backup.map((p: any) => ({ ...p, userId: realId }));
              localStorage.setItem(`umbra_my_posts_${realId}`, JSON.stringify(remapped));
              localStorage.removeItem(myKey);
            }
          } catch {}
          saveRealUser(realAcct);
          try {
            const pwStore = JSON.parse(localStorage.getItem("umbra_pw_store") || "{}");
            pwStore[realId] = newPW.trim();
            localStorage.setItem("umbra_pw_store", JSON.stringify(pwStore));
          } catch {}
          setJWT(data.token);
          setUid(realId);
          saveSession(realId, "dark");
          setAcctVer(v => v + 1);
          // Remove from pending queue
          try {
            const pending: any[] = JSON.parse(localStorage.getItem("umbra_pending_signups") || "[]");
            const next = pending.filter((p: any) => p.localId !== tempId);
            localStorage.setItem("umbra_pending_signups", JSON.stringify(next));
          } catch {}
          console.log(`[signup] ✅ promoted ${tempId} → ${realId}`);
        } else if (res.status === 409 && data.suggestion) {
          // Username collision — drop from queue, prompt user to change
          try {
            const pending: any[] = JSON.parse(localStorage.getItem("umbra_pending_signups") || "[]");
            const next = pending.filter((p: any) => p.localId !== tempId);
            localStorage.setItem("umbra_pending_signups", JSON.stringify(next));
          } catch {}
          toast(`⚠️ Username "${cleanUN}" was taken. Sign out → try "${data.suggestion}" for cross-device.`);
        }
        // Any other error: leave in queue, drain will retry
      })
      .catch((err) => {
        // Network / fetch failure — queue stays, drain will retry every 20s.
        // Log for diagnostics, don't bother the user with a toast.
        console.warn("[signup] first attempt failed (will auto-retry):", err?.message || err);
      });
  }, [qRes, apexScore, newUN, newPW, newMajor, newBio, newQuote, newGender, newPronouns, newPicData, academicFocus, personalityTraits, regSubmitting, saveSession, toast]);

  // ── LOGIN ──
  const doLogin = useCallback(
    async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 1. Check demo/hardcoded accounts first
      const m =
        Object.values(ACCTS).find((u: any) => u.pw && u.id === lid && u.pw === lpw) ||
        Object.values(ACCTS).find(
          (u: any) => u.pw && u.un.toLowerCase() === lid.toLowerCase() && u.pw === lpw
        ) ||
        Object.values(ACCTS).find(
          (u: any) => u.pw && u.handle && u.handle.replace(/^@/, "").toLowerCase() === lid.replace(/^@/, "").toLowerCase() && u.pw === lpw
        );
      if (m) {
        setUid((m as any).id);
        setThemeId((m as any).defTheme || "dark");
        setLerr("");
        setWalletBalance(getInitBal((m as any).id));
        try { const xpd = JSON.parse(localStorage.getItem("umbra_xp") || "{}"); setUserXP(xpd[(m as any).id] ?? 0); } catch {}
        try { const ld = JSON.parse(localStorage.getItem("umbra_lessons") || "{}"); setCompletedLessons(ld[(m as any).id] ?? []); } catch {}
        try { const qd = JSON.parse(localStorage.getItem("umbra_cquiz") || "{}"); setCompletedClassQuizzes(qd[(m as any).id] ?? []); } catch {}
        try { const ed = JSON.parse(localStorage.getItem("umbra_enrolled") || "{}"); setEnrolledClasses(ed[(m as any).id] ?? []); } catch {}
        try { const ad = JSON.parse(localStorage.getItem("umbra_club_act") || "{}"); setClubActivitiesDone(ad[(m as any).id] ?? []); } catch {}
        saveSession((m as any).id, (m as any).defTheme || "dark");
        setScreen("app");
        // Sync wallet from server — only if no local value exists (new device).
        // localStorage is always current; don't overwrite recent earnings with a stale server value.
        const _mid = (m as any).id;
        fetch(`/api/wallet/${_mid}`).then(async (r) => {
          if (r.ok) { const { balance } = await r.json(); if (balance !== null && balance !== undefined) {
            const localBal = (() => { try { const w = JSON.parse(localStorage.getItem("umbra_wallets") || "{}"); return w[_mid]; } catch { return undefined; } })();
            if (localBal === undefined || localBal === null) { saveWalletToLS(_mid, balance); setWalletBalance(balance); }
          }}
        }).catch(() => {});
        // Sync NPC profile data to server (upsert) so pics/bio are visible cross-device
        (() => {
          try {
            const lsAcct = (() => { try { return { ...JSON.parse(localStorage.getItem("umbra:accts:v1") || "{}")[_mid], ...JSON.parse(localStorage.getItem("umbra_custom_accts") || "{}")[_mid] }; } catch { return {}; } })();
            const ma = m as any;
            const payload: Record<string, any> = { userId: _mid };
            const pic = lsAcct?.pic || ma.pic;
            if (pic && !pic.match(/^[\p{Emoji}]/u)) payload.pic = pic; // only push real image URLs, not emojis
            if (ma.bio) payload.bio = ma.bio;
            if (ma.cov) payload.covenant = ma.cov;
            if (ma.tier) payload.tier = ma.tier;
            if (ma.major) payload.major = ma.major;
            if (ma.year) payload.year = ma.year;
            if (ma.wealth) payload.wealth = ma.wealth;
            if (ma.rep) payload.rep = ma.rep;
            if (Object.keys(payload).length > 1) {
              fetch("/api/auth/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
            }
          } catch {}
        })();
        return;
      }
      // 2. Try real API login
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: lid.trim(), password: lpw.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setLerr(data.error || "Invalid credentials.");
          return;
        }
        setJWT(data.token);
        const p = data.user?.profile || {};
        // Profile comes back with camelCase mappings from the server (cov→covenant etc.)
        const acct = buildRealUser({
          ...data.user,
          covenant: (p.covenant || p.cov) as string | undefined,
          tier: p.tier as string | undefined,
          pic: p.pic as string | undefined,
          bio: p.bio as string | undefined,
        });
        if (p.major) (acct as any).major = p.major;
        if (p.year) (acct as any).year = p.year;
        if (p.wealth) (acct as any).wealth = p.wealth;
        if (p.rep) (acct as any).rep = p.rep;
        // canSeeAuction / canSeeRelief — accept both camelCase and snake_case
        const csa = p.canSeeAuction ?? p.can_see_auction;
        const csr = p.canSeeRelief ?? p.can_see_relief;
        if (csa !== undefined) (acct as any).canSeeAuction = csa;
        if (csr !== undefined) (acct as any).canSeeRelief = csr;
        if (typeof p.trentMemory === "string" && p.trentMemory.trim()) setTrentMemory(p.trentMemory);
        else if (typeof p.trent_memory === "string" && p.trent_memory.trim()) setTrentMemory(p.trent_memory);
        // Restore XP from Supabase (cross-device) — also save to localStorage so it persists locally
        if (typeof p.xp === "number" && p.xp > 0) {
          setUserXP(p.xp);
          saveXPToLS(data.user.id, p.xp);
        }
        saveRealUser(acct);
        setUid(acct.id);
        setThemeId("dark");
        setLerr("");
        setWalletBalance(getInitBal(acct.id));
        saveSession(acct.id, "dark");
        setScreen("app");
      } catch {
        setLerr("Connection error. Please try again.");
      }
    },
    [lid, lpw, saveSession]
  );

  // ── FEED ──
  const react = useCallback(
    (pid, e) => {
      fetch(`/api/posts/${pid}/react`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: e }),
      }).catch(() => {});
      setPosts((prev) => {
        const n = prev.map((p) =>
          p.id !== pid ? p : { ...p, r: { ...p.r, [e]: (p.r[e] || 0) + 1 } }
        );
        pushPosts(n);
        return n;
      });
    },
    [pushPosts]
  );
  const addC = useCallback(
    (pid) => {
      if (!cTxt.trim() || !user) return;
      const commentId = `nc${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      // Always persist comment to shared API
      fetch(`/api/posts/${pid}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: commentId,
          userId: user.id,
          username: user.un,
          text: cTxt.trim(),
        }),
      }).catch(() => {});
      setPosts((prev) => {
        const n = prev.map((p) =>
          p.id !== pid
            ? p
            : {
                ...p,
                c: [
                  ...p.c,
                  {
                    id: commentId,
                    uid: user.id,
                    un: user.un,
                    t: cTxt.trim(),
                  },
                ],
              }
        );
        pushPosts(n);
        return n;
      });
      setCTxt("");
    },
    [cTxt, user, pushPosts]
  );
  const doPost = useCallback(() => {
    if (!pTxt.trim() || !user?.canPost) return;
    const postId = `p${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const isKet = uid === "ket_white";
    const ct = 3 + Math.floor(Math.random() * 3);
    const autoC = Array.from({ length: ct }, (_, i) => ({
      id: `ac${Date.now()}${i}`,
      un: AUTO_UN[Math.floor(Math.random() * AUTO_UN.length)],
      t: AUTO_C[Math.floor(Math.random() * AUTO_C.length)],
    }));
    const autoLikes = isKet ? 35 + Math.floor(Math.random() * 50) : 2 + Math.floor(Math.random() * 12);
    const autoSkulls = Math.floor(Math.random() * 8);
    const autoFlames = Math.floor(Math.random() * 10);
    // Bulletproof backup: stash a copy of every post the user creates into a
    // user-scoped localStorage key. This is the last line of defence — even if
    // the Supabase insert fails silently and the main posts cache is cleared,
    // these posts will be re-merged into the feed on the next refresh.
    const backupPost = {
      id: postId,
      userId: uid,
      username: user.un,
      content: pTxt.trim(),
      image: pImg.trim() || null,
      pic: user.pic || "🌑",
      covenant: user.cov || "silk",
      tier: user.tier || "commoner",
      likes: autoLikes,
      skulls: autoSkulls,
      flames: autoFlames,
      isNpc: false,
      createdAt: new Date().toISOString(),
    };
    try {
      const key = `umbra_my_posts_${uid}`;
      const existing = JSON.parse(localStorage.getItem(key) || "[]");
      existing.push(backupPost);
      // Cap at 500 of the user's own posts so localStorage doesn't grow forever.
      localStorage.setItem(key, JSON.stringify(existing.slice(-500)));
    } catch {}
    fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: postId,
        userId: uid,
        username: user.un,
        content: pTxt.trim(),
        pic: user.pic || "🌑",
        covenant: user.cov || "silk",
        tier: user.tier || "commoner",
        image: pImg.trim() || null,
        likes: autoLikes,
        skulls: autoSkulls,
        flames: autoFlames,
        autoComments: autoC.map((c) => ({ id: c.id, userId: "auto", username: c.un, text: c.t })),
      }),
    }).catch((err) => { console.warn("[doPost] Supabase insert failed (backup saved):", err); });
    const np = {
      id: postId,
      uid,
      type: pImg.trim() ? "image" : "text",
      content: pTxt.trim(),
      image: pImg.trim() || null,
      ts: "Just now",
      _createdAt: Date.now(),
      r: {
        "❤️": autoLikes,
        "💀": autoSkulls,
        "🔥": autoFlames,
        ...(isKet ? { "🦋": 20 + Math.floor(Math.random() * 30), "✨": 25 + Math.floor(Math.random() * 25), "🌹": 15 + Math.floor(Math.random() * 20) } : {}),
      },
      c: autoC,
      apexOnly: false,
    };
    setPosts((prev) => {
      const n = [np, ...prev];
      pushPosts(n);
      return n;
    });
    const capturedPostId = postId;
    const capturedContent = pTxt.trim();
    const capturedAuthor = user.un;
    // NPC AI comments — staggered delays so they appear naturally over time.
    // Pool excludes real users (we don't want signed-up players ghost-writing comments).
    const npcPool = (Object.values(ACCTS) as any[]).filter(
      (n: any) => n.personality && n.id !== uid && !n.isGuest && !n._real && !n.isReal && n.un
    );
    const shuffled = [...npcPool].sort(() => Math.random() - 0.5);
    const commenters = shuffled.slice(0, 2 + Math.floor(Math.random() * 3)); // 2-4 commenters
    commenters.forEach((npc, idx) => {
      // Faster delays so users actually see them: 4-12s first, 4-9s between subsequent commenters.
      const delay = (4 + Math.random() * 8) * 1000 + idx * (4000 + Math.random() * 5000);
      setTimeout(async () => {
        try {
          const aiRes = await fetch("/api/ai/npc-comment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              npcs: [npc],
              postContent: capturedContent,
              postAuthor: capturedAuthor,
              // Forward the user's API key so the comment uses their engine.
              ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}),
            }),
          });
          const { comments } = await aiRes.json();
          const c = comments?.[0];
          if (c?.text) {
            await fetch(`/api/posts/${capturedPostId}/comments`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId: npc.id, username: npc.un, text: c.text }),
            });
            setPosts(prev => prev.map((p: any) =>
              p.id !== capturedPostId ? p :
              { ...p, c: [...(p.c || []), { id: `npc_c_${Date.now()}_${idx}`, uid: npc.id, un: npc.un, t: c.text }] }
            ));
          }
        } catch (err) { console.error("[npc-comment]", err); }
      }, delay);
    });
    setPTxt("");
    setPImg("");
    setCompose(false);
    toast("Posted ✨");
    unlockAchievement("first_post","First Voice",{money:500,influence:5,xp:100});
    addInfluence(10);
  }, [pTxt, pImg, user, uid, toast, pushPosts, unlockAchievement, addInfluence]);
  const delPost = useCallback(
    (id) => {
      fetch(`/api/posts/${id}`, { method: "DELETE" }).catch(() => {});
      setPosts((prev) => {
        const n = prev.filter((p) => p.id !== id);
        pushPosts(n);
        return n;
      });
      setMenuPost(null);
      toast("Deleted.");
    },
    [toast, pushPosts]
  );
  const delC = useCallback(
    (pid: string, cid: string) => {
      setPosts((prev) => {
        const n = prev.map((p: any) =>
          p.id !== pid ? p : { ...p, c: (p.c || []).filter((c: any) => c.id !== cid) }
        );
        pushPosts(n);
        return n;
      });
      // Also delete from DB so it doesn't come back on next fetch
      fetch(`/api/posts/${pid}/comments/${cid}`, { method: "DELETE" }).catch(() => {});
      // Track in localStorage as a hard delete so it's filtered even if API resync happens before DB propagates
      try {
        const key = "umbra_deleted_comments";
        const existing = JSON.parse(localStorage.getItem(key) || "[]");
        if (!existing.includes(cid)) {
          existing.push(cid);
          localStorage.setItem(key, JSON.stringify(existing));
        }
      } catch {}
    },
    [pushPosts]
  );

  const [followerCounts, setFollowerCounts] = useState<Record<string,number>>(() => {
    const m: Record<string,number> = {};
    Object.values(ACCTS).forEach((u: any) => { m[u.id] = u.followers || 0; });
    return m;
  });

  const toggleFollow = useCallback((id: string) => {
    const wasFollowing = follows.has(id);
    const delta = wasFollowing ? -1 : 1;
    setFollows((prev) => {
      const n = new Set(prev);
      wasFollowing ? n.delete(id) : n.add(id);
      try { localStorage.setItem("umbra_follows", JSON.stringify([...n])); } catch {}
      return n;
    });
    setFollowerCounts((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + delta) }));
    setMyFollowingDelta((d) => d + delta);
  }, [follows]);

  // Keep ref in sync with state so loadDms can read it without a stale closure
  useEffect(() => { dmConvIdRef.current = dmConvId; }, [dmConvId]);

  // Auto-scroll to newest message when conversation opens or new message arrives
  useEffect(() => {
    if (!dmConvId) return;
    setTimeout(() => msgBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
  }, [dmMessages.length, dmConvId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDms = useCallback((silent = false) => {
    if (!uid) return;
    fetch(`/api/messages/${uid}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(({ messages }) => {
        if (!Array.isArray(messages)) return;
        if (!silent) { setDmMessages(messages); return; }
        setDmMessages((prev) => {
          const prevIds = new Set(prev.map((m: any) => m.id));
          // Count ALL new messages (own + others) to detect changes
          const newMsgs = messages.filter((m: any) => !prevIds.has(m.id));
          if (newMsgs.length === 0) return prev; // no new messages — skip re-render
          // Auto-mark-seen if the conversation sending the new message is currently open
          const openConv = dmConvIdRef.current;
          // Only toast for messages from OTHER people (not self)
          const newFromOthers = newMsgs.filter((m: any) => m.fromId !== uid);
          const visibleNew = newFromOthers.filter((m: any) => m.fromId !== openConv);
          if (visibleNew.length > 0) {
            const senderName = visibleNew[0]?.fromUsername || "Someone";
            toast(`✉ New message from ${senderName}`);
          }
          if (openConv) {
            // Mark the open conversation as seen immediately so no unread dot appears
            setDmLastSeen(prev2 => {
              const now = new Date().toISOString();
              const next = { ...prev2, [openConv]: now };
              try { localStorage.setItem("umbra_dm_seen", JSON.stringify(next)); } catch {}
              return next;
            });
          }
          return messages;
        });
      })
      .catch(() => {});
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (nav === "messages") loadDms();
  }, [nav, loadDms]);

  // Load DMs on startup as soon as uid is known — nav defaults to "feed" on refresh
  // so the nav-based effect above won't fire; this ensures messages are never empty after reload
  useEffect(() => {
    if (uid) loadDms();
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload messages whenever the user opens a specific DM thread
  // (ensures Trent's reply is visible even if the user navigated away mid-generation)
  useEffect(() => {
    if (dmConvId) loadDms();
  }, [dmConvId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Batch-fetch server profiles for all DM conversation partners so their current
  // pic shows in the thread list without needing to visit each profile individually.
  useEffect(() => {
    if (!uid || dmMessages.length === 0) return;
    const partners = new Set<string>();
    for (const m of dmMessages) {
      if (m.fromId !== uid) partners.add(m.fromId);
      if (m.toId !== uid) partners.add(m.toId);
    }
    for (const pid of partners) {
      if (profileFetchTriedRef.current.has(pid)) continue;
      const acct = ACCTS[pid] as any;
      if (acct && Array.isArray(acct.traits) && acct.traits.length > 0) {
        profileFetchTriedRef.current.add(pid);
        continue;
      }
      // Only track in-flight to prevent duplicate concurrent requests; mark tried only on success
      if ((profileFetchTriedRef as any)._inflight?.has(pid)) continue;
      if (!(profileFetchTriedRef as any)._inflight) (profileFetchTriedRef as any)._inflight = new Set();
      (profileFetchTriedRef as any)._inflight.add(pid);
      fetch(`/api/auth/profile/${pid}`)
        .then(r => r.ok ? r.json() : Promise.resolve(null))
        .then(data => {
          (profileFetchTriedRef as any)._inflight?.delete(pid);
          if (!data?.profile) return; // 404 — allow retry next time
          profileFetchTriedRef.current.add(pid); // success — don't re-fetch this session
          if (Array.isArray(data.profile.traits) && data.profile.traits.length > 0) {
            setServerProfileTraits(prev => ({ ...prev, [pid]: data.profile.traits }));
          }
          if (data.profile.pic) {
            setServerProfilePics(prev => ({ ...prev, [pid]: data.profile.pic }));
            if (ACCTS[pid]) (ACCTS[pid] as any).pic = data.profile.pic;
          }
          if (!ACCTS[pid]) {
            const cov = data.profile.covenant || "shadows";
            const cv = COV[cov] || { emoji: "🌑", color: "#888", name: "Unknown" };
            ACCTS[pid] = {
              id: pid, un: data.username || pid, handle: `@${data.username || pid}`,
              cov, tier: data.profile.tier || "merit", pic: data.profile.pic || cv.emoji,
              bio: data.profile.bio || "", followers: data.profile.followers || 0, following: data.profile.following || 0, gaze: 0,
              major: data.profile.major || "Undeclared", year: data.profile.year || "Freshman",
              wealth: data.profile.wealth || "Self-Made", rep: data.profile.rep || "",
              badge: `${cv.emoji} ${(data.profile.tier || "merit").toUpperCase()}`,
              bColor: cv.color, cover: cv.emoji, isReal: true, canPost: true, canTheme: true,
            } as any;
          } else {
            const a = ACCTS[pid] as any;
            if (data.profile.covenant) a.cov = data.profile.covenant;
            if (data.profile.tier) a.tier = data.profile.tier;
            if (data.profile.major) a.major = data.profile.major;
            if (data.profile.year) a.year = data.profile.year;
            if (data.profile.wealth) a.wealth = data.profile.wealth;
            if (data.profile.rep) a.rep = data.profile.rep;
          }
          // Note: no setAcctVer here — avoid per-partner re-renders; profile view fetch handles its own refresh
        })
        .catch(() => {});
    }
  }, [uid, dmMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear stuck "typing" indicator when mobile brings the page back to foreground
  // or after a max wait time — prevents permanently stuck typing bubbles
  useEffect(() => {
    const dmTypingMaxTimer = { id: 0 as any };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Page came back — clear any stuck typing state after a short grace period
        clearTimeout(dmTypingMaxTimer.id);
        dmTypingMaxTimer.id = setTimeout(() => setDmTyping(false), 3000);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(dmTypingMaxTimer.id);
    };
  }, []);

  // Safety: clear dmTyping if it has been stuck for more than 90s
  // (90s covers the retry window: ~30s attempt + 16s wait + ~30s retry)
  useEffect(() => {
    if (!dmTyping) return;
    const t = setTimeout(() => setDmTyping(false), 90000);
    return () => clearTimeout(t);
  }, [dmTyping]);

  useEffect(() => {
    if (!uid) return;
    const iv = setInterval(() => loadDms(true), 10 * 60 * 1000); // 10 min (was 2 min)
    return () => clearInterval(iv);
  }, [uid, loadDms]);

  // ── WORSHIP DM — high-rep users receive adoring DMs from fan NPCs ─────────
  useEffect(() => {
    if (!uid || !user) return;
    const triggerWorshipDm = async () => {
      try {
        const myRep = (() => { try { return JSON.parse(localStorage.getItem("umbra_influence")||"{}")[uid] ?? 0; } catch { return 0; } })();
        if (myRep < 2000) return; // Not famous enough yet
        const lastWorshipKey = `umbra_last_worship:${uid}`;
        const lastTs = parseInt(localStorage.getItem(lastWorshipKey) || "0", 10);
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        if (Date.now() - lastTs < TWO_HOURS) return; // Throttle: max 1 worship DM per 2 hours
        const res = await fetch("/api/ai/worship-dm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: uid, targetUsername: (user as any)?.un || uid, targetRep: myRep }),
        });
        if (res.ok) {
          const data = await res.json();
          if (!data.skipped) {
            localStorage.setItem(lastWorshipKey, String(Date.now()));
            setTimeout(() => loadDms(true), 2000); // Pull the new DM into state
          }
        }
      } catch {}
    };
    // First trigger: 90s after login (feel organic, not instant)
    const t = setTimeout(triggerWorshipDm, 90000);
    // Recurring: check every 2.5 hours — throttle inside keeps it to 1 per 2h max
    const iv2 = setInterval(triggerWorshipDm, 2.5 * 60 * 60 * 1000);
    return () => { clearTimeout(t); clearInterval(iv2); };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Trent proactive auto-text ─────────────────────────────────────────────
  // Use refs for frequently-changing values so this effect only runs once per session
  const trentRelRef = useRef(trentRel);
  useEffect(() => { trentRelRef.current = trentRel; }, [trentRel]);
  const getTrentLevelRef = useRef(getTrentLevel);
  useEffect(() => { getTrentLevelRef.current = getTrentLevel; }, [getTrentLevel]);

  useEffect(() => {
    if (!uid || !user) return;
    const trent = ACCTS["trent_morrison"];
    if (!trent?.autoReply) return;

    const sendProactive = async () => {
      const relPts = trentRelRef.current[uid] || 0;
      const level = getTrentLevelRef.current(relPts).level;
      if (level < 2) return;

      const lastKey = `umbra_trent_proactive_${uid}`;
      const lastMs = parseInt(localStorage.getItem(lastKey) || "0");
      const sinceMin = (Date.now() - lastMs) / 60000;
      const minGap = level >= 6 ? 60 : level >= 4 ? 150 : 300;
      if (sinceMin < minGap) return;

      localStorage.setItem(lastKey, String(Date.now()));

      const triggerPool =
        level >= 6
          ? [
              `You've been thinking about ${user.un} all day and it's starting to piss you off.`,
              `You almost texted ${user.un} three times today and deleted it each time.`,
              `Something reminded you of ${user.un} during practice and you lost focus. Drew noticed.`,
            ]
          : level >= 4
          ? [
              `You noticed ${user.un} hasn't messaged and you hate that you noticed.`,
              `${user.un} keeps showing up in your head. You're annoyed about it.`,
            ]
          : [
              `You thought of something you want to say to ${user.un}.`,
              `Something happened today that reminded you of ${user.un}.`,
            ];
      const trigger = triggerPool[Math.floor(Math.random() * triggerPool.length)];

      try {
        const aiRes = await fetch("/api/ai/npc-initiate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ npcId: "trent_morrison", npcProfile: trent, targetUsername: user.un, trigger, relLevel: level, ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}) }),
        });
        const { message: msgText } = await aiRes.json();
        if (!msgText) return;
        const payload = { fromId: "trent_morrison", fromUsername: trent.un, fromPic: trent.pic || "/trent_pool.webp", toId: uid, toUsername: user.un, text: msgText };
        const r = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const { message } = await r.json();
        if (message) {
          setDmMessages((p) => {
            const ids = new Set(p.map((x: any) => x.id));
            return ids.has(message.id) ? p : [...p, message];
          });
          toast(`💬 Trent: "${msgText.slice(0, 45)}${msgText.length > 45 ? "…" : ""}"`);
        }
      } catch {}
    };

    const t = setTimeout(sendProactive, 10000);
    const iv = setInterval(sendProactive, 30 * 60 * 1000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [uid, user]); // stable deps only — trentRel read via ref inside sendProactive

  const sendDm = useCallback(async () => {
    if (!dmTxt.trim() || !dmConvId || !uid || !user || dmSending) return;
    setDmSending(true);
    // Safety: even if everything below hangs or throws, the button can never
    // stay locked for more than 8 seconds. The actual reply path keeps running
    // in the background but the user can send their next message immediately.
    const safetyReset = setTimeout(() => setDmSending(false), 8000);
    const convUser = ACCTS[dmConvId];
    // Prefer known display name; fall back to name stored in existing messages
    const convName = convUser?.un
      || dmMessages.find((m: any) => m.fromId === dmConvId)?.fromUsername
      || dmMessages.find((m: any) => m.toId === dmConvId)?.toUsername
      || dmConvId;
    const userMsg = dmTxt.trim();
    const capturedConvId = dmConvId; // freeze for async closures
    const payload = { fromId: uid, fromUsername: user.un, fromPic: user.pic || "🌑", toId: capturedConvId, toUsername: convName, text: userMsg };
    // Optimistic local insert so the message shows IMMEDIATELY in the chat,
    // regardless of how slow / broken the server is.
    const optimisticMsg = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      fromId: uid, fromUsername: user.un, fromPic: user.pic || "🌑",
      toId: capturedConvId, toUsername: convName, text: userMsg,
      createdAt: new Date().toISOString(),
      _optimistic: true,
    };
    setDmMessages((p) => [...p, optimisticMsg]);
    setDmTxt("");

    // Fire the user-message POST in the background — don't await it. The AI
    // reply path below runs IMMEDIATELY and in parallel, so even if /api/messages
    // is slow or fails, the NPC still responds.
    fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(async (r) => {
        try {
          const { message } = await r.json();
          if (message) {
            setDmMessages((p) => {
              const filtered = p.filter((m: any) => m.id !== optimisticMsg.id);
              const ids = new Set(filtered.map((x: any) => x.id));
              return ids.has(message.id) ? filtered : [...filtered, message];
            });
          }
        } catch {}
      })
      .catch((err) => console.warn("[sendDm] message POST failed (kept optimistic):", err));

    try {
      // AI reply fires regardless of message-POST status. NPC must always reply.
      if (convUser && (convUser.autoReply || convUser.personality) && !convUser._real && !convUser.isReal) {
        if (capturedConvId === "trent_morrison") addTrentPoints(uid, 1);
        if (capturedConvId === "cyrus_whitmore") addCyrusPoints(uid, 1);
        // Filter history to THIS conversation only (fixes memory bug), sorted oldest-first
        const recentHistory = dmMessages
          .filter((m: any) => m.fromId === capturedConvId || m.toId === capturedConvId)
          .slice(-14);
        const relLevel = capturedConvId === "trent_morrison" ? getTrentLevel(trentRel[uid] || 0).level
                       : capturedConvId === "cyrus_whitmore" ? getCyrusLevel(cyrusRel[uid] || 0).level
                       : 0;
        const capturedMemory = capturedConvId === "trent_morrison" ? trentMemory : "";
        setDmTyping(true);
        const abortCtrl = new AbortController();
        const timeoutId = setTimeout(() => abortCtrl.abort(), 90000); // 90s max
        fetch("/api/ai/npc-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ npcId: capturedConvId, npcProfile: convUser, history: recentHistory, userMessage: userMsg, username: user.un, relLevel, trentMemory: capturedMemory, ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}) }),
          signal: abortCtrl.signal,
        })
          .then(r2 => r2.json())
          .then(async ({ reply: rawReply }) => {
            clearTimeout(timeoutId);
            const reply = rawReply || (capturedConvId === "trent_morrison"
              ? (getTrentReplyPool(trentRel[uid] || 0)[Math.floor(Math.random() * 5)] || ".")
              : capturedConvId === "cyrus_whitmore"
              ? (getCyrusReplyPool(cyrusRel[uid] || 0)[Math.floor(Math.random() * 5)] || "...")
              : "...");
            // OPTIMISTIC — show the NPC reply IMMEDIATELY. The /api/messages
            // POST runs in the background; user doesn't wait for it.
            const optimisticReply = {
              id: `local_npc_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
              fromId: capturedConvId, fromUsername: convUser.un, fromPic: convUser.pic || "🌑",
              toId: uid, toUsername: user.un, text: reply,
              createdAt: new Date().toISOString(),
              _optimistic: true,
            };
            setDmMessages((p) => [...p, optimisticReply]);
            // Background save — replace optimistic with server-saved entry when it returns
            const autoPayload = { fromId: capturedConvId, fromUsername: convUser.un, fromPic: convUser.pic || "🌑", toId: uid, toUsername: user.un, text: reply };
            fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(autoPayload) })
              .then(async (ar) => {
                try {
                  const { message: autoMsg } = await ar.json();
                  if (autoMsg) setDmMessages((p) => {
                    const filtered = p.filter((m: any) => m.id !== optimisticReply.id);
                    const ids = new Set(filtered.map((x: any) => x.id));
                    return ids.has(autoMsg.id) ? filtered : [...filtered, autoMsg];
                  });
                } catch {}
              })
              .catch((err) => console.warn("[sendDm] reply save failed (kept optimistic):", err));
            // Fire-and-forget: update Trent's long-term memory after each exchange
            if (capturedConvId === "trent_morrison" && uid) {
              const lastExchange = [
                { fromId: uid, text: userMsg },
                { fromId: "trent_morrison", text: reply },
              ];
              fetch("/api/ai/npc-memory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: uid, username: user.un, existingMemory: capturedMemory, lastExchange }),
              })
                .then(mr => mr.json())
                .then(({ memory }) => { if (memory) setTrentMemory(memory); })
                .catch(() => {});
            }
          })
          .catch(async (err) => {
            clearTimeout(timeoutId);
            // Fallback: save a short static reply so the conversation doesn't silently die
            if (capturedConvId === "trent_morrison") {
              const fallbacks = [".", "don't.", "not now.", "later.", "what.", "busy."];
              const fb = fallbacks[Math.floor(Math.random() * fallbacks.length)];
              const fbPayload = { fromId: capturedConvId, fromUsername: convUser.un, fromPic: convUser.pic || "🌑", toId: uid, toUsername: user.un, text: fb };
              const fr = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fbPayload) }).catch(() => null);
              if (fr?.ok) {
                const { message: fbMsg } = await fr.json().catch(() => ({}));
                if (fbMsg) setDmMessages((p) => { const ids = new Set(p.map((x: any) => x.id)); return ids.has(fbMsg.id) ? p : [...p, fbMsg]; });
              }
            }
          })
          .finally(() => setDmTyping(false));
      }
    } catch (err) {
      console.warn("[sendDm] message POST failed:", err);
    } finally {
      // GUARANTEED — button never stuck. Also clear the safety timer.
      clearTimeout(safetyReset);
      setDmSending(false);
    }
  }, [dmTxt, dmConvId, uid, user, dmSending, dmMessages, addTrentPoints, addCyrusPoints, getTrentLevel, getCyrusLevel, trentRel, cyrusRel, trentMemory]);

  // Top-level professor DM send — used from the DM tab when dmConvId is a professor
  const sendProfTabDM = useCallback(async () => {
    if (!profDMInput.trim() || !dmConvId) return;
    const p = PROFS.find((pr: any) => pr.id === dmConvId);
    if (!p) return;
    const msg = profDMInput.trim();
    setProfDMInput("");
    setProfDMLoading(true);
    const currentHistory = profDMHistory[dmConvId] || [];
    setProfDMHistory(prev => ({ ...prev, [dmConvId]: [...currentHistory, { role: "user", content: msg }] }));
    try {
      const res = await fetch("/api/ai/prof-dm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profName: p.name,
          profProfile: p,
          archetype: p.archetype || "clinical",
          personality: p.bio || p.name,
          dms: p.dms || [],
          studentName: (user as any)?.un || "Student",
          studentTier: (user as any)?.tier || "merit",
          studentCov: (user as any)?.cov || "shadows",
          favScore: p.favorability ?? 0,
          history: currentHistory,
          message: msg,
          ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}),
        }),
      });
      const data = await res.json();
      const reply = data.reply && data.reply.trim() ? data.reply.trim() : `Your message has been received, ${(user as any)?.un || "student"}.`;
      setProfDMHistory(prev => ({ ...prev, [dmConvId]: [...(prev[dmConvId] || []), { role: "assistant", content: reply }] }));
    } catch {
      setProfDMHistory(prev => ({ ...prev, [dmConvId]: [...(prev[dmConvId] || []), { role: "assistant", content: "I'm currently unavailable. Please visit during office hours." }] }));
    } finally { setProfDMLoading(false); }
  }, [profDMInput, dmConvId, user, profDMHistory]);

  const compressImage = (file: File, maxPx = 900, quality = 0.78): Promise<string> =>
    new Promise((resolve, reject) => {
      const MAX_BYTES = 512000; // hard 500 KB ceiling
      const reader = new FileReader();
      reader.onload = (ev) => {
        const src = ev.target?.result as string;
        if (!src) return reject(new Error("read failed"));
        const img = new Image();
        img.onload = () => {
          let scale = Math.min(1, maxPx / Math.max(img.width, img.height));
          let q = quality;
          const encode = (): string => {
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
            return canvas.toDataURL("image/jpeg", q);
          };
          let dataUrl = encode();
          // base64 string length * 0.75 ≈ byte size
          while (dataUrl.length * 0.75 > MAX_BYTES && q > 0.15) {
            q = Math.max(0.15, q - 0.1);
            dataUrl = encode();
          }
          // If still over, shrink pixel dimensions
          while (dataUrl.length * 0.75 > MAX_BYTES && scale > 0.15) {
            scale *= 0.75;
            dataUrl = encode();
          }
          resolve(dataUrl);
        };
        img.onerror = reject;
        img.src = src;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const sendDmPic = useCallback(async (file: File) => {
    if (!dmConvId || !uid || !user) return;
    let imageUrl: string;
    try {
      imageUrl = await compressImage(file);
    } catch { return; }
    const convUser = ACCTS[dmConvId];
    const convName = convUser?.un
      || dmMessages.find((m: any) => m.fromId === dmConvId)?.fromUsername
      || dmMessages.find((m: any) => m.toId === dmConvId)?.toUsername
      || dmConvId;
    const capturedConvId = dmConvId;
    const payload = { fromId: uid, fromUsername: user.un, fromPic: user.pic || "🌑", toId: capturedConvId, toUsername: convName, text: "📷 Photo", imageUrl };
    try {
      const r = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) { toast("Failed to send image."); return; }
      const { message } = await r.json();
      if (message) setDmMessages((p) => [...p, { ...message, imageUrl }]);
      if (convUser && (convUser.autoReply || convUser.personality) && !convUser._real && !convUser.isReal) {
        if (capturedConvId === "trent_morrison") addTrentPoints(uid, 1);
        if (capturedConvId === "cyrus_whitmore") addCyrusPoints(uid, 1);
        const recentHistory = dmMessages
          .filter((m: any) => m.fromId === capturedConvId || m.toId === capturedConvId)
          .slice(-14);
        const relLevel = capturedConvId === "trent_morrison" ? getTrentLevel(trentRel[uid] || 0).level
                       : capturedConvId === "cyrus_whitmore" ? getCyrusLevel(cyrusRel[uid] || 0).level
                       : 0;
        const capturedMemory = capturedConvId === "trent_morrison" ? trentMemory : "";
        setDmTyping(true);
        // Tell the AI explicitly that a photo was sent so it reacts in character.
        // The user's chatStyle + the "they sent you a photo" instruction makes
        // Cyrus stutter / Trent get terse without action-narration.
        const picUserMsg = `[The user just sent you a photo of themself. React to receiving it — keep it as a text message, no action narration.]`;
        fetch("/api/ai/npc-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ npcId: capturedConvId, npcProfile: convUser, history: recentHistory, userMessage: picUserMsg, username: user.un, relLevel, trentMemory: capturedMemory, ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}) }),
        })
          .then(r2 => r2.json())
          .then(async ({ reply: rawReply2 }) => {
            const reply = rawReply2 || (capturedConvId === "trent_morrison"
              ? TRENT_PIC_REPLIES[Math.floor(Math.random() * TRENT_PIC_REPLIES.length)] || "."
              : capturedConvId === "cyrus_whitmore"
              ? CYRUS_PIC_REPLIES[Math.floor(Math.random() * CYRUS_PIC_REPLIES.length)] || "..."
              : "...");
            const autoPayload = { fromId: capturedConvId, fromUsername: convUser.un, fromPic: convUser.pic || "🌑", toId: uid, toUsername: user.un, text: reply };
            const ar = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(autoPayload) });
            const { message: autoMsg } = await ar.json();
            if (autoMsg) setDmMessages((p) => {
              const ids = new Set(p.map((x: any) => x.id));
              return ids.has(autoMsg.id) ? p : [...p, autoMsg];
            });
            // Fire-and-forget: update Trent's long-term memory after photo exchange
            if (capturedConvId === "trent_morrison" && uid) {
              fetch("/api/ai/npc-memory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: uid, username: user.un, existingMemory: capturedMemory, lastExchange: [{ fromId: uid, text: "📷 [sent a photo]" }, { fromId: "trent_morrison", text: reply }] }),
              })
                .then(mr => mr.json())
                .then(({ memory }) => { if (memory) setTrentMemory(memory); })
                .catch(() => {});
            }
          })
          .catch(() => {})
          .finally(() => setDmTyping(false));
      }
    } catch { toast("Failed to send image."); }
  }, [dmConvId, uid, user, dmMessages, addTrentPoints, getTrentLevel, trentRel, trentMemory]);

  const placeBid = useCallback((lotId?: string, amount?: number, lotName?: string) => {
    const v = amount ?? parseInt(bidInput);
    const lName = lotName ?? "Lot #7";
    if (!v || v <= liveBid) {
      toast("Bid must exceed current bid.");
      return false;
    }
    if (walletBalance < v) {
      toast(`Insufficient funds. Need ₦${v.toLocaleString()}`);
      return false;
    }
    deductFromWallet(v, `Bid on ${lName} (held)`, { type: "bid_hold", lotId: lotId || "L07", lotName: lName, amount: v });
    const record = {
      lot: lName,
      lotId: lotId || "L07",
      amount: v,
      time: new Date().toLocaleTimeString(),
      status: "active",
    };
    setMyBids((prev) => [record, ...prev]);
    const newCount = liveBidCount + 1;
    setLiveBid(v);
    setLiveBidCount(newCount);
    setBidInput("");
    pushBids(v, newCount);
    fetch("/api/bids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: uid || "anon", username: user?.un || "Anonymous", amount: v, lotId: lotId || "L07", lotName: lName }),
    }).catch(() => {});
    toast(`Bid ₦${v.toLocaleString()} placed on ${lName} 💎`);
    return true;
  }, [bidInput, liveBid, liveBidCount, walletBalance, uid, user, deductFromWallet, toast, pushBids]);

  const logout = useCallback(() => {
    setUid(null);
    setScreen("landing");
    setNav("feed");
    setLid("");
    setLpw("");
    setQStep(0);
    setQAns({});
    setQRes(null);
    setRegPhase("quiz");
    setApexScore(0);
    setTierStep(0);
    setTierScore(0);
    setNewUN("");
    setNewPW("");
    setNewPWConfirm("");
    setNewGender("");
    setNewBio("");
    setNewQuote("");
    setAcademicFocus([]);
    setPersonalityTraits([]);
    setNewMajor("");
    setNewPicData("");
    setAvatarMode("preset");
    setAiPrompt("");
    try {
      localStorage.removeItem("umbra_session");
    } catch (e) {}
  }, []);

  // ═══════════════════════════════════════════════════════
  // STYLE HELPERS
  // ═══════════════════════════════════════════════════════
  const card = {
    background: T.card,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
  };
  const hdr = {
    background: T.hdr,
    borderBottom: `1px solid ${T.border}`,
    padding: "13px 16px",
    position: "sticky",
    top: 0,
    zIndex: 60,
  };
  const inp = {
    background: T.inp,
    border: `1px solid ${T.border}`,
    color: T.text,
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 14,
    width: "100%",
    fontFamily: "inherit",
  };
  const sec = { maxWidth: 600, margin: "0 auto", padding: "0 12px 92px" };
  const lbl = {
    fontFamily: "'Cinzel',serif",
    fontSize: 10,
    color: T.muted,
    letterSpacing: "0.12em",
  };
  const ttl = (sz = 14) => ({
    fontFamily: "'Cinzel',serif",
    fontSize: sz,
    color: T.primary,
    letterSpacing: "0.1em",
  });
  const sub = {
    fontFamily: "'IM Fell English',serif",
    fontStyle: "italic",
    color: T.muted,
    fontSize: 13,
  };
  const pill = (a) => ({
    padding: "5px 12px",
    borderRadius: 20,
    fontSize: 12,
    border: `1px solid ${a ? T.primary : T.border}`,
    background: a ? `${T.primary}20` : T.pill,
    color: a ? T.primary : T.muted,
    cursor: "pointer",
  });
  const bdg = (c) => ({
    fontSize: 9,
    padding: "2px 7px",
    borderRadius: 3,
    border: `1px solid ${c || T.border}`,
    color: c || T.muted,
    letterSpacing: "0.06em",
  });
  const btn = (pr) => ({
    padding: "9px 18px",
    background: pr
      ? `linear-gradient(135deg,${T.sec},${T.primary})`
      : "transparent",
    border: `1px solid ${pr ? T.primary : T.border}`,
    color: pr ? "#fff" : T.muted,
    borderRadius: 6,
    fontSize: 13,
    letterSpacing: "0.06em",
    fontFamily: "'Cinzel',serif",
    cursor: "pointer",
  });
  const navBtn = (a) => ({
    background: "none",
    border: "none",
    color: a ? T.primary : T.muted,
    fontSize: 18,
    padding: "5px 4px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    flex: 1,
  });
  const navLbl = (a) => ({
    fontSize: 8,
    letterSpacing: "0.04em",
    fontFamily: "'Cinzel',serif",
    color: a ? T.primary : T.muted,
  });
  const divider = { height: "1px", background: T.border, margin: "10px 0" };
  const EMOJIS = [
    "❤️",
    "💀",
    "😈",
    "⛓️",
    "😂",
    "💎",
    "🔥",
    "👑",
    "⚔️",
    "🦋",
    "✨",
    "🌹",
    "🕯️",
    "👁️",
    "🌑",
  ];

  // ═══════════════════════════════════════════════════════
  // LANDING
  // ═══════════════════════════════════════════════════════
  if (screen === "landing")
    return (
      <div
        style={{
          minHeight: "100vh",
          background: TH.dark.bg,
          color: TH.dark.text,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          fontFamily: "'Cormorant Garamond',Georgia,serif",
        }}
      >
        <div className="fu" style={{ textAlign: "center", maxWidth: 440 }}>
          <div className="flt" style={{ fontSize: 64, marginBottom: 16 }}>
            🌑
          </div>
          <h1
            style={{
              fontFamily: "'Cinzel',serif",
              fontSize: 52,
              fontWeight: 700,
              color: "#d4af37",
              letterSpacing: "0.18em",
              textShadow: "0 0 40px rgba(212,175,55,.35)",
              marginBottom: 6,
            }}
          >
            UMBRA
          </h1>
          <p style={{ ...sub, fontSize: 16, marginBottom: 4 }}>
            Noctis University Social Network
          </p>
          <p style={{ ...lbl, marginBottom: 40, lineHeight: 2.5 }}>
            EST. 1847 · WHAT HAPPENS AT NOCTIS STAYS AT NOCTIS
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              alignItems: "center",
            }}
          >
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setScreen("quiz");
              }}
              style={{
                ...btn(true),
                width: 260,
                padding: "14px 24px",
                fontSize: 13,
              }}
            >
              ENTER AS NEW INITIATE
            </button>
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setScreen("login");
              }}
              style={{
                ...btn(false),
                width: 260,
                padding: "14px 24px",
                fontSize: 13,
              }}
            >
              RETURNING STUDENT
            </button>
            <div
              style={{
                width: 260,
                height: "1px",
                background: "rgba(212,175,55,.15)",
                margin: "4px 0",
              }}
            />
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const guestId = "guest_lurker";
                if (!ACCTS[guestId]) {
                  ACCTS[guestId] = {
                    id: guestId,
                    un: "Lurker",
                    handle: "@lurker",
                    pw: "",
                    cov: "shadows",
                    tier: "guest",
                    pic: "👁️",
                    bio: "Watching.",
                    followers: 0,
                    following: 0,
                    gaze: 0,
                    defTheme: "dark",
                    canPost: false,
                    canTheme: false,
                    badge: "👁️ GUEST",
                    bColor: "#5a5a5a",
                    cover: "🌑",
                    isGuest: true,
                  };
                }
                setUid(guestId);
                setThemeId("dark");
                setScreen("app");
              }}
              style={{
                ...btn(false),
                width: 260,
                padding: "11px 24px",
                fontSize: 12,
                color: "#6a6a6a",
                border: "1px solid #3a3020",
              }}
            >
              👁️ LURK WITHOUT SIGNING IN
            </button>
          </div>
          <p style={{ ...lbl, marginTop: 40, lineHeight: 2.2, fontSize: 10 }}>
            By entering, you acknowledge the Omertà Protocol.
            <br />
            What you witness here never leaves.
          </p>
        </div>
      </div>
    );

  // ═══════════════════════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════════════════════
  if (screen === "login")
    return (
      <div
        style={{
          minHeight: "100vh",
          background: TH.dark.bg,
          color: TH.dark.text,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          fontFamily: "'Cormorant Garamond',Georgia,serif",
        }}
      >
        <div className="fu" style={{ width: "100%", maxWidth: 380 }}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setScreen("landing");
            }}
            style={{
              background: "none",
              border: "none",
              color: TH.dark.muted,
              fontSize: 13,
              marginBottom: 24,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ← Back
          </button>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🗝️</div>
            <h2 style={{ ...ttl(20), marginBottom: 4 }}>RESTRICTED ACCESS</h2>
            <p style={{ ...sub, fontSize: 12, color: TH.dark.muted }}>
              Legacy credentials required
            </p>
          </div>
          <form
            onSubmit={doLogin}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <input
              style={inp}
              placeholder="Username or ID"
              value={lid}
              onChange={(e) => setLid(e.target.value)}
            />
            <input
              style={inp}
              type="password"
              placeholder="Password"
              value={lpw}
              onChange={(e) => setLpw(e.target.value)}
            />
            {lerr && (
              <p
                style={{ color: "#cc4444", fontSize: 13, textAlign: "center" }}
              >
                {lerr}
              </p>
            )}
            <button
              type="submit"
              className="b"
              onClick={doLogin}
              style={{ ...btn(true), padding: "13px", marginTop: 4 }}
            >
              ENTER
            </button>
          </form>
          <div
            style={{
              marginTop: 20,
              padding: 14,
              background: TH.dark.card,
              border: `1px solid ${TH.dark.border}`,
              borderRadius: 8,
            }}
          >
            <p style={{ ...lbl, marginBottom: 8 }}>SPECIAL ACCOUNTS</p>
            {[
              ["pet_001", "collar001", "Pet"],
              ["relief_001", "unit007", "Relief"],
            ].map(([u, p, role]) => (
              <div
                key={u}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "3px 0",
                  borderBottom: `1px solid ${TH.dark.border}`,
                }}
              >
                <span style={{ fontSize: 11, color: TH.dark.muted }}>
                  {u} / {p}
                </span>
                <span style={{ fontSize: 10, color: TH.dark.muted }}>
                  {role}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  // ═══════════════════════════════════════════════════════
  // QUIZ / REGISTRATION
  // ═══════════════════════════════════════════════════════
  if (screen === "quiz") {
    const done = qStep >= QUIZ.length;
    const cv = COV[qRes];
    return (
      <div
        style={{
          minHeight: "100vh",
          background: TH.dark.bg,
          color: TH.dark.text,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          fontFamily: "'Cormorant Garamond',Georgia,serif",
        }}
      >
        <div className="fu" style={{ width: "100%", maxWidth: 420 }}>
          {!done && (
            <>
              <p style={{ ...lbl, textAlign: "center", marginBottom: 8 }}>
                {qStep + 1} of {QUIZ.length} · COVENANT ASSESSMENT
              </p>
              <div
                style={{
                  height: 2,
                  background: "#2a2010",
                  borderRadius: 1,
                  marginBottom: 24,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(qStep / QUIZ.length) * 100}%`,
                    height: "100%",
                    background: `linear-gradient(90deg,#8b7355,#d4af37)`,
                    transition: "width .4s",
                  }}
                />
              </div>
              <h3
                style={{
                  fontFamily: "'IM Fell English',serif",
                  fontStyle: "italic",
                  fontSize: 22,
                  color: "#e8dcc4",
                  textAlign: "center",
                  marginBottom: 22,
                  lineHeight: 1.5,
                }}
              >
                {QUIZ[qStep].q}
              </h3>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {QUIZ[qStep].opts.map((o, i) => (
                  <button
                    key={i}
                    type="button"
                    className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      ansQuiz(o.c);
                    }}
                    style={{
                      padding: "13px 20px",
                      background: "#1a1409",
                      border: "1px solid #362e1e",
                      color: "#c8b890",
                      fontSize: 15,
                      fontFamily: "'IM Fell English',serif",
                      fontStyle: "italic",
                      borderRadius: 6,
                      textAlign: "left",
                    }}
                  >
                    {o.t}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ─── STAGE 2: TIER ASSESSMENT (15 questions) ─── */}
          {regPhase === "tier" && (
            <>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <p style={{ fontSize: 10, color: "#6a5840", letterSpacing: "0.1em", fontFamily: "'Cinzel',serif" }}>WHO YOU ARE</p>
                  <p style={{ fontSize: 10, color: "#6a5840" }}>Question {tierStep + 1} of {TIER_QUIZ.length}</p>
                </div>
                <div style={{ height: 3, background: "#1a1409", borderRadius: 2 }}>
                  <div style={{ height: "100%", width: `${((tierStep + 1) / TIER_QUIZ.length) * 100}%`, background: "#d4af37", borderRadius: 2, transition: "width 0.3s ease" }} />
                </div>
                <p style={{ fontSize: 11, color: "#5a4830", marginTop: 4, fontStyle: "italic", fontFamily: "'IM Fell English',serif" }}>These questions help us understand your path at Noctis.</p>
              </div>
              <h3 style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", fontSize: 19, color: "#e8dcc4", textAlign: "center", marginBottom: 20, lineHeight: 1.4 }}>
                {TIER_QUIZ[tierStep].q}
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {TIER_QUIZ[tierStep].opts.map((o, i) => (
                  <button key={i} type="button" className="b"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); ansTier(o.v); }}
                    style={{ padding: "13px 20px", background: "#1a1409", border: "1px solid #362e1e", color: "#c8b890", fontSize: 14, fontFamily: "'IM Fell English',serif", fontStyle: "italic", borderRadius: 6, textAlign: "left" }}>
                    {o.t}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ─── STAGE 3: IDENTITY — Claim Your Name ─── */}
            {regPhase === "identity" && cv && (
              <>
                <div style={{ textAlign: "center", marginBottom: 18 }}>
                  <div style={{ fontSize: 42, marginBottom: 8 }}>{cv.emoji}</div>
                  <p style={{ fontFamily: "'Cinzel',serif", fontSize: 10, letterSpacing: "0.15em", color: "#6a5840" }}>CLAIM YOUR NAME</p>
                  <p style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", color: "#9a8868", fontSize: 13, marginTop: 4 }}>{cv.name} · {apexScore >= 30 ? "APEX 👑" : apexScore >= 15 ? "ASCENDANT ✦" : "MERIT"}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <p style={{ ...lbl, marginBottom: 6 }}>CHOOSE YOUR NAME</p>
                    <input value={newUN} onChange={(e) => setNewUN(e.target.value)}
                      placeholder="e.g. Lysander Vane"
                      style={{ ...inp, borderColor: unStatus === "taken" || unStatus === "invalid" ? "#a04040" : unStatus === "available" ? "#4d8a4d" : (inp as any).borderColor || "#362e1e" }} />
                    {unStatus === "checking" && (
                      <p style={{ fontSize: 11, color: "#9a8868", marginTop: 6, fontFamily: "'Cormorant Garamond',serif", fontStyle: "italic" }}>Checking availability…</p>
                    )}
                    {unStatus === "available" && (
                      <p style={{ fontSize: 11, color: "#7ac47a", marginTop: 6, fontFamily: "'Cormorant Garamond',serif" }}>✓ This name is available.</p>
                    )}
                    {unStatus === "taken" && (
                      <p style={{ fontSize: 11, color: "#e87878", marginTop: 6, fontFamily: "'Cormorant Garamond',serif" }}>
                        ✗ Already claimed.{" "}
                        {unSuggestion && (
                          <button type="button" onClick={() => setNewUN(unSuggestion)}
                            style={{ background: "none", border: "none", color: "#d4af37", textDecoration: "underline", cursor: "pointer", fontFamily: "inherit", fontSize: 11, padding: 0 }}>
                            Try {unSuggestion}?
                          </button>
                        )}
                      </p>
                    )}
                    {unStatus === "tooshort" && (
                      <p style={{ fontSize: 11, color: "#9a8868", marginTop: 6, fontFamily: "'Cormorant Garamond',serif", fontStyle: "italic" }}>Name must be at least 2 characters.</p>
                    )}
                    {unStatus === "invalid" && (
                      <p style={{ fontSize: 11, color: "#e87878", marginTop: 6, fontFamily: "'Cormorant Garamond',serif" }}>Only letters, numbers, spaces, dots, dashes and underscores allowed.</p>
                    )}
                  </div>
                  <div>
                    <p style={{ ...lbl, marginBottom: 6 }}>SET PASSWORD</p>
                    <input type="password" value={newPW} onChange={(e) => setNewPW(e.target.value)}
                      placeholder="Keep it secret, keep it safe"
                      style={{ ...inp, borderColor: newPW && newPW.length < 6 ? "#a04040" : (inp as any).borderColor || "#362e1e" }} />
                    {newPW && newPW.length < 6 && (
                      <p style={{ fontSize: 11, color: "#e87878", marginTop: 6, fontFamily: "'Cormorant Garamond',serif" }}>Password must be at least 6 characters.</p>
                    )}
                  </div>
                  <div>
                    <p style={{ ...lbl, marginBottom: 6 }}>CONFIRM PASSWORD</p>
                    <input type="password" value={newPWConfirm} onChange={(e) => setNewPWConfirm(e.target.value)}
                      placeholder="Repeat your password"
                      style={{ ...inp, borderColor: newPWConfirm && newPWConfirm !== newPW ? "#a04040" : newPWConfirm && newPWConfirm === newPW ? "#4d8a4d" : (inp as any).borderColor || "#362e1e" }} />
                    {newPWConfirm && newPWConfirm !== newPW && (
                      <p style={{ fontSize: 11, color: "#e87878", marginTop: 6, fontFamily: "'Cormorant Garamond',serif" }}>Passwords don't match.</p>
                    )}
                    {newPWConfirm && newPWConfirm === newPW && newPW.length >= 6 && (
                      <p style={{ fontSize: 11, color: "#7ac47a", marginTop: 6, fontFamily: "'Cormorant Garamond',serif" }}>✓ Passwords match.</p>
                    )}
                  </div>
                  <div>
                    <p style={{ ...lbl, marginBottom: 8 }}>GENDER</p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                      {[["male","♂ Male"],["female","♀ Female"],["non_binary","⚧ Non-binary"],["prefer_not","Private"],["other","Other"]].map(([val,label]) => (
                        <button key={val} type="button" className="b"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setNewGender(val); }}
                          style={{ padding: "9px 6px", background: newGender === val ? "rgba(212,175,55,.15)" : "#1a1409", border: `1px solid ${newGender === val ? "#d4af37" : "#362e1e"}`, color: newGender === val ? "#d4af37" : "#9a8868", fontSize: 12, fontFamily: "'Cinzel',serif", borderRadius: 6 }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p style={{ ...lbl, marginBottom: 8 }}>PRONOUNS <span style={{ fontSize:10, opacity:0.6 }}>(optional)</span></p>
                    <div style={{ display: "flex", flexWrap:"wrap" as const, gap: 6, marginBottom: 6 }}>
                      {[["she/her","she/her"],["he/him","he/him"],["they/them","they/them"],["she/they","she/they"],["he/they","he/they"],["any","any/all"],["private","private"]].map(([val,label]) => (
                        <button key={val} type="button" className="b"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setNewPronouns(newPronouns === val ? "" : val); }}
                          style={{ padding: "7px 12px", background: newPronouns === val ? "rgba(212,175,55,.15)" : "#1a1409", border: `1px solid ${newPronouns === val ? "#d4af37" : "#362e1e"}`, color: newPronouns === val ? "#d4af37" : "#9a8868", fontSize: 11, fontFamily: "'Cinzel',serif", borderRadius: 20, cursor:"pointer" }}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <input
                      value={newPronouns}
                      onChange={e => setNewPronouns(e.target.value)}
                      placeholder="or type custom pronouns…"
                      style={{ ...inp, fontSize:12 }}
                    />
                  </div>
                                    {/* ─── AVATAR PICKER ─── */}
                    <div>
                      <p style={{ ...lbl, marginBottom: 8 }}>YOUR AVATAR</p>
                      {/* Currently selected */}
                      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                        {newPicData ? (
                          (newPicData.startsWith("http") || newPicData.startsWith("data:")) ? (
                            <img src={newPicData} alt="avatar" style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", border: "2px solid #d4af37" }} />
                          ) : (
                            <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#1a1409", border: "2px solid #d4af37", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>{newPicData}</div>
                          )
                        ) : (
                          <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#1a1409", border: "2px dashed #362e1e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#6a5840", fontFamily: "'Cinzel',serif" }}>NONE</div>
                        )}
                      </div>
                      {/* Mode tabs */}
                      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                        {(["preset","ai","upload"] as const).map((m) => (
                          <button key={m} type="button" className="b"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAvatarMode(m); }}
                            style={{ flex: 1, padding: "7px", background: avatarMode === m ? "rgba(212,175,55,.15)" : "#0d0a05", border: `1px solid ${avatarMode === m ? "#d4af37" : "#362e1e"}`, color: avatarMode === m ? "#d4af37" : "#7a6840", fontSize: 10, fontFamily: "'Cinzel',serif", borderRadius: 4 }}>
                            {m === "preset" ? "PRESET" : m === "ai" ? "✨ AI" : "📁 UPLOAD"}
                          </button>
                        ))}
                      </div>
                      {/* Preset emoji grid */}
                      {avatarMode === "preset" && (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
                          {["🎭","🌙","⚔️","🦋","🌹","🕯️","🦉","🐦‍⬛","🌿","🪶","💀","🦅","🌑","🐺","🦊","🐉","🌸","🌊","⭐","🔮","🧿","🪷","🫀","🌺","🦁","🐦","🌙","🍂","🕊️","🎆"].map((e: string) => (
                            <button key={e} type="button" className="b"
                              onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); setNewPicData(e); }}
                              style={{ padding: "8px 4px", background: newPicData === e ? "rgba(212,175,55,.15)" : "#0d0a05", border: `1px solid ${newPicData === e ? "#d4af37" : "#1e1a10"}`, borderRadius: 6, fontSize: 22, cursor: "pointer" }}>
                              {e}
                            </button>
                          ))}
                        </div>
                      )}
                      {/* AI generate */}
                      {avatarMode === "ai" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
                            placeholder="dark academia portrait, candlelight, moody…"
                            style={{ ...inp, fontSize: 13 }} />
                          <button type="button" className="b"
                            onClick={async (e) => {
                              e.preventDefault(); e.stopPropagation();
                              if (!aiPrompt.trim() || aiGenLoading) return;
                              setAiGenLoading(true);
                              try {
                                const promptText = `dark academia portrait noctis university student ${aiPrompt.trim()} oil painting dramatic lighting high quality`;
                                const encoded = encodeURIComponent(promptText);
                                const url = `https://image.pollinations.ai/prompt/${encoded}?width=512&height=512&nologo=true&seed=${Date.now()}`;
                                // Load as image to verify it works, then set URL directly
                                await new Promise<void>((resolve, reject) => {
                                  const img = new Image();
                                  img.crossOrigin = "anonymous";
                                  img.onload = () => { setNewPicData(url); resolve(); };
                                  img.onerror = () => reject(new Error("Image load failed"));
                                  img.src = url;
                                });
                              } catch { setAiPrompt(""); } finally { setAiGenLoading(false); }
                            }}
                            style={{ ...btn(!aiGenLoading && !!aiPrompt.trim()), padding: "10px" }}>
                            {aiGenLoading ? "✨ Generating..." : "✨ GENERATE PORTRAIT"}
                          </button>
                        </div>
                      )}
                      {/* Upload from device */}
                      {avatarMode === "upload" && (
                        <div>
                          <label style={{ display: "block", padding: "12px", background: "#0d0a05", border: "1px dashed #362e1e", borderRadius: 6, textAlign: "center", cursor: "pointer" }}>
                            <input type="file" accept="image/*" style={{ display: "none" }}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const reader = new FileReader();
                                reader.onload = (ev) => setNewPicData(ev.target?.result as string);
                                reader.readAsDataURL(file);
                              }} />
                            <p style={{ fontSize: 12, color: "#7a6840", fontFamily: "'Cinzel',serif" }}>TAP TO CHOOSE IMAGE</p>
                            <p style={{ fontSize: 10, color: "#4a3820", marginTop: 4 }}>From your photo library or files</p>
                          </label>
                        </div>
                      )}
                    </div>
                    <div style={{ padding: "10px 12px", background: "rgba(212,175,55,.06)", border: "1px solid rgba(212,175,55,.2)", borderRadius: 6 }}>
                    <p style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", color: "#7a6840", fontSize: 11 }}>
                      ✦ All new students begin as 1st Year — Freshman. Your standing rises with your deeds.
                    </p>
                  </div>
                  <button type="button" className="b"
                    onClick={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      if (!newUN.trim()) { return; }
                      if (!newPW.trim()) { return; }
                      if (newPW !== newPWConfirm) { return; }
                      setRegPhase("academic");
                    }}
                    style={{ ...btn(!!(newUN.trim() && newPW.trim() && newPW === newPWConfirm)), padding: "13px", marginTop: 4 }}>
                    CONTINUE →
                  </button>
                  {newPW && newPWConfirm && newPW !== newPWConfirm && (
                    <p style={{ fontSize: 11, color: "#c04040", textAlign: "center" }}>Passwords do not match</p>
                  )}
                </div>
              </>
            )}

            {/* ─── STAGE 4: ACADEMIC ─── */}
            {regPhase === "academic" && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <p style={{ fontFamily: "'Cinzel',serif", fontSize: 10, letterSpacing: "0.15em", color: "#6a5840", marginBottom: 4 }}>YOUR STUDIES</p>
                  <p style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", color: "#7a6840", fontSize: 12 }}>Choose your discipline and area of focus.</p>
                </div>
                <div>
                  <p style={{ ...lbl, marginBottom: 8 }}>MAJOR</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                    {MAJORS_LIST.map((m) => (
                      <button key={m.name} type="button" className="b"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setNewMajor(m.name); }}
                        style={{ padding: "10px 14px", background: newMajor === m.name ? "rgba(212,175,55,.12)" : "#1a1409", border: `1px solid ${newMajor === m.name ? "#d4af37" : "#362e1e"}`, color: newMajor === m.name ? "#d4af37" : "#9a8868", borderRadius: 6, textAlign: "left" }}>
                        <span style={{ fontFamily: "'Cinzel',serif", fontSize: 13, display: "block" }}>{m.name}</span>
                        <span style={{ fontSize: 10, color: newMajor === m.name ? "#a89060" : "#6a5840" }}>{m.degree} · {m.duration}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  <p style={{ ...lbl, marginBottom: 8 }}>ACADEMIC FOCUS <span style={{ color: "#5a4830", fontWeight: 400 }}>(choose 2)</span></p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {["Theory","Research","Practical","Creative","Critical","Leadership","Social","Technical"].map((f) => {
                      const sel = academicFocus.includes(f);
                      const disabled = !sel && academicFocus.length >= 2;
                      return (
                        <button key={f} type="button" className="b"
                          onClick={(e) => {
                            e.preventDefault(); e.stopPropagation();
                            if (disabled) return;
                            setAcademicFocus(prev => sel ? prev.filter(x => x !== f) : [...prev, f]);
                          }}
                          style={{ padding: "7px 12px", background: sel ? "rgba(212,175,55,.12)" : "#1a1409", border: `1px solid ${sel ? "#d4af37" : "#362e1e"}`, color: sel ? "#d4af37" : disabled ? "#4a3820" : "#9a8868", fontSize: 12, fontFamily: "'Cinzel',serif", borderRadius: 4, opacity: disabled ? 0.5 : 1 }}>
                          {f}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button type="button" className="b"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRegPhase("bio"); }}
                  style={{ ...btn(true), padding: "13px", marginTop: 16 }}>
                  CONTINUE →
                </button>
              </>
            )}

            {/* ─── STAGE 5: BIO & PERSONALITY ─── */}
            {regPhase === "bio" && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <p style={{ fontFamily: "'Cinzel',serif", fontSize: 10, letterSpacing: "0.15em", color: "#6a5840", marginBottom: 4 }}>YOUR STORY</p>
                  <p style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", color: "#7a6840", fontSize: 12 }}>Leave an impression on Noctis.</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <p style={{ ...lbl, marginBottom: 6 }}>BIO <span style={{ color: "#5a4830", fontWeight: 400, fontSize: 10 }}>(optional)</span></p>
                    <textarea value={newBio} onChange={(e) => setNewBio(e.target.value)}
                      placeholder="Tell Noctis who you are..."
                      rows={3}
                      style={{ ...inp, resize: "none", fontFamily: "'IM Fell English',serif", fontStyle: "italic", lineHeight: 1.5 }} />
                  </div>
                  <div>
                    <p style={{ ...lbl, marginBottom: 6 }}>SIGNATURE QUOTE <span style={{ color: "#5a4830", fontWeight: 400, fontSize: 10 }}>(optional)</span></p>
                    <input value={newQuote} onChange={(e) => setNewQuote(e.target.value)}
                      placeholder='"Those who walk in shadow, see the stars more clearly."'
                      style={{ ...inp, fontFamily: "'IM Fell English',serif", fontStyle: "italic" }} />
                  </div>
                  <div>
                    <p style={{ ...lbl, marginBottom: 8 }}>PERSONALITY TRAITS <span style={{ color: "#5a4830", fontWeight: 400 }}>(choose up to 3)</span></p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {["Ambitious","Mysterious","Charming","Ruthless","Scholarly","Rebellious","Graceful","Cunning","Loyal","Eccentric","Stoic","Dramatic"].map((trait) => {
                        const sel = personalityTraits.includes(trait);
                        const disabled = !sel && personalityTraits.length >= 3;
                        return (
                          <button key={trait} type="button" className="b"
                            onClick={(e) => {
                              e.preventDefault(); e.stopPropagation();
                              if (disabled) return;
                              setPersonalityTraits(prev => sel ? prev.filter(x => x !== trait) : [...prev, trait]);
                            }}
                            style={{ padding: "7px 12px", background: sel ? "rgba(139,90,43,.25)" : "#1a1409", border: `1px solid ${sel ? "#a06030" : "#362e1e"}`, color: sel ? "#d4a060" : disabled ? "#4a3820" : "#9a8868", fontSize: 12, fontFamily: "'Cinzel',serif", borderRadius: 4, opacity: disabled ? 0.5 : 1 }}>
                            {trait}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <button type="button" className="b"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRegPhase("confirm"); }}
                    style={{ ...btn(true), padding: "13px", marginTop: 4 }}>
                    CONTINUE →
                  </button>
                </div>
              </>
            )}

            {/* ─── STAGE 6: CONFIRMATION ─── */}
            {regPhase === "confirm" && cv && (
              <div className="fu">
                <div style={{ textAlign: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 44, marginBottom: 8 }}>{cv.emoji}</div>
                  <h2 style={{ fontFamily: "'Cinzel',serif", fontSize: 18, color: "#d4af37", letterSpacing: "0.1em", marginBottom: 4 }}>{cv.name.toUpperCase()}</h2>
                  <p style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", color: "#9a8868", fontSize: 13 }}>{cv.desc}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                  {[
                    ["Name", newUN.trim() || "—"],
                    ["Tier", apexScore >= 30 ? "APEX 👑" : apexScore >= 15 ? "ASCENDANT ✦" : "MERIT"],
                    ["Major", newMajor || "Undeclared"],
                    ["Year", "1st Year — Freshman"],
                    ["Starting Balance", apexScore >= 30 ? "₦500,000" : apexScore >= 15 ? "₦100,000" : "₦25,000"],
                    ...(personalityTraits.length > 0 ? [["Traits", personalityTraits.join(" · ")]] : []),
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#0d0a05", border: "1px solid #1e1a10", borderRadius: 4 }}>
                      <span style={{ fontSize: 10, color: "#6a5840", letterSpacing: "0.1em", fontFamily: "'Cinzel',serif" }}>{k}</span>
                      <span style={{ fontSize: 13, color: "#c8b890", fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>{v}</span>
                    </div>
                  ))}
                  {newBio.trim() && (
                    <div style={{ padding: "10px 12px", background: "#0d0a05", border: "1px solid #1e1a10", borderRadius: 4 }}>
                      <p style={{ fontSize: 10, color: "#6a5840", letterSpacing: "0.1em", fontFamily: "'Cinzel',serif", marginBottom: 4 }}>BIO</p>
                      <p style={{ fontSize: 13, color: "#c8b890", fontFamily: "'IM Fell English',serif", fontStyle: "italic", lineHeight: 1.4 }}>{newBio.trim()}</p>
                    </div>
                  )}
                </div>
                {regError && (
                  <div style={{ background: "rgba(180,40,40,0.15)", border: "1px solid #7a2020", borderRadius: 8, padding: "10px 16px", marginBottom: 14, textAlign: "center" }}>
                    <p style={{ color: "#e87878", fontSize: 13, fontFamily: "'Cormorant Garamond',serif", margin: 0 }}>{regError}</p>
                  </div>
                )}
                <button type="button" className="b"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); finishReg(); }}
                  style={{ ...btn(true), padding: "14px", fontSize: 15, letterSpacing: "0.15em", cursor: "pointer" }}>
                  ENTER NOCTIS
                </button>
                <p style={{ fontSize: 11, color: "#6a5840", textAlign: "center", marginTop: 8, fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>
                  The shadows await your arrival.
                </p>
              </div>
            )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════
  // TAGS SCREEN — shown once after sign-up
  // ═══════════════════════════════════════════════════════
  if (screen === "tags") {
    const MAX_TAGS = 5;
    const toggleTag = (label: string) => {
      setPendingTags(prev =>
        prev.includes(label) ? prev.filter(t => t !== label) : prev.length < MAX_TAGS ? [...prev, label] : prev
      );
    };
    const confirmTags = () => {
      try { localStorage.setItem(`umbra_tags_${uid}`, JSON.stringify(pendingTags)); } catch {}
      // Persist to server so other users can see this person's traits on their profile
      if (uid) {
        fetch("/api/auth/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uid, traits: pendingTags }),
        }).catch(() => {});
      }
      setScreen("app");
    };
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#0e0b07,#1c1610,#261e13)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 16px" }}>
        <p style={{ fontFamily: "'Cinzel',serif", fontSize: 11, letterSpacing: "0.18em", color: "#9a8868", marginBottom: 10, textTransform: "uppercase" }}>Welcome to UMBRA</p>
        <h2 style={{ fontFamily: "'Cinzel',serif", fontSize: 22, color: "#d4af37", marginBottom: 6, textAlign: "center" }}>Who are you, really?</h2>
        <p style={{ fontSize: 13, color: "#9a8868", marginBottom: 24, textAlign: "center", maxWidth: 320, fontFamily: "'Cormorant Garamond',serif" }}>
          Choose <strong style={{ color: "#d4af37" }}>5 tags</strong> that describe your vibe. These will appear on your profile for others to see.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxWidth: 480, justifyContent: "center", marginBottom: 28 }}>
          {PROFILE_TAGS.map(tag => {
            const sel = pendingTags.includes(tag.label);
            const disabled = !sel && pendingTags.length >= MAX_TAGS;
            return (
              <button key={tag.label} onClick={() => !disabled && toggleTag(tag.label)}
                style={{
                  padding: "7px 14px", borderRadius: 20, fontSize: 12, fontFamily: "'Cormorant Garamond',serif", fontWeight: sel ? 700 : 400,
                  background: sel ? tag.color : "rgba(255,255,255,0.04)",
                  border: `1.5px solid ${sel ? tag.color : "#362e1e"}`,
                  color: sel ? "#f5ead8" : disabled ? "#4a3e2e" : "#c8b896",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.45 : 1,
                  transition: "all .15s",
                  transform: sel ? "scale(1.06)" : "scale(1)",
                }}>
                {sel && "✓ "}{tag.label}
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: 12, color: "#7a6848", marginBottom: 16, fontFamily: "'Cormorant Garamond',serif" }}>
          {pendingTags.length} / {MAX_TAGS} selected
        </p>
        <button onClick={confirmTags} disabled={pendingTags.length < MAX_TAGS}
          style={{
            padding: "12px 36px", borderRadius: 8, fontSize: 13, fontFamily: "'Cinzel',serif", letterSpacing: "0.1em",
            background: pendingTags.length === MAX_TAGS ? "linear-gradient(135deg,#d4af37,#b8922a)" : "#2a2010",
            border: `1px solid ${pendingTags.length === MAX_TAGS ? "#d4af37" : "#362e1e"}`,
            color: pendingTags.length === MAX_TAGS ? "#0e0b07" : "#4a3e2e",
            cursor: pendingTags.length < MAX_TAGS ? "not-allowed" : "pointer",
            fontWeight: 700,
            transition: "all .2s",
          }}>
          {pendingTags.length < MAX_TAGS ? `Choose ${MAX_TAGS - pendingTags.length} more` : "ENTER UMBRA →"}
        </button>
        <button onClick={() => setScreen("app")} style={{ marginTop: 14, background: "none", border: "none", color: "#5a4a32", fontSize: 11, cursor: "pointer", fontFamily: "'Cormorant Garamond',serif", letterSpacing: "0.08em" }}>
          skip for now
        </button>
      </div>
    );
  }

  // If uid is set but ACCTS hasn't loaded the user yet (e.g. async session restore still in flight),
  // show a loading state instead of silently rendering nothing.
  if (screen === "app" && uid && !user) {
    return (
      <div style={{ minHeight: "100vh", background: "#0e0b07", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <p style={{ fontFamily: "'Cinzel',serif", color: "#d4af37", fontSize: 14, letterSpacing: "0.15em" }}>LOADING UMBRA…</p>
        <button onClick={() => { try { localStorage.removeItem("umbra_session"); } catch {} setScreen("landing"); setUid(null); }}
          style={{ background: "none", border: "1px solid #362e1e", color: "#5a4a32", padding: "8px 20px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: "'Cormorant Garamond',serif" }}>
          Sign out and return to login
        </button>
      </div>
    );
  }
  if (screen !== "app" || !user) return null;

  // ═══════════════════════════════════════════════════════
  // POST CARD
  // ═══════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════
  // AUCTION LOT DOCUMENT VIEW
  // ═══════════════════════════════════════════════════════
  if (selectedLot) {
    const lot = selectedLot;
    const scBg = {
      background: "rgba(0,0,0,.85)",
      position: "fixed",
      inset: 0,
      zIndex: 200,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      padding: "20px 12px",
      overflowY: "auto",
    };
    const doc = {
      background: "#f8f4e8",
      color: "#1a1408",
      maxWidth: 580,
      width: "100%",
      borderRadius: 4,
      fontFamily: "'Cormorant Garamond',Georgia,serif",
      border: "2px solid #c8b890",
      boxShadow: "0 20px 60px rgba(0,0,0,.8)",
      marginTop: 20,
    };
    const dHdr = {
      background: "#1a1408",
      color: "#d4af37",
      padding: "14px 20px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    };
    const dSec = { padding: "16px 20px", borderBottom: "1px solid #d4b890" };
    const dLbl = {
      fontFamily: "'Cinzel',serif",
      fontSize: 9,
      color: "#8b7355",
      letterSpacing: "0.14em",
      marginBottom: 4,
      display: "block",
    };
    const dVal = { fontSize: 14, color: "#1a1408", lineHeight: 1.7 };
    const dRow = {
      display: "flex",
      justifyContent: "space-between",
      padding: "5px 0",
      borderBottom: "1px solid #e8dcc4",
    };
    const statusColor = {
      sold: "#8b2222",
      live: "#ff3b3b",
      upcoming: "#8b7355",
    };
    return (
      <div style={scBg} onClick={() => setSelectedLot(null)}>
        <div style={doc} onClick={(e) => e.stopPropagation()} className="fu">
          <div style={dHdr}>
            <div>
              <p
                style={{
                  fontFamily: "'Cinzel',serif",
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  marginBottom: 2,
                }}
              >
                NOCTIS UNIVERSITY — AUCTION HOUSE
              </p>
              <p
                style={{
                  fontFamily: "'Cinzel',serif",
                  fontSize: 16,
                  color: "#f0d060",
                }}
              >
                LOT #{lot.num} — {lot.type.toUpperCase()}
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <span
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  borderRadius: 3,
                  background: `${statusColor[lot.status]}22`,
                  color: statusColor[lot.status],
                  fontFamily: "'Cinzel',serif",
                }}
              >
                {lot.status.toUpperCase()}
              </span>
              <p style={{ fontSize: 12, color: "#d4af37", marginTop: 4 }}>
                Spring Auction 2024
              </p>
            </div>
          </div>

          {/* Subject */}
          {lot.subject && (
            <div style={dSec}>
              <span style={dLbl}>SUBJECT INFORMATION</span>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "4px 16px",
                }}
              >
                {Object.entries(lot.subject)
                  .filter(([k]) => k !== "name" || isApex)
                  .map(([k, v]) => (
                    <div key={k} style={dRow}>
                      <span
                        style={{
                          fontSize: 11,
                          color: "#8b7355",
                          fontFamily: "'Cinzel',serif",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {k.toUpperCase()}
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color:
                            k === "name" && !isApex ? "#8b7355" : "#1a1408",
                          fontStyle:
                            k === "name" && !isApex ? "italic" : "normal",
                        }}
                      >
                        {k === "name" && !isApex
                          ? "[REDACTED - APEX ONLY]"
                          : String(v)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Family background */}
          {lot.family && (
            <div style={dSec}>
              <span style={dLbl}>FAMILY & BACKGROUND</span>
              <p
                style={{
                  ...dVal,
                  fontFamily: "'IM Fell English',serif",
                  fontStyle: "italic",
                  marginBottom: 8,
                }}
              >
                {lot.family.background}
              </p>
              {lot.family.assets && (
                <p style={{ fontSize: 12, color: "#8b2222" }}>
                  <strong>Financial position:</strong> {lot.family.assets}
                </p>
              )}
            </div>
          )}

          {/* Medical / inspection */}
          {lot.medical && (
            <div
              style={{
                ...dSec,
                background: "rgba(139,26,26,.03)",
                borderLeft: "3px solid #8b2222",
              }}
            >
              <span style={{ ...dLbl, color: "#8b2222" }}>
                MEDICAL & INSPECTION REPORT — DR. A. VOSS
              </span>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "4px 16px",
                  marginBottom: 10,
                }}
              >
                {[
                  ["Inspection Date", lot.medical.inspectDate],
                  ["Inspector", lot.medical.inspector],
                  ["Sensitivity Score", `${lot.medical.sensitivity}%`],
                  [
                    "Broken Level",
                    lot.medical.broken !== undefined
                      ? `${lot.medical.broken}%`
                      : "N/A",
                  ],
                  [
                    "Obedience",
                    lot.medical.obedience !== undefined
                      ? `${lot.medical.obedience}%`
                      : "N/A",
                  ],
                  ["Contraception", lot.medical.contraception || "N/A"],
                ].map(([k, v]) => (
                  <div key={k} style={dRow}>
                    <span
                      style={{
                        fontSize: 11,
                        color: "#8b7355",
                        fontFamily: "'Cinzel',serif",
                        letterSpacing: "0.05em",
                      }}
                    >
                      {k}
                    </span>
                    <span style={{ fontSize: 12, color: "#1a1408" }}>{v}</span>
                  </div>
                ))}
              </div>
              {/* Stat bars */}
              {lot.medical.sensitivity &&
                [
                  ["Sensitivity", lot.medical.sensitivity, "#8b2222"],
                  ["Broken", lot.medical.broken, "#660044"],
                  ["Obedience", lot.medical.obedience, "#6a4400"],
                ]
                  .filter(([, v]) => v !== undefined && v !== null)
                  .map(([l, v, c]) => (
                    <div key={l} style={{ marginBottom: 6 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 2,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10,
                            fontFamily: "'Cinzel',serif",
                            color: "#8b7355",
                          }}
                        >
                          {l}
                        </span>
                        <span style={{ fontSize: 10, color: c }}>{v}%</span>
                      </div>
                      <div
                        style={{
                          height: 4,
                          background: "#e8dcc4",
                          borderRadius: 2,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${v}%`,
                            height: "100%",
                            background: c,
                            borderRadius: 2,
                          }}
                        />
                      </div>
                    </div>
                  ))}
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 12px",
                  background: "rgba(139,26,26,.06)",
                  borderRadius: 4,
                  border: "1px solid #c8a0a0",
                }}
              >
                <p
                  style={{
                    fontSize: 10,
                    fontFamily: "'Cinzel',serif",
                    color: "#8b2222",
                    letterSpacing: "0.08em",
                    marginBottom: 4,
                  }}
                >
                  INSPECTOR NOTES
                </p>
                <p
                  style={{
                    fontSize: 13,
                    color: "#3a1408",
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                    lineHeight: 1.7,
                  }}
                >
                  {lot.medical.notes}
                </p>
              </div>
            </div>
          )}

          {/* Bid history */}
          <div style={dSec}>
            <span style={dLbl}>
              BID HISTORY {lot.status === "live" ? "(LIVE)" : ""}
            </span>
            {lot.status === "live" ? (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "6px 0",
                    borderBottom: "1px solid #e8dcc4",
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontFamily: "'Cinzel',serif",
                      color: "#8b7355",
                    }}
                  >
                    CURRENT
                  </span>
                  <span
                    style={{
                      fontFamily: "'Cinzel',serif",
                      fontSize: 16,
                      color: "#8b2222",
                    }}
                  >
                    ${liveBid.toLocaleString()}
                  </span>
                </div>
                {[
                  ...LOTS.find((l) => l.id === "L07").bids,
                  ...myBids
                    .filter((b) => b.lot === "Lot #7")
                    .map((b) => ({
                      bidder: `${user.un} (You)`,
                      amount: b.amount,
                      time: b.time,
                    })),
                ]
                  .reverse()
                  .map((b, i) => (
                    <div
                      key={i}
                      style={{
                        ...dRow,
                        background: b.bidder.includes("You")
                          ? "rgba(212,175,55,.08)"
                          : "transparent",
                      }}
                    >
                      <span style={{ fontSize: 12, color: "#1a1408" }}>
                        {b.bidder}
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          fontFamily: "'Cinzel',serif",
                          color: "#8b7355",
                        }}
                      >
                        ${b.amount?.toLocaleString()} · {b.time}
                      </span>
                    </div>
                  ))}
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <input
                    value={bidInput}
                    onChange={(e) => setBidInput(e.target.value)}
                    placeholder={`Min $${(liveBid + 1).toLocaleString()}`}
                    style={{
                      flex: 1,
                      padding: "8px 12px",
                      background: "#f0e8d8",
                      border: "1px solid #c8b890",
                      borderRadius: 4,
                      fontSize: 13,
                      fontFamily: "inherit",
                      color: "#1a1408",
                    }}
                  />
                  <button
                    type="button"
                    className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      placeBid();
                    }}
                    style={{
                      padding: "8px 16px",
                      background: "#1a1408",
                      border: "1px solid #d4af37",
                      color: "#d4af37",
                      borderRadius: 4,
                      fontSize: 12,
                      fontFamily: "'Cinzel',serif",
                    }}
                  >
                    BID
                  </button>
                </div>
              </>
            ) : lot.bids && lot.bids.length > 0 ? (
              lot.bids.map((b, i) => (
                <div key={i} style={dRow}>
                  <span style={{ fontSize: 12, color: "#1a1408" }}>
                    {b.bidder}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontFamily: "'Cinzel',serif",
                      color: "#8b7355",
                    }}
                  >
                    ${b.amount?.toLocaleString()} · {b.time}
                  </span>
                </div>
              ))
            ) : (
              <p
                style={{ fontSize: 13, color: "#8b7355", fontStyle: "italic" }}
              >
                Bidding opens at auction.
              </p>
            )}
          </div>

          {/* Final price */}
          {lot.finalPrice && (
            <div
              style={{
                padding: "14px 20px",
                background: "#1a1408",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontFamily: "'Cinzel',serif",
                  fontSize: 11,
                  color: "#8b7355",
                  letterSpacing: "0.12em",
                }}
              >
                FINAL SALE PRICE
              </span>
              <span
                style={{
                  fontFamily: "'Cinzel',serif",
                  fontSize: 18,
                  color: "#d4af37",
                }}
              >
                ${lot.finalPrice.toLocaleString()}
              </span>
            </div>
          )}
          {lot.buyer && (
            <div style={{ padding: "6px 20px 14px", background: "#1a1408" }}>
              <span
                style={{
                  fontSize: 11,
                  color: "#8b7355",
                  fontFamily: "'Cinzel',serif",
                  letterSpacing: "0.06em",
                }}
              >
                ACQUIRED BY:{" "}
              </span>
              <span style={{ fontSize: 12, color: "#d4af37" }}>
                {lot.buyer}
              </span>
            </div>
          )}

          <div
            style={{
              padding: "12px 20px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              borderTop: "1px solid #d4b890",
              background: "#f0e8d8",
            }}
          >
            <p
              style={{
                fontSize: 10,
                color: "#8b7355",
                fontFamily: "'Cinzel',serif",
                letterSpacing: "0.08em",
              }}
            >
              UNIVERSITY ATTORNEYS HAVE VERIFIED THIS DOCUMENT · OMERTÀ PROTOCOL
              ACTIVE
            </p>
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelectedLot(null);
              }}
              style={{
                padding: "6px 14px",
                background: "#1a1408",
                border: "1px solid #d4af37",
                color: "#d4af37",
                borderRadius: 4,
                fontSize: 11,
                fontFamily: "'Cinzel',serif",
              }}
            >
              CLOSE
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════
  // FEED
  // ═══════════════════════════════════════════════════════
  const Feed = () => {
    let fp = posts.filter((p) => !p.apexOnly || isApex);
    if (feedTab === "confessions") fp = fp.filter((p) => p.isConfession);
    if (feedTab === "pictures") fp = fp.filter((p) => p.image);
    if (feedTab === "trending")
      fp = [...fp].sort(
        (a, b) =>
          Object.values(b.r).reduce((x, y) => x + y, 0) -
          Object.values(a.r).reduce((x, y) => x + y, 0)
      );

    // picture placeholders for pictures tab
    const showPicGrid = feedTab === "pictures";

    return (
      <div>
        <div style={hdr}>
          <div
            style={{
              maxWidth: 600,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <h1
              style={{
                fontFamily: "'Cinzel',serif",
                fontSize: 20,
                color: T.primary,
                letterSpacing: "0.15em",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              UMBRA{" "}
              {rtReady && (
                <span
                  title="Real-time sync active"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#44cc88",
                    display: "inline-block",
                    animation: "pulse 2s infinite",
                  }}
                />
              )}
            </h1>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {user.isAdmin && (
                <span style={{ fontSize: 10, color: "#cc44ff", border: "1px solid #cc44ff", borderRadius: 3, padding: "2px 6px" }}>ADMIN</span>
              )}
              <button type="button" title="My bag" onClick={(e) => { e.preventDefault(); e.stopPropagation(); go("bag"); }}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: "50%", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, cursor: "pointer", color: T.text }}>
                🎒
              </button>
              <button
                type="button"
                title="Direct Messages"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDmConvId(null); setNav("messages"); }}
                style={{
                  position: "relative",
                  background: "none",
                  border: `1px solid ${T.border}`,
                  borderRadius: "50%",
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 15,
                  cursor: "pointer",
                  color: T.text,
                }}
              >
                ✉️
                {dmMessages.length > 0 && (
                  <span style={{
                    position: "absolute",
                    top: -3,
                    right: -3,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: T.primary,
                  }} />
                )}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  viewProf(uid);
                }}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: 20,
                  color: T.text,
                  display: "flex",
                  alignItems: "center",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                {picEl(user.pic, 26)}
              </button>
            </div>
          </div>
        </div>
        <div style={sec}>
          {user.tier === "pet" && (
            <div style={{ background: "rgba(139,0,0,.1)", border: "1px solid #3a0000", borderRadius: 6, padding: "8px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14 }}>🔒</span>
              <p style={{ fontSize: 11, color: "#8b0000", fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>You are collared. You exist to serve. You do not question. You obey.</p>
            </div>
          )}
          {user.tier === "relief" && (
            <div style={{ background: "rgba(74,122,155,.06)", border: "1px solid #335566", borderRadius: 6, padding: "8px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14 }}>🏠</span>
              <p style={{ fontSize: 11, color: "#4a7a9b" }}>Room {user.roomNumber} · {user.usageToday || 0} uses today · Read-only access</p>
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 7,
              padding: "10px 0",
              overflowX: "auto",
            }}
          >
            {[
              ["all", "All"],
              ["trending", "🔥 Trending"],
              ["pictures", "📸 Pictures"],
              ["confessions", "🔖 Confessions"],
            ].map(([k, l]) => (
              <button
                key={k}
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFeedTab(k);
                }}
                style={pill(feedTab === k)}
              >
                {l}
              </button>
            ))}
          </div>

          {/* Pictures grid with placeholders */}
          {showPicGrid && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3,1fr)",
                gap: 4,
                marginBottom: 14,
              }}
            >
              {UNSPLASH_PLACEHOLDERS.map((url, i) => (
                <div
                  key={i}
                  style={{
                    aspectRatio: "1",
                    background: T.tag,
                    borderRadius: 4,
                    overflow: "hidden",
                    border: `1px solid ${T.border}`,
                  }}
                >
                  <img
                    src={url}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                    onError={(e) => {
                      e.target.style.display = "none";
                      e.target.parentElement.style.background = T.tag;
                    }}
                  />
                </div>
              ))}
              {fp
                .filter((p) => p.image)
                .map((p) => (
                  <div
                    key={p.id}
                    style={{
                      aspectRatio: "1",
                      background: T.tag,
                      borderRadius: 4,
                      overflow: "hidden",
                      border: `1px solid ${T.border}`,
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setFeedTab("all");
                      setTimeout(
                        () =>
                          document
                            .getElementById(`post-${p.id}`)
                            ?.scrollIntoView({ behavior: "smooth" }),
                        100
                      );
                    }}
                  >
                    <img
                      src={p.image}
                      alt=""
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                      onError={(e) => (e.target.style.display = "none")}
                    />
                  </div>
                ))}
            </div>
          )}

          {user.tier === "guest" && (
            <div
              style={{
                background: "rgba(212,175,55,.06)",
                border: `1px solid ${T.primary}33`,
                borderRadius: 8,
                padding: "12px 14px",
                marginBottom: 10,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <p
                style={{
                  fontSize: 13,
                  color: T.muted,
                  fontFamily: "'IM Fell English',serif",
                  fontStyle: "italic",
                }}
              >
                You are watching.{" "}
                <span style={{ color: T.primary }}>Sign in or join</span> to
                post, react, and bid.
              </p>
              <button
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setUid(null);
                  setScreen("login");
                }}
                style={{
                  padding: "6px 12px",
                  background: T.tag,
                  border: `1px solid ${T.primary}`,
                  color: T.primary,
                  borderRadius: 6,
                  fontSize: 11,
                  fontFamily: "'Cinzel',serif",
                  flexShrink: 0,
                }}
              >
                JOIN
              </button>
            </div>
          )}
          {user.canPost && !compose && (
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCompose(true);
              }}
              style={{
                ...card,
                width: "100%",
                padding: "12px 14px",
                color: T.muted,
                textAlign: "left",
                marginBottom: 10,
                fontSize: 14,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
              }}
            >
              What are you thinking, {user.un.split(" ")[0]}?
            </button>
          )}
          {compose && (
            <div
              style={{
                ...card,
                padding: 14,
                marginBottom: 10,
                animation: "fadeUp .3s ease",
              }}
            >
              <textarea
                value={pTxt}
                onChange={(e) => setPTxt(e.target.value)}
                placeholder="Speak your truth…"
                style={{
                  ...inp,
                  minHeight: 88,
                  resize: "none",
                  fontFamily: "'IM Fell English',serif",
                  fontStyle: "italic",
                  marginBottom: 8,
                }}
              />
              <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center" }}>
                <input
                  value={pImg}
                  onChange={(e) => setPImg(e.target.value)}
                  placeholder={imgUploading ? "Uploading…" : "Image URL (optional)"}
                  style={{ ...inp, flex: 1, color: T.muted }}
                  disabled={imgUploading}
                />
                <label
                  title="Upload photo"
                  style={{
                    ...btn(false),
                    padding: "7px 10px",
                    cursor: imgUploading ? "wait" : "pointer",
                    opacity: imgUploading ? 0.5 : 1,
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                >
                  {imgUploading ? "⏳" : "📷"}
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    disabled={imgUploading}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = "";
                      setImgUploading(true);
                      try {
                        const publicUrl = await new Promise<string>((resolve, reject) => {
                          const reader = new FileReader();
                          reader.onload = (ev) => resolve(ev.target?.result as string);
                          reader.onerror = reject;
                          reader.readAsDataURL(file);
                        });
                        setPImg(publicUrl);
                      } catch {
                        toast("Upload failed. Try a URL instead.");
                      } finally {
                        setImgUploading(false);
                      }
                    }}
                  />
                </label>
              </div>
              {pImg && (
                <div style={{ marginBottom: 10, position: "relative", display: "inline-block" }}>
                  <img src={pImg} alt="preview" style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 8, display: "block" }} onError={() => setPImg("")} />
                  <button type="button" onClick={() => setPImg("")} style={{ position: "absolute", top: 4, right: 4, background: "rgba(0,0,0,.6)", border: "none", color: "#fff", borderRadius: "50%", width: 22, height: 22, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                </div>
              )}
              <div
                style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCompose(false);
                    setPTxt("");
                    setPImg("");
                  }}
                  style={btn(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    doPost();
                  }}
                  style={btn(true)}
                >
                  POST
                </button>
              </div>
            </div>
          )}

          {fp.map((p, i) => (
            <PostCard
              key={p.id}
              post={p}
              idx={i}
              T={T}
              user={user}
              uid={uid}
              ACCTS_REF={ACCTS}
              react={react}
              delPost={delPost}
              delC={delC}
              viewProf={viewProf}
              pushPosts={pushPosts}
              setPosts={setPosts}
              EMOJIS={EMOJIS}
              inp={inp}
              card={card}
              lbl={lbl}
              bdg={bdg}
              framedAvatar={framedAvatar}
              getFrame={getFrame}
            />
          ))}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // PROFILE
  // ═══════════════════════════════════════════════════════
  const Profile = () => {
    const pid = profId || uid;
    // If this ID matches a professor, redirect to professor detail view
    const profFromProfs = PROFS.find((p: any) => p.id === pid);
    if (profFromProfs) {
      return (
        <div style={{ maxWidth: 600, margin: "0 auto" }}>
          <button type="button" className="b" onClick={() => setProfId("")}
            style={{ ...btn(false), padding: "8px 14px", marginBottom: 14, fontSize: 12 }}>
            ← BACK
          </button>
          <div style={{ ...card, padding: 20, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
              <span style={{ fontSize: 48, border: `2px solid ${profFromProfs.color}`, borderRadius: "50%", padding: 6 }}>{profFromProfs.pic}</span>
              <div>
                <p style={{ fontSize: 18, color: profFromProfs.color, fontFamily: "'Cinzel Decorative',serif", marginBottom: 2 }}>{profFromProfs.name}</p>
                <p style={{ fontSize: 12, color: T.muted, fontFamily: "'Cinzel',serif" }}>{profFromProfs.dept}</p>
                {profFromProfs.pronouns && <p style={{ fontSize: 11, color: T.muted, fontStyle: "italic", marginTop: 2 }}>{profFromProfs.pronouns}</p>}
              </div>
            </div>
            <p style={{ fontSize: 13, color: T.text, fontFamily: "'IM Fell English',serif", lineHeight: 1.7, marginBottom: 14 }}>{profFromProfs.bio}</p>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8, marginBottom: 14 }}>
              {profFromProfs.courses.map((c: string, i: number) => (
                <span key={i} style={{ ...bdg(profFromProfs.color + "22"), border: `1px solid ${profFromProfs.color}44`, fontSize: 10, color: profFromProfs.color }}>{c}</span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" as const }}>
              <span style={{ fontSize: 11, color: T.muted }}>🕐 {profFromProfs.hours}</span>
              <span style={{ fontSize: 11, color: T.muted }}>📚 {profFromProfs.courses.length} courses</span>
              <span style={{ fontSize: 11, color: T.muted }}>⭐ Favorability: {profFromProfs.favorability ?? 50}%</span>
            </div>
          </div>
          <button type="button" className="b"
            onClick={() => { setProfId(""); setViewingProfId(profFromProfs.id); setNav("university"); }}
            style={{ ...btn(true), width: "100%", padding: "12px", fontSize: 13 }}>
            VIEW FULL PROFESSOR PROFILE & DM →
          </button>
        </div>
      );
    }
    const acctProf = ACCTS[pid];
    const fallbackPost = !acctProf ? posts.find((p) => p.uid === pid) : null;
    const prof = acctProf || (fallbackPost ? {
      id: pid,
      un: fallbackPost._un || "Unknown",
      pic: fallbackPost._pic || "🌑",
      cov: fallbackPost._cov || "shadows",
      tier: fallbackPost._tier || "merit",
      bio: "",
      followers: 0,
      following: 0,
      pets: [],
    } : user);
    const myPosts = posts.filter((p) => p.uid === pid);
    const isMe = pid === uid;
    const isFollowing = follows.has(pid);
    const isViiProf = prof.id === "vii_imperator";
    const VTH = isViiProf ? TH.vii_aether : null;
    const PT = VTH || T;
    const profCard = VTH
      ? { background: VTH.card, border: `1px solid ${VTH.border}`, borderRadius: 10 }
      : card;
    const profInp = VTH
      ? { background: VTH.inp, border: `1px solid ${VTH.border}`, color: VTH.text, padding: "10px 14px", borderRadius: 6, fontSize: 14, width: "100%", fontFamily: "inherit" }
      : inp;
    const cv = COV[prof.cov];
    const petList = prof.pets
      ? prof.pets.map((id) => ACCTS[id]).filter(Boolean)
      : [];
    return (
      <div style={isViiProf ? {background:"linear-gradient(160deg,#020d12,#071825,#0c2030)",minHeight:"100%",backgroundAttachment:"local"} : {}}>
        <div style={isViiProf ? {...hdr, background:"linear-gradient(135deg,#0d2840,#071218)", borderBottom:"2px solid #03B0D3", boxShadow:"0 2px 16px rgba(3,176,211,.15)"} : hdr}>
          <div
            style={{
              maxWidth: 600,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            {!isMe && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setProfId(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: isViiProf ? "#48cae4" : T.muted,
                  fontSize: 18,
                }}
              >
                ←
              </button>
            )}
            <span style={isViiProf ? {...ttl(), color:"#03B0D3", textShadow:"0 0 12px rgba(3,176,211,.6)", fontFamily:"'Cinzel',serif", letterSpacing:"0.15em"} : ttl()}>
              {isViiProf ? "♟ IMPERATOR" : "PROFILE"}
            </span>
          </div>
        </div>
        <div style={sec}>
          <div
            style={{
              height: 88,
              background: VTH
                ? `linear-gradient(135deg,#0d2840,#071218,#0a1f32)`
                : `linear-gradient(135deg,${T.tag},${T.pill})`,
              borderRadius: "10px 10px 0 0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 48,
              marginTop: 12,
              border: VTH ? `1px solid #03B0D3` : `1px solid ${T.border}`,
              borderBottom: "none",
              overflow: "hidden",
              position: "relative",
            }}
          >
            {prof.id === "vii_imperator" ? (
              <>
                {/* Chess board pattern overlay */}
                <svg viewBox="0 0 600 88" style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",opacity:.18}} preserveAspectRatio="xMidYMid slice">
                  {(Array.from({length:88}) as undefined[]).map((_,i)=>{
                    const col=i%11;const row=Math.floor(i/11);
                    return (col+row)%2===0 ? <rect key={i} x={col*55} y={row*12} width={55} height={12} fill="#caf0f8"/> : null;
                  })}
                </svg>
                {/* Teal radial glow */}
                <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at 50% 50%,rgba(3,176,211,.35),transparent 70%)"}}/>
                {/* Chess pieces */}
                <div style={{position:"relative",zIndex:2,display:"flex",gap:12,alignItems:"center",fontSize:32,filter:"drop-shadow(0 0 8px #03B0D3)"}}>
                  <span className="chess-drift3" style={{opacity:.6,fontSize:22}}>♜</span>
                  <span className="chess-drift2" style={{opacity:.7,fontSize:26}}>♞</span>
                  <span className="vii-pulse" style={{fontSize:44,opacity:1}}>♔</span>
                  <span className="chess-drift" style={{opacity:.7,fontSize:26}}>♛</span>
                  <span className="chess-drift2" style={{opacity:.6,fontSize:22}}>♜</span>
                </div>
              </>
            ) : (() => {
              const coverVal = prof.cover || prof.pic;
              return coverVal && (coverVal.startsWith("/") || coverVal.startsWith("http") || coverVal.startsWith("data:"))
                ? <img src={coverVal} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
                : coverVal;
            })()}
          </div>
          <div
            style={{
              ...card,
              background: VTH ? "#071218" : card.background,
              border: VTH ? `1px solid #03B0D3` : card.border,
              boxShadow: VTH ? `0 0 18px rgba(3,176,211,.15), 0 0 4px rgba(3,176,211,.08)` : undefined,
              borderRadius: "0 0 10px 10px",
              padding: "0 14px 14px",
              marginBottom: 12,
              borderTop: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                marginTop: "-26px",
                marginBottom: 10,
              }}
            >
              <div style={{ position: "relative" }}>
                {framedAvatar(serverProfilePics[pid] || prof.pic, 58, isMe ? profileFrame : getFrame(profId || ""))}
                {isMe && (
                  <label title="Change photo" style={{ position: "absolute", bottom: 0, right: 0, width: 20, height: 20, background: T.primary, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11, border: `2px solid ${T.card}`, zIndex: 5 }}>
                    📷
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = "";
                      toast("Uploading photo…");
                      const applyNewPic = (newPic: string) => {
                        if (ACCTS[uid]) (ACCTS[uid] as any).pic = newPic;
                        try {
                          const saved = JSON.parse(localStorage.getItem("umbra:accts:v1") || "{}");
                          saved[uid] = { ...(saved[uid] || {}), pic: newPic };
                          localStorage.setItem("umbra:accts:v1", JSON.stringify(saved));
                          const c2 = JSON.parse(localStorage.getItem("umbra_custom_accts") || "{}");
                          c2[uid] = { ...(c2[uid] || {}), pic: newPic };
                          localStorage.setItem("umbra_custom_accts", JSON.stringify(c2));
                        } catch {}
                        // Persist to server so other users / other devices can see the new photo
                        const _acct = ACCTS[uid] as any;
                        const _payload: Record<string, any> = { userId: uid, pic: newPic };
                        if (_acct?.bio) _payload.bio = _acct.bio;
                        if (_acct?.cov) _payload.covenant = _acct.cov;
                        if (_acct?.tier) _payload.tier = _acct.tier;
                        if (_acct?.major) _payload.major = _acct.major;
                        if (_acct?.year) _payload.year = _acct.year;
                        if (_acct?.wealth) _payload.wealth = _acct.wealth;
                        if (_acct?.rep) _payload.rep = _acct.rep;
                        fetch("/api/auth/profile", {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(_payload),
                        }).catch(() => {});
                        setAcctVer(v => v + 1);
                        toast("Profile photo updated ✓");
                      };
                      try {
                        const urlRes = await fetch("/api/storage/uploads/request-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }) });
                        if (!urlRes.ok) throw new Error("url-req-failed");
                        const { uploadURL, publicUrl } = await urlRes.json();
                        const upRes = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
                        if (!upRes.ok) throw new Error("upload-failed");
                        applyNewPic(publicUrl);
                      } catch {
                        try {
                          const dataUrl = await compressImage(file, 600, 0.72);
                          applyNewPic(dataUrl);
                        } catch { toast("Upload failed. Try again."); }
                      }
                    }} />
                  </label>
                )}
              </div>
              {!isMe && (
                <button
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFollow(pid);
                    toast(follows.has(pid) ? "Unfollowed" : "Following ✓");
                  }}
                  style={{
                    ...btn(follows.has(pid)),
                    marginTop: 38,
                    fontSize: 12,
                  }}
                >
                  {follows.has(pid) ? "Following ✓" : "Follow"}
                </button>
              )}
              {!isMe && (
                <button
                  type="button"
                  className="b"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDmConvId(pid); setDmOpen(true); setNav("messages"); }}
                  style={{ ...btn(false), marginTop: 38, fontSize: 12, marginLeft: 6 }}
                >✉ DM</button>
              )}
              {!isMe && (pid === "trent_morrison" || pid === "cyrus_whitmore") && uid && (() => {
                const isTrent = pid === "trent_morrison";
                const pts = isTrent ? (trentRel[uid]||0) : (cyrusRel[uid]||0);
                const tl = isTrent ? getTrentLevel(pts) : getCyrusLevel(pts);
                return (
                  <div style={{ marginTop: 38, marginLeft: 6, padding: "4px 10px", borderRadius: 12, border: `1px solid ${tl.color}`, background: T.dim, cursor: "pointer" }} onClick={(e) => { e.preventDefault(); setSubPage("shop"); setShopTab("gifts"); go("university"); }}>
                    <span style={{ fontSize: 11, color: tl.color, fontWeight: 700 }}>L{tl.level} {tl.name}</span>
                  </div>
                );
              })()}
              {isMe && (
                <div style={{ marginTop: 38 }}>
                  <span style={bdg(prof.bColor)}>{prof.badge}</span>
                </div>
              )}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                flexWrap: "wrap",
                marginBottom: 2,
              }}
            >
              {prof.id === "vii_imperator" ? (
                <h2 className="vii-glow" style={{ fontSize: 17, fontWeight: 700, color: "#03B0D3", fontFamily: "'Cinzel','Georgia',serif", letterSpacing: "0.06em" }}>
                  {prof.un}
                </h2>
              ) : (
                <h2 style={{ fontSize: 16, fontWeight: 600, color: T.text }}>
                  {prof.un}
                </h2>
              )}
              {prof.isVerified && (
                <span style={{ color: prof.id === "vii_imperator" ? "#03B0D3" : T.primary, fontSize: 11 }}>✓</span>
              )}
              {prof.isAdmin && <span style={bdg(prof.id === "vii_imperator" ? "#03B0D3" : "#cc44ff")}>ADMIN</span>}
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, flexWrap:"wrap" as const }}>
              <p style={{ fontSize: 12, color: VTH ? "#48cae4" : T.muted, fontFamily: VTH ? "'Cinzel',serif" : undefined, letterSpacing: VTH ? "0.04em" : undefined, margin:0 }}>
                {prof.handle}
              </p>
              {(() => {
                const pronouns = (prof as any).pronouns || PRONOUNS_MAP[prof.id || ""];
                if (!pronouns) return null;
                return (
                  <span style={{ fontSize:11, color:T.muted, background:T.tag, border:`1px solid ${T.border}`, borderRadius:20, padding:"1px 8px", fontStyle:"italic" }}>
                    {pronouns}
                  </span>
                );
              })()}
            </div>
            <p
              style={{
                fontSize: 14,
                lineHeight: 1.7,
                color: VTH ? "#caf0f8" : T.text,
                marginBottom: 10,
                fontFamily: VTH ? "'Cormorant Garamond','IM Fell English',serif" : "'IM Fell English',serif",
                fontStyle: "italic",
                whiteSpace: "pre-wrap",
              }}
            >
              {prof.bio}
            </p>
            {prof.tier === "pet" && (
              <div
                style={{
                  background: "rgba(139,0,0,.1)",
                  border: "1px solid #4a0000",
                  borderRadius: 6,
                  padding: "10px 12px",
                  marginBottom: 10,
                  textAlign: "center",
                }}
              >
                <p
                  style={{
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                    fontSize: 13,
                    color: "#8b1414",
                    lineHeight: 1.8,
                  }}
                >
                  I am property. I exist to serve.
                  <br />I like to serve. I need to obey.
                  <br />I am grateful for my collar. 🔒
                </p>
              </div>
            )}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                borderTop: VTH ? `1px solid #03B0D3` : `1px solid ${T.border}`,
                paddingTop: 12,
                marginBottom: 10,
              }}
            >
              {[
                ["Followers", (followerCounts[prof.id] ?? prof.followers ?? 0).toLocaleString()],
                ["Following", (isMe ? follows.size : (prof.following || 0)).toLocaleString()],
                ["Gaze", prof.gaze?.toLocaleString() || "0"],
                ["Influence", isMe ? userInfluence.toLocaleString() : "—"],
              ].map(([l, v]) => (
                <div key={l} style={{ flex: 1, textAlign: "center" }}>
                  <div
                    style={{
                      fontFamily: "'Cinzel',serif",
                      fontSize: 14,
                      color: l === "Influence" ? (VTH ? "#03B0D3" : "#d4af37") : (VTH ? "#03B0D3" : T.primary),
                      fontWeight: 600,
                      textShadow: VTH ? "0 0 8px rgba(3,176,211,.5)" : l === "Influence" ? "0 0 8px rgba(212,175,55,.3)" : undefined,
                    }}
                  >
                    {l === "Influence" ? `⭐${v}` : v}
                  </div>
                  <div style={{ ...lbl, marginTop: 2 }}>{l}</div>
                </div>
              ))}
              {isMe && (
                <div style={{ flexBasis: "100%", marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: T.muted }}>⭐ INFLUENCE</span>
                    <span style={{ fontSize: 10, color: "#d4af37" }}>{userInfluence.toLocaleString()} / {userInfluence >= 1000 ? "MAX" : userInfluence >= 500 ? "1000" : userInfluence >= 100 ? "500" : "100"}</span>
                  </div>
                  <div style={{ height: 4, background: T.border, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, userInfluence >= 1000 ? 100 : userInfluence >= 500 ? ((userInfluence-500)/500)*100 : userInfluence >= 100 ? ((userInfluence-100)/400)*100 : (userInfluence/100)*100)}%`, background: "linear-gradient(90deg,#a07020,#d4af37)", borderRadius: 2, transition: "width 0.6s ease" }} />
                  </div>
                  <p style={{ fontSize: 10, color: T.muted, marginTop: 4 }}>
                    {userInfluence >= 1000 ? "🏆 Noctis Legend" : userInfluence >= 500 ? "👑 Campus Icon — " + (1000-userInfluence) + " to Legend" : userInfluence >= 100 ? "⭐ Rising Star — " + (500-userInfluence) + " to Campus Icon" : (100-userInfluence) + " influence to Rising Star"}
                  </p>
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {cv && (
                <span style={pill(false)}>
                  {cv.emoji} {cv.name}
                </span>
              )}
              {prof.tier && (
                <span style={bdg(prof.bColor)}>{prof.tier.toUpperCase()}</span>
              )}
              {prof.major && <span style={pill(false)}>📚 {prof.major}</span>}
              {prof.year && <span style={pill(false)}>🎓 {prof.year}</span>}
              {prof.greek && prof.greek !== "None" && (
                <span style={pill(false)}>🏛️ {prof.greek}</span>
              )}
              {prof.wealth && <span style={pill(false)}>💰 {prof.wealth}</span>}
              {prof.rep && <span style={pill(false)}>⭐ {prof.rep}</span>}
              {prof.isMaster && prof.petCount && (
                <span style={bdg("#d4af37")}>⛓️ {prof.petCount} Pets</span>
              )}
              {prof.tier === "pet" && (
                <span style={bdg("#8b0000")}>
                  🔒 Property of {prof.masterName}
                </span>
              )}
              {prof.tier === "relief" && (
                <span style={bdg("#4a7a9b")}>🪑 Room {prof.roomNumber}</span>
              )}
            </div>
            {/* ── Profile tags / traits ── */}
            {(() => {
              let tags: string[] = [];
              try { tags = JSON.parse(localStorage.getItem(`umbra_tags_${pid}`) || "[]"); } catch {}
              const profTraits: string[] = Array.isArray((prof as any).traits) ? (prof as any).traits : [];
              const fetched: string[] = serverProfileTraits[pid] || [];
              const allVibes = [...new Set([...tags, ...profTraits, ...fetched])];
              if (!allVibes.length) return null;
              return (
                <div style={{ marginTop: 10 }}>
                  <p style={{ ...lbl, marginBottom: 6, letterSpacing: "0.1em" }}>✦ VIBES</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {allVibes.map(t => {
                      const tagDef = PROFILE_TAGS.find(pt => pt.label === t);
                      return (
                        <span key={t} style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, background: tagDef ? `${tagDef.color}44` : "#2a2010", border: `1px solid ${tagDef?.color || "#362e1e"}`, color: tagDef ? "#e8dcc4" : T.muted, fontFamily: "'Cormorant Garamond',serif", letterSpacing: "0.06em" }}>
                          {t}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Family background — on profile, Apex only */}
          {isApex && prof.family && (
            <div
              style={{
                ...profCard,
                padding: 14,
                marginBottom: 10,
                border: `1px solid ${PT.primary}55`,
                boxShadow: isViiProf ? `0 0 12px rgba(3,176,211,.1)` : undefined,
              }}
            >
              <p style={{ ...lbl, color: PT.primary, marginBottom: 6, textShadow: isViiProf ? "0 0 8px rgba(3,176,211,.4)" : undefined }}>
                {isViiProf ? "♟ THE RECORD" : "🔒 APEX — FAMILY BACKGROUND"}
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: PT.muted,
                  lineHeight: 1.7,
                  fontFamily: isViiProf ? "'Cormorant Garamond',serif" : "'IM Fell English',serif",
                  fontStyle: "italic",
                }}
              >
                {prof.family}
              </p>
            </div>
          )}

          {/* Personality */}
          {prof.personality && (
            <div style={{ ...profCard, padding: 14, marginBottom: 10, boxShadow: isViiProf ? `0 0 12px rgba(3,176,211,.1)` : undefined }}>
              <p style={{ ...lbl, marginBottom: 6, color: isViiProf ? "#48cae4" : undefined, textShadow: isViiProf ? "0 0 6px rgba(3,176,211,.3)" : undefined }}>
                {isViiProf ? "♟ STRATEGIC PROFILE" : "PERSONALITY PROFILE"}
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: PT.muted,
                  lineHeight: 1.7,
                  fontFamily: isViiProf ? "'Cormorant Garamond',serif" : "'IM Fell English',serif",
                  fontStyle: "italic",
                }}
              >
                {prof.personality}
              </p>
            </div>
          )}

          {/* Academic Track */}
          {prof.major && (() => {
            const majorClasses = CLASSES.filter(c =>
              c.major === prof.major ||
              (prof.major && c.major && prof.major.toLowerCase().split(/[\s&,]+/).some(w => w.length > 3 && c.major.toLowerCase().includes(w)))
            ).slice(0, 4);
            const enrolledIds: string[] = isMe
              ? enrolledClasses
              : Array.isArray((prof as any).enrolledClasses) ? (prof as any).enrolledClasses : [];
            const enrolledObjs = enrolledIds.map(id => CLASSES.find(c => c.id === id)).filter(Boolean).slice(0, 4);
            const displayClasses = enrolledObjs.length > 0 ? enrolledObjs : majorClasses;
            if (!displayClasses.length) return null;
            return (
              <div style={{ ...profCard, padding: 14, marginBottom: 10 }}>
                <p style={{ ...lbl, marginBottom: 10 }}>📚 ACADEMIC TRACK</p>
                {displayClasses.map((cls: any) => {
                  const lessons = cls.lessons?.length || 0;
                  const done = isMe ? cls.lessons?.filter((l: any) => completedLessons.includes(`${cls.id}:${l.id}`)).length || 0 : 0;
                  return (
                    <div key={cls.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, padding: "8px 10px", background: T.tag, borderRadius: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 2 }}>{cls.name}</div>
                        <div style={{ fontSize: 11, color: T.muted }}>{cls.major}</div>
                      </div>
                      {isMe && lessons > 0 && (
                        <div style={{ fontSize: 11, color: T.primary, fontFamily: "'Cinzel',serif" }}>{done}/{lessons}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Master's Pet Panel */}
          {prof.isMaster && petList.length > 0 && (isMe || isApex) && (
            <>
              <p style={{ ...lbl, marginBottom: 8 }}>
                ⛓️ PET REGISTRY — MASTER VIEW
              </p>
              {petList.map((pet) => (
                <div
                  key={pet.id}
                  style={{
                    ...card,
                    padding: 13,
                    marginBottom: 8,
                    borderLeft: `3px solid #8b0000`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      marginBottom: 10,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 20,
                        border: "2px solid #8b0000",
                        borderRadius: "50%",
                        width: 36,
                        height: 36,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: T.tag,
                      }}
                    >
                      {pet.pic}
                    </span>
                    <div>
                      <p
                        style={{ fontSize: 13, fontWeight: 600, color: T.text }}
                      >
                        {pet.un}
                      </p>
                      <p style={{ fontSize: 11, color: T.muted }}>
                        {pet.collarType} · {pet.usageToday}× today
                      </p>
                    </div>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        padding: "2px 7px",
                        background: `${
                          pet.petType === "fighting"
                            ? "rgba(139,0,0,.2)"
                            : pet.petType === "broken"
                            ? "rgba(80,0,0,.3)"
                            : "rgba(100,0,0,.15)"
                        }`,
                        color:
                          pet.petType === "fighting" ? "#cc4444" : "#8b1414",
                        borderRadius: 3,
                      }}
                    >
                      {pet.petType?.toUpperCase()}
                    </span>
                  </div>
                  {[
                    ["Sensitivity", pet.sensitivity, "#c84040"],
                    ["Broken Level", pet.broken, "#8b0000"],
                    ["Obedience", pet.obedience, "#9944cc"],
                    ["Freedom Progress", pet.freedom, "#4a7a9b"],
                  ].map(([l, v, c]) => (
                    <div key={l} style={{ marginBottom: 6 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 2,
                        }}
                      >
                        <span style={{ ...lbl }}>{l}</span>
                        <span style={{ fontSize: 10, color: c }}>{v}%</span>
                      </div>
                      <div
                        style={{
                          height: 4,
                          background: T.tag,
                          borderRadius: 2,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${v}%`,
                            height: "100%",
                            background: c,
                            borderRadius: 2,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      className="b"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        viewProf(pet.id);
                      }}
                      style={{
                        ...btn(false),
                        padding: "6px 10px",
                        fontSize: 11,
                        flex: 1,
                      }}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      className="b"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toast("Freedom report: DENIED.");
                      }}
                      style={{
                        padding: "6px 10px",
                        background: "rgba(139,0,0,.15)",
                        border: "1px solid #4a0000",
                        color: "#8b0000",
                        borderRadius: 6,
                        fontSize: 11,
                        flex: 1,
                        fontFamily: "'Cinzel',serif",
                      }}
                    >
                      Deny Freedom
                    </button>
                    <button
                      type="button"
                      className="b"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toast("Pet loaned. Terms sent.");
                      }}
                      style={{
                        ...btn(false),
                        padding: "6px 10px",
                        fontSize: 11,
                        flex: 1,
                      }}
                    >
                      Loan
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* My bid records */}
          {isMe && myBids.length > 0 && (
            <>
              <p style={{ ...lbl, marginBottom: 8 }}>MY BID RECORDS</p>
              <div style={{ ...card, padding: 14, marginBottom: 10 }}>
                {myBids.map((b, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "7px 0",
                      borderBottom: `1px solid ${T.border}`,
                    }}
                  >
                    <div>
                      <p style={{ fontSize: 13, color: T.text }}>{b.lot}</p>
                      <p style={{ fontSize: 11, color: T.muted }}>{b.time}</p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p
                        style={{
                          fontFamily: "'Cinzel',serif",
                          fontSize: 13,
                          color: T.primary,
                        }}
                      >
                        ${b.amount?.toLocaleString()}
                      </p>
                      <span style={{ fontSize: 10, color: T.muted }}>
                        {b.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {isMe && (() => {
            const myOwnedPets = Object.values(ACCTS).filter((u: any) => u.masterId === uid);
            if (!myOwnedPets.length) return null;
            return (
              <div style={{ ...card, padding: 13, marginBottom: 12, border: "1px solid #3a0000" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <p style={{ ...lbl, color: "#8b0000" }}>🔒 MY PETS ({myOwnedPets.length})</p>
                  <button className="b" onClick={() => setNav("university")}
                    style={{ fontSize: 11, color: "#cc4400", background: "none", border: "1px solid #3a1500", borderRadius: 5, padding: "4px 10px", cursor: "pointer" }}>
                    MANAGE PETS →
                  </button>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                  {(myOwnedPets as any[]).map((p: any) => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, background: "#1a0000", border: "1px solid #2a0000", borderRadius: 6, padding: "4px 8px" }}>
                      <span style={{ fontSize: 16 }}>{p.pic || "🔒"}</span>
                      <span style={{ fontSize: 11, color: "#8b4444" }}>{p.name || p.id}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          <p style={{ ...lbl, marginBottom: 8, color: isViiProf ? "#48cae4" : undefined, textShadow: isViiProf ? "0 0 8px rgba(3,176,211,.3)" : undefined, letterSpacing: isViiProf ? "0.12em" : undefined }}>
            {isViiProf ? "♟ DISPATCHES" : `POSTS (${myPosts.length})`}{isViiProf ? ` (${myPosts.length})` : ""}
          </p>
          {myPosts.length === 0 && (
            <p style={{ ...sub, textAlign: "center", padding: "16px 0", color: isViiProf ? "#48cae4" : undefined, fontFamily: isViiProf ? "'Cormorant Garamond',serif" : undefined, fontStyle: isViiProf ? "italic" : undefined }}>
              {isViiProf ? "Nothing disclosed. The board is set." : "No posts yet."}
            </p>
          )}
          {myPosts.map((p, i) => (
            <PostCard
              key={p.id}
              post={p}
              idx={i}
              T={PT}
              user={user}
              uid={uid}
              ACCTS_REF={ACCTS}
              react={react}
              delPost={delPost}
              delC={delC}
              viewProf={viewProf}
              pushPosts={pushPosts}
              setPosts={setPosts}
              EMOJIS={EMOJIS}
              inp={profInp}
              card={profCard}
              lbl={lbl}
              bdg={bdg}
              framedAvatar={framedAvatar}
              getFrame={getFrame}
            />
          ))}
          {isMe && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="b" onClick={() => setNav("settings")} style={{ ...btn(false), flex: 1, padding: "10px", fontSize: 12 }}>⚙️ SETTINGS</button>
              <button className="b" onClick={() => { setUid(null); setScreen("login"); }} style={{ ...btn(false), flex: 1, padding: "10px", fontSize: 12, borderColor: T.danger, color: T.danger }}>SIGN OUT</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // UNIVERSITY PORTAL (separate from Explore)
  // ═══════════════════════════════════════════════════════
  // ── ACADEMICS PAGE ──
  const AcademicsPage = () => {
    const lvl = getXPLevel(userXP);
    const nextXP = lvl.next;
    const selClass = acSelClass;
    const setSelClass = setAcSelClass;
    const classView = acClassView;
    const setClassView = setAcClassView;
    const activeQuiz = acActiveQuiz;
    const setActiveQuiz = setAcActiveQuiz;
    const quizAnswered = acQuizAnswered;
    const setQuizAnswered = setAcQuizAnswered;

    const cls = selClass ? CLASSES.find(c => c.id === selClass) : null;
    const isEnrolled = (id: string) => enrolledClasses.includes(id);

    if (cls) {
      const lessonsDone = cls.lessons.filter(l => completedLessons.includes(`${cls.id}:${l.id}`)).length;
      const quizDone = cls.quiz.filter((q, qi) => completedClassQuizzes.includes(`${cls.id}:q${qi}`)).length;
      return (
        <div>
          <div style={hdr}>
            <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", gap: 10 }}>
              <button type="button" className="b" onClick={() => setSelClass(null)} style={{ background: "transparent", border: "none", color: T.primary, fontSize: 18, cursor: "pointer" }}>←</button>
              <span style={{ fontSize: 20, marginRight: 4 }}>{cls.icon}</span>
              <span style={ttl()}>{cls.name}</span>
            </div>
          </div>
          <div style={sec}>
            <div style={{ ...card, padding: 14, marginBottom: 12 }}>
              <p style={{ fontSize: 12, color: T.muted, marginBottom: 6 }}>{cls.major}</p>
              <p style={{ fontSize: 13, color: T.text, marginBottom: 10 }}>{cls.desc}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, textAlign: "center", background: T.tag, borderRadius: 6, padding: 8 }}>
                  <p style={{ fontSize: 18, fontWeight: 700, color: T.primary }}>{lessonsDone}/{cls.lessons.length}</p>
                  <p style={{ fontSize: 11, color: T.muted }}>LESSONS</p>
                </div>
                <div style={{ flex: 1, textAlign: "center", background: T.tag, borderRadius: 6, padding: 8 }}>
                  <p style={{ fontSize: 18, fontWeight: 700, color: T.primary }}>{quizDone}/{cls.quiz.length}</p>
                  <p style={{ fontSize: 11, color: T.muted }}>QUIZZES</p>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {(["lessons","quiz"] as const).map(v => (
                <button key={v} type="button" className="b" onClick={() => setClassView(v)} style={{ ...pill(classView === v), flex: 1, textTransform: "uppercase", fontSize: 12 }}>
                  {v === "lessons" ? "📖 Lessons" : "📝 Quizzes"}
                </button>
              ))}
            </div>

            {classView === "lessons" && cls.lessons.map((l, idx) => {
              const key = `${cls.id}:${l.id}`;
              const done = completedLessons.includes(key);
              return (
                <div key={key} style={{ ...card, padding: 14, marginBottom: 8, borderLeft: `3px solid ${done ? T.primary : T.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                    <p style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", fontSize: 15, color: T.text, flex: 1 }}>{idx+1}. {l.title}</p>
                    {done && <span style={{ color: T.primary, fontSize: 13, marginLeft: 8 }}>✓</span>}
                  </div>
                  <p style={{ fontSize: 12, color: T.muted, lineHeight: 1.6, marginBottom: 10 }}>{l.content}</p>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: T.muted }}>+{l.xp} XP · +₦{l.money}</span>
                    {!done && (
                      <button type="button" className="b" onClick={() => markLesson(key, l.xp, l.money)}
                        style={{ ...btn(true), padding: "6px 14px", fontSize: 11 }}>
                        Complete Lesson
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {classView === "quiz" && cls.quiz.map((q, qi) => {
              const qKey = `${cls.id}:q${qi}`;
              const done = completedClassQuizzes.includes(qKey);
              const isActive = activeQuiz === qi;
              return (
                <div key={qKey} style={{ ...card, padding: 14, marginBottom: 8, borderLeft: `3px solid ${done ? T.primary : T.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: done || isActive ? 10 : 0 }}>
                    <p style={{ fontFamily: "'IM Fell English',serif", fontStyle: "italic", fontSize: 14, color: T.text, flex: 1 }}>Q{qi+1}: {q.q}</p>
                    {done && <span style={{ color: T.primary, fontSize: 13, marginLeft: 8 }}>✓</span>}
                  </div>
                  {!done && !isActive && (
                    <button type="button" className="b" onClick={() => { setActiveQuiz(qi); setQuizAnswered(null); }}
                      style={{ ...btn(false), padding: "6px 14px", fontSize: 11, marginTop: 8 }}>
                      Answer
                    </button>
                  )}
                  {!done && isActive && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {q.opts.map((opt, oi) => {
                        const chosen = quizAnswered === oi;
                        const isCorrect = oi === q.correct;
                        const showResult = quizAnswered !== null;
                        return (
                          <button key={oi} type="button" className="b"
                            onClick={() => {
                              if (quizAnswered !== null) return;
                              setQuizAnswered(oi);
                              if (oi === q.correct) markClassQuiz(qKey, q.xp, q.money);
                              else toast(`✗ Incorrect. Correct: "${q.opts[q.correct]}"`);
                            }}
                            style={{
                              padding: "9px 12px", borderRadius: 6, fontSize: 13, textAlign: "left",
                              background: showResult ? (isCorrect ? "rgba(0,200,100,.15)" : chosen ? "rgba(200,0,0,.1)" : T.tag) : T.tag,
                              border: `1px solid ${showResult ? (isCorrect ? "#00c864" : chosen ? "#cc3333" : T.border) : T.border}`,
                              color: T.text, cursor: quizAnswered === null ? "pointer" : "default",
                            }}>
                            {opt}
                          </button>
                        );
                      })}
                      {quizAnswered !== null && (
                        <p style={{ fontSize: 12, color: quizAnswered === q.correct ? T.primary : "#cc4444", marginTop: 4 }}>
                          {quizAnswered === q.correct ? `✓ Correct! +${q.xp} XP earned` : `✗ Incorrect. Correct answer: "${q.opts[q.correct]}"`}
                        </p>
                      )}
                    </div>
                  )}
                  {done && <p style={{ fontSize: 11, color: T.muted }}>+{q.xp} XP · +₦{q.money} earned</p>}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    // Classes list view
    const myMajor = user?.major || "";
    const related = CLASSES.filter(c => c.major === myMajor || enrolledClasses.includes(c.id));

    return (
      <div>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" className="b" onClick={() => go("university")} style={{ background: "transparent", border: "none", color: T.primary, fontSize: 18, cursor: "pointer" }}>←</button>
            <span style={ttl()}>📚 ACADEMICS</span>
          </div>
        </div>
        <div style={sec}>
          {/* XP Level Bar */}
          <div style={{ ...card, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <span style={{ fontSize: 20 }}>{lvl.icon}</span>
                <span style={{ fontFamily: "'Cinzel',serif", fontSize: 14, color: T.primary, marginLeft: 8 }}>{lvl.label.toUpperCase()}</span>
              </div>
              <span style={{ fontSize: 12, color: T.muted }}>{userXP.toLocaleString()} XP</span>
            </div>
            <div style={{ height: 6, background: T.tag, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, lvl.progress * 100)}%`, height: "100%", background: `linear-gradient(90deg,${T.primary},${T.accent})`, transition: "width .6s" }} />
            </div>
            {nextXP && <p style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{(nextXP - userXP).toLocaleString()} XP to next level</p>}
          </div>

          {related.length > 0 && (
            <>
              <p style={{ ...lbl, marginBottom: 8 }}>YOUR CLASSES</p>
              {related.map(cls => {
                const enrolled = isEnrolled(cls.id);
                const lessonsDone = cls.lessons.filter(l => completedLessons.includes(`${cls.id}:${l.id}`)).length;
                const quizDone = cls.quiz.filter((q, qi) => completedClassQuizzes.includes(`${cls.id}:q${qi}`)).length;
                return (
                  <div key={cls.id} style={{ ...card, padding: 14, marginBottom: 10, borderLeft: `3px solid ${cls.color}` }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 24 }}>{cls.icon}</span>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: T.text, marginBottom: 2 }}>{cls.name}</p>
                        <p style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>{cls.major}</p>
                        {enrolled && (
                          <div style={{ display: "flex", gap: 12, fontSize: 11, color: T.muted, marginBottom: 8 }}>
                            <span>📖 {lessonsDone}/{cls.lessons.length} lessons</span>
                            <span>📝 {quizDone}/{cls.quiz.length} quizzes</span>
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 8 }}>
                          {!enrolled ? (
                            <button type="button" className="b" onClick={() => { enrollClass(cls.id); toast(`Enrolled in ${cls.name}`); }}
                              style={{ ...btn(true), padding: "6px 14px", fontSize: 11 }}>
                              Enroll
                            </button>
                          ) : (
                            <button type="button" className="b" onClick={() => setSelClass(cls.id)}
                              style={{ ...btn(true), padding: "6px 14px", fontSize: 11 }}>
                              Open Class
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {related.length === 0 && (
            <div style={{ ...card, padding: 20, textAlign: "center" }}>
              <p style={{ fontSize: 20, marginBottom: 8 }}>📚</p>
              <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: T.muted }}>No classes available for your major yet.</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── JOB SYSTEM VIEW ──
  const JobsPage = () => {
    const myMajor = user?.major || "General";
    const JOBS: Record<string, {title:string;rate:number;desc:string;icon:string}[]> = {
      "Law": [{title:"Law Clerk",rate:800,desc:"Review case files and assist senior counsel.",icon:"⚖️"},{title:"Court Liaison",rate:1200,desc:"Coordinate between chambers and clients.",icon:"📜"},{title:"Research Analyst",rate:1000,desc:"Legal research and document drafting.",icon:"🔍"}],
      "Medicine": [{title:"Lab Assistant",rate:900,desc:"Support research teams in the medical lab.",icon:"🧪"},{title:"Clinical Observer",rate:1100,desc:"Shadow physicians in the hospital ward.",icon:"🏥"},{title:"Pharmacist's Aide",rate:850,desc:"Inventory and dispensing support.",icon:"💊"}],
      "Business": [{title:"Market Research Intern",rate:750,desc:"Collect and analyze market data.",icon:"📊"},{title:"Finance Assistant",rate:1000,desc:"Support portfolio management tasks.",icon:"💼"},{title:"Brand Strategist Jr.",rate:900,desc:"Assist in brand campaigns.",icon:"📣"}],
      "Politics": [{title:"Campaign Volunteer",rate:600,desc:"Door-to-door and phone canvassing.",icon:"🗳️"},{title:"Policy Researcher",rate:950,desc:"Draft policy briefs for senators.",icon:"📋"},{title:"Speechwriter Aide",rate:1100,desc:"Research and draft talking points.",icon:"🎤"}],
      "Technology": [{title:"Code Review Analyst",rate:1050,desc:"Review pull requests for quality.",icon:"💻"},{title:"QA Tester",rate:850,desc:"Test software builds for bugs.",icon:"🧪"},{title:"Data Entry Specialist",rate:700,desc:"Maintain databases and records.",icon:"📂"}],
      "Arts": [{title:"Gallery Curator Jr.",rate:700,desc:"Assist in exhibitions and cataloguing.",icon:"🖼️"},{title:"Studio Assistant",rate:650,desc:"Support lead artists in their work.",icon:"🎨"},{title:"Event Designer",rate:800,desc:"Plan and design cultural events.",icon:"🎭"}],
      "General": [{title:"Library Assistant",rate:600,desc:"Organise stacks and assist students.",icon:"📚"},{title:"Campus Tour Guide",rate:550,desc:"Lead prospective student tours.",icon:"🏛️"},{title:"Administrative Aid",rate:700,desc:"Support departmental admin tasks.",icon:"📁"}],
    };
    const majorJobs = JOBS[myMajor] || JOBS["General"];
    const MAX_HOURS = 20;
    const hoursLeft = Math.max(0, MAX_HOURS - jobHoursThisWeek);

    const doWork = (job: typeof majorJobs[0]) => {
      if(jobWorking) return;
      if(hoursLeft<=0){toast("⚠️ Weekly limit reached (20hrs). Rest and come back next week.");return;}
      setJobWorking(true); setJobProgress(0); setJobBonusEvent(null);
      const EVENTS=["A colleague shares valuable contacts — Influence +25!","The supervisor is impressed — bonus incoming!","Routine shift. No surprises.","Discovered a lucrative lead — ₦+500 bonus!"];
      const ev=EVENTS[Math.floor(Math.random()*EVENTS.length)];
      const iv=setInterval(()=>{
        setJobProgress(p=>{if(p>=100){clearInterval(iv);return 100;}return p+5;});
      },100);
      setTimeout(()=>{
        clearInterval(iv);
        setJobProgress(100);
        setJobWorking(false);
        setJobBonusEvent(ev);
        const earned=job.rate+(ev.includes("bonus")?(ev.includes("₦+500")?500:250):0);
        const newHours=Math.min(MAX_HOURS,jobHoursThisWeek+2);
        setJobHoursThisWeek(newHours);
        try{const d=JSON.parse(localStorage.getItem("umbra_job_hours")||"{}");d[uid]={hours:newHours,ts:Date.now()};localStorage.setItem("umbra_job_hours",JSON.stringify(d));}catch{}
        setWalletBalance(b=>{const nb=b+earned;try{const d=JSON.parse(localStorage.getItem("umbra_wallets")||"{}");d[uid]=nb;localStorage.setItem("umbra_wallets",JSON.stringify(d));}catch{}return nb;});
        if(ev.includes("Influence")) addInfluence(25);
        addXP(150);
        toast(`✅ Shift complete! +₦${earned.toLocaleString()} · +150 XP`);
        if(jobHoursThisWeek+2>=MAX_HOURS) unlockAchievement("workaholic","Workaholic",{money:5000,influence:50,xp:300});
        if(!userAchievements.includes("first_job")) unlockAchievement("first_job","First Day on the Job",{money:1000,influence:10,xp:100});
      },2200);
    };

    return (
      <div style={{paddingBottom:80}}>
        <div style={hdr}>
          <div style={{maxWidth:600,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
            <button type="button" className="b" onClick={()=>go("university")} style={{background:"transparent",border:"none",color:T.primary,fontSize:18,cursor:"pointer"}}>←</button>
            <span style={ttl()}>💼 JOB BOARD</span>
          </div>
        </div>
        <div style={{...sec,maxWidth:600,margin:"0 auto"}}>
          <div style={{...card,padding:14,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div><p style={lbl}>WEEKLY HOURS</p><p style={{fontSize:11,color:T.muted}}>{jobHoursThisWeek}/20 hrs · {hoursLeft} remaining</p></div>
              <div style={{textAlign:"right"}}><p style={lbl}>CURRENT BALANCE</p><p style={{fontSize:14,color:T.primary,fontWeight:700}}>₦{walletBalance.toLocaleString()}</p></div>
            </div>
            <div style={{height:6,borderRadius:3,background:T.border,marginTop:8}}>
              <div style={{height:"100%",borderRadius:3,background:T.primary,width:`${(jobHoursThisWeek/MAX_HOURS)*100}%`,transition:"width 0.3s"}} />
            </div>
            <p style={{fontSize:10,color:T.muted,marginTop:4}}>Max 20 hours/week. Each shift = 2 hours.</p>
          </div>

          {jobBonusEvent&&<div style={{...card,padding:12,marginBottom:12,borderLeft:`3px solid ${T.primary}`}}>
            <p style={{fontSize:12,color:T.primary,fontStyle:"italic"}}>📋 {jobBonusEvent}</p>
          </div>}

          {jobWorking&&<div style={{...card,padding:14,marginBottom:12,textAlign:"center"}}>
            <p style={{...lbl,marginBottom:8}}>WORKING SHIFT...</p>
            <div style={{height:8,borderRadius:4,background:T.border,margin:"0 auto",maxWidth:300}}>
              <div style={{height:"100%",borderRadius:4,background:T.primary,width:`${jobProgress}%`,transition:"width 0.1s"}} />
            </div>
            <p style={{fontSize:11,color:T.muted,marginTop:8}}>{jobProgress}% complete</p>
          </div>}

          <p style={{...lbl,marginBottom:8}}>AVAILABLE POSITIONS — {myMajor.toUpperCase()}</p>
          {majorJobs.map((j,i)=>(
            <div key={i} style={{...card,padding:14,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <span style={{fontSize:24}}>{j.icon}</span>
                  <div>
                    <p style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.text,fontWeight:700}}>{j.title}</p>
                    <p style={{fontSize:11,color:T.muted,fontStyle:"italic"}}>{j.desc}</p>
                  </div>
                </div>
                <p style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.primary,fontWeight:700,flexShrink:0}}>₦{j.rate}/shift</p>
              </div>
              <button type="button" className="b" onClick={()=>doWork(j)}
                disabled={jobWorking||hoursLeft<=0}
                style={{...btn(!jobWorking&&hoursLeft>0),width:"100%",padding:"10px",fontSize:12,opacity:jobWorking||hoursLeft<=0?0.5:1}}>
                {jobWorking?"WORKING...":hoursLeft<=0?"WEEKLY LIMIT REACHED":"TAKE SHIFT (+2 hrs)"}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── ACHIEVEMENTS VIEW ──
  const ACHIEVEMENT_DEFS = [
    {id:"first_post",name:"First Voice",desc:"Post your first feed update.",icon:"🌙",reward:{xp:100,money:500,influence:5}},
    {id:"first_job",name:"First Day on the Job",desc:"Complete your first work shift.",icon:"💼",reward:{xp:100,money:1000,influence:10}},
    {id:"workaholic",name:"Workaholic",desc:"Hit your weekly 20hr work limit.",icon:"⏰",reward:{xp:300,money:5000,influence:50}},
    {id:"casino_jackpot",name:"Casino Jackpot",desc:"Hit a 5× or higher multiplier in the casino.",icon:"🎰",reward:{xp:500,money:0,influence:100}},
    {id:"casino_shark",name:"Casino Shark",desc:"Win 10 or more casino games.",icon:"🦈",reward:{xp:200,money:50000,influence:200}},
    {id:"class_first",name:"First Scholar",desc:"Enroll in your first class.",icon:"📚",reward:{xp:50,money:500,influence:5}},
    {id:"quiz_ace",name:"Quiz Ace",desc:"Complete 5 class quizzes.",icon:"✅",reward:{xp:300,money:2000,influence:20}},
    {id:"club_joiner",name:"Society Member",desc:"Join your first club or society.",icon:"🏛️",reward:{xp:100,money:1000,influence:15}},
    {id:"social_butterfly",name:"Social Butterfly",desc:"Send 10 messages to other students.",icon:"🦋",reward:{xp:150,money:2000,influence:25}},
    {id:"rumour_starter",name:"Rumour Starter",desc:"Spread your first rumour.",icon:"🗣️",reward:{xp:100,money:0,influence:30}},
    {id:"influence_100",name:"Rising Star",desc:"Reach 100 Influence points.",icon:"⭐",reward:{xp:200,money:5000,influence:0}},
    {id:"influence_500",name:"Campus Icon",desc:"Reach 500 Influence points.",icon:"👑",reward:{xp:500,money:15000,influence:0}},
    {id:"influence_1000",name:"Noctis Legend",desc:"Reach 1000 Influence points.",icon:"🌑",reward:{xp:1000,money:50000,influence:0}},
    {id:"wallet_100k",name:"Centimillionaire",desc:"Accumulate ₦100,000.",icon:"💰",reward:{xp:300,money:0,influence:50}},
    {id:"wallet_1m",name:"Millionaire",desc:"Accumulate ₦1,000,000.",icon:"💎",reward:{xp:1000,money:0,influence:200}},
    {id:"rock_bottom",name:"Rock Bottom",desc:"Reach ₦0. The institution watched, unmoved.",icon:"💀",reward:{xp:50,money:0,influence:0}},
    {id:"twice_ruined",name:"Twice Ruined",desc:"Go bankrupt more than once. Some lessons aren't learned.",icon:"🕯️",reward:{xp:100,money:0,influence:0}},
    {id:"daily_7",name:"Devoted Attendee",desc:"Claim 7 daily login rewards in a row.",icon:"📅",reward:{xp:200,money:3000,influence:30}},
    {id:"pet_owner",name:"Master",desc:"Acquire your first pet.",icon:"🔗",reward:{xp:300,money:10000,influence:75}},
    {id:"dark_shopper",name:"Dark Corridor Regular",desc:"Buy something from the Dark Corridor.",icon:"🕸️",reward:{xp:200,money:0,influence:40}},
    {id:"auction_win",name:"The Highest Bidder",desc:"Win an auction.",icon:"⛓️",reward:{xp:400,money:0,influence:100}},
    {id:"perfect_gpa",name:"Academic Elite",desc:"Score 100% on any class quiz.",icon:"🎓",reward:{xp:500,money:5000,influence:50}},
    {id:"gossip_posted",name:"The Informant",desc:"Generate and share campus gossip.",icon:"📰",reward:{xp:100,money:0,influence:20}},
    {id:"forum_thread",name:"Discourse Leader",desc:"Create a Forum discussion thread.",icon:"📋",reward:{xp:100,money:500,influence:10}},
    {id:"gift_sent",name:"Generous Soul",desc:"Send a gift to another student.",icon:"🎁",reward:{xp:100,money:0,influence:15}},
    {id:"profile_complete",name:"Fully Introduced",desc:"Complete your full profile.",icon:"👤",reward:{xp:200,money:1000,influence:20}},
    {id:"explored_noctis",name:"Cartographer",desc:"Visit every section of Noctis University.",icon:"🗺️",reward:{xp:300,money:2000,influence:25}},
  ];
  const AchievementsPage = () => {
    const earned = ACHIEVEMENT_DEFS.filter(a=>userAchievements.includes(a.id));
    const pending = ACHIEVEMENT_DEFS.filter(a=>!userAchievements.includes(a.id));
    return (
      <div style={{paddingBottom:80}}>
        <div style={hdr}>
          <div style={{maxWidth:600,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
            <button type="button" className="b" onClick={()=>go("university")} style={{background:"transparent",border:"none",color:T.primary,fontSize:18,cursor:"pointer"}}>←</button>
            <span style={ttl()}>🏅 ACHIEVEMENTS</span>
          </div>
        </div>
        <div style={{...sec,maxWidth:600,margin:"0 auto"}}>
          <div style={{...card,padding:14,marginBottom:12,textAlign:"center"}}>
            <p style={{fontSize:32,marginBottom:4}}>🏅</p>
            <p style={{fontFamily:"'Cinzel',serif",fontSize:18,color:T.primary,fontWeight:700}}>{earned.length}/{ACHIEVEMENT_DEFS.length}</p>
            <p style={{fontSize:11,color:T.muted}}>Achievements Unlocked</p>
            <div style={{height:6,borderRadius:3,background:T.border,marginTop:10}}>
              <div style={{height:"100%",borderRadius:3,background:T.primary,width:`${(earned.length/ACHIEVEMENT_DEFS.length)*100}%`,transition:"width 0.3s"}} />
            </div>
          </div>

          {earned.length>0&&<>
            <p style={{...lbl,marginBottom:8}}>UNLOCKED ({earned.length})</p>
            {earned.map(a=>(
              <div key={a.id} style={{...card,padding:14,marginBottom:8,borderLeft:`3px solid ${T.primary}`}}>
                <div style={{display:"flex",gap:12,alignItems:"center"}}>
                  <span style={{fontSize:28}}>{a.icon}</span>
                  <div>
                    <p style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.primary,fontWeight:700,marginBottom:2}}>{a.name}</p>
                    <p style={{fontSize:11,color:T.muted}}>{a.desc}</p>
                    <p style={{fontSize:10,color:T.muted,marginTop:3}}>+{a.reward.xp} XP · +₦{a.reward.money.toLocaleString()} · +{a.reward.influence} INF</p>
                  </div>
                </div>
              </div>
            ))}
          </>}

          <p style={{...lbl,marginBottom:8,marginTop:14}}>LOCKED ({pending.length})</p>
          {pending.map(a=>(
            <div key={a.id} style={{...card,padding:14,marginBottom:8,opacity:0.5}}>
              <div style={{display:"flex",gap:12,alignItems:"center"}}>
                <span style={{fontSize:28,filter:"grayscale(1)"}}>{a.icon}</span>
                <div>
                  <p style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.muted,fontWeight:700,marginBottom:2}}>{a.name}</p>
                  <p style={{fontSize:11,color:T.muted}}>{a.desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── LEADERBOARD VIEW ──
  const LeaderboardPage = () => {
    // All hooks lifted to parent — NO hooks here (fixes "rendered more hooks" error)
    const covenantColor = (cov: string) => {
      if (cov==="crowns") return "#ffd700";
      if (cov==="silk") return "#c084fc";
      if (cov==="shadows") return "#60a5fa";
      return T.muted;
    };
    const tierBadge = (tier: string) => {
      if (tier==="apex") return { label:"APEX", bg:"#7c3aed", color:"#fff" };
      if (tier==="ascendant") return { label:"ASCENDANT", bg:"#1d4ed8", color:"#fff" };
      return { label:"MERIT", bg:"#374151", color:"#9ca3af" };
    };
    const medalFor = (i: number) => i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`;

    // Combine real users from API with NPC accounts for a full leaderboard
    // NPCs have HIGH seniority scores — they've been at Noctis longer than new students
    const npcEntries = Object.entries(ACCTS)
      .filter(([id]:any) => id !== uid && !(ACCTS[id] as any)?.isNpc_bully)
      .map(([id,u]:any) => {
        const tier = u.tier || "merit";
        const followers = u.followers || u.gaze || 0;
        return {
          id,
          username: u.un || u.name || id,
          avatar: u.pic || u.avatar || "🌑",
          covenant: u.cov || "shadows",
          tier,
          major: u.major || "Undeclared",
          posts: 15 + (npcHash(id + "p") % 80),
          comments: 30 + (npcHash(id + "c") % 150),
          reputation: npcReputation(id, tier, followers),
          wealth: npcWealth(id, tier),
          xp: npcXp(id, tier),
          isNpc: true,
        };
      });

    // Merge: DB users (real + seeded NPCs) come from lbData; append any ACCTS entries
    // not already represented in DB so nothing is missing.
    const realIds = new Set(lbData.map((u:any)=>u.id));
    let merged = [
      ...lbData.map((u:any)=>({...u, isNpc: !((ACCTS as any)[u.id]?._real)})),
      ...npcEntries.filter((n:any)=>!realIds.has(n.id)),
    ];

    // Always ensure current user appears with their REAL wallet and influence values
    if (uid && user) {
      const myInfluence = (() => { try { return JSON.parse(localStorage.getItem("umbra_influence")||"{}")[uid] ?? 0; } catch { return 0; } })();
      const myXp = (() => { try { return JSON.parse(localStorage.getItem("umbra_xp")||"{}")[uid] ?? 0; } catch { return 0; } })();
      const myPosts = (() => { try { const p = localStorage.getItem("umbra_post_count"); return p ? parseInt(p) : posts.filter((p:any)=>p.uid===uid).length; } catch { return posts.filter((p:any)=>p.uid===uid).length; } })();
      const myEntry = {
        id: uid,
        username: (user as any).un || uid,
        avatar: (user as any).pic || "🌑",
        covenant: (user as any).cov || "shadows",
        tier: (user as any).tier || "merit",
        major: (user as any).major || "Undeclared",
        posts: myPosts,
        comments: 0,
        reputation: myInfluence,
        wealth: walletBalance,
        xp: myXp,
        isNpc: false,
        isMe: true,
      };
      const existingIdx = merged.findIndex((u:any) => u.id === uid);
      if (existingIdx >= 0) {
        merged[existingIdx] = { ...merged[existingIdx], ...myEntry };
      } else {
        merged = [myEntry, ...merged];
      }
    }

    const sortKey = lbTab==="reputation"?"reputation":lbTab==="wealth"?"wealth":lbTab==="posts"?"posts":"xp";
    const sorted = [...merged].sort((a:any,b:any)=>b[sortKey]-a[sortKey]);
    const myRank = sorted.findIndex((u:any)=>u.id===uid)+1;

    const tabCfg: Array<{key:"reputation"|"wealth"|"xp"|"posts", label:string, icon:string}> = [
      {key:"reputation", label:"REPUTATION", icon:"⭐"},
      {key:"wealth", label:"WEALTH", icon:"💰"},
      {key:"xp", label:"XP", icon:"🎓"},
      {key:"posts", label:"POSTS", icon:"📝"},
    ];

    return (
      <div style={{paddingBottom:80}}>
        <div style={hdr}>
          <div style={{maxWidth:600,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
            <button type="button" className="b" onClick={()=>go("university")} style={{background:"transparent",border:"none",color:T.primary,fontSize:18,cursor:"pointer"}}>←</button>
            <span style={ttl()}>🏆 LEADERBOARD</span>
            <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
              {lbLoading && <span style={{fontSize:10,color:T.muted,fontStyle:"italic"}}>updating…</span>}
              <button type="button" className="b" onClick={fetchLeaderboard}
                style={{background:"none",border:`1px solid ${T.border}`,borderRadius:6,padding:"4px 8px",color:T.muted,fontSize:10,cursor:"pointer"}}>
                ↻
              </button>
            </div>
          </div>
        </div>
        <div style={{...sec,maxWidth:600,margin:"0 auto"}}>
          {/* Your rank card */}
          {myRank>0 && uid && (
            <div style={{...card,padding:14,marginBottom:14,textAlign:"center" as const,borderLeft:`3px solid ${T.primary}`,background:`${T.primary}11`}}>
              <p style={{fontSize:10,color:T.muted,letterSpacing:"0.1em"}}>YOUR STANDING</p>
              <p style={{fontFamily:"'Cinzel',serif",fontSize:28,color:T.primary,fontWeight:700,lineHeight:1.1}}>
                {medalFor(myRank-1)}
              </p>
              <p style={{fontSize:12,color:T.muted,marginTop:2}}>
                Rank {myRank} of {sorted.length} · {tabCfg.find(t=>t.key===lbTab)?.icon} {sortKey.toUpperCase()}
              </p>
            </div>
          )}

          {/* Tab bar */}
          <div style={{display:"flex",gap:5,marginBottom:14,overflowX:"auto" as const}}>
            {tabCfg.map(t=>(
              <button key={t.key} type="button" className="b" onClick={()=>setLbTab(t.key)}
                style={{...btn(lbTab===t.key),flex:1,padding:"8px 4px",fontSize:10,whiteSpace:"nowrap" as const,minWidth:60}}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* Updated at */}
          {lbUpdatedAt && (
            <p style={{fontSize:10,color:T.muted,marginBottom:10,textAlign:"right" as const,fontStyle:"italic"}}>
              ↻ updates every hour · {sorted.length} total
            </p>
          )}

          {/* Leaderboard entries — ALL of them */}
          {sorted.map((u:any,i:number)=>{
            const tb = tierBadge(u.tier||"merit");
            const isMe = u.id===uid;
            const value = lbTab==="wealth"?"₦"+(u.wealth||0).toLocaleString():
              lbTab==="posts"?(u.posts||0)+" posts":
              lbTab==="xp"?(u.xp||0).toLocaleString()+" XP":
              (u.reputation||0).toLocaleString()+" rep";
            // Safe avatar render — emoji, image URL, or data URI
            const avatarStr: string = u.avatar || "🌑";
            const isImgAvatar = avatarStr.startsWith("http") || avatarStr.startsWith("/") || avatarStr.startsWith("data:");
            return (
              <div key={u.id} style={{
                ...card,padding:"12px 14px",marginBottom:8,
                borderLeft:isMe?`3px solid ${T.primary}`:i<3?`3px solid ${covenantColor(u.covenant||"shadows")}`:"none",
                background:i===0?"#ffd70011":i===1?"#c0c0c011":i===2?"#cd7f3211":isMe?`${T.primary}11`:T.card,
              }}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{
                    fontSize:i<3?20:13,fontWeight:700,
                    color:i===0?"#ffd700":i===1?"#c0c0c0":i===2?"#cd7f32":T.muted,
                    minWidth:32,textAlign:"center" as const,fontFamily:"'Cinzel',serif"
                  }}>{medalFor(i)}</span>
                  {isImgAvatar
                    ? <img src={avatarStr} alt="" style={{width:32,height:32,borderRadius:"50%",objectFit:"cover",flexShrink:0}} />
                    : <span style={{fontSize:22}}>{avatarStr}</span>
                  }
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                      <p style={{fontSize:13,fontWeight:700,color:isMe?T.primary:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" as const}}>
                        {u.username}{isMe?" (you)":""}
                      </p>
                      <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.06em",padding:"1px 5px",borderRadius:3,background:tb.bg,color:tb.color}}>{tb.label}</span>
                    </div>
                    <p style={{fontSize:10,color:covenantColor(u.covenant||"shadows")}}>
                      {(u.covenant||"shadows").toUpperCase()} · {u.major||"Undeclared"}
                      {!u.isNpc && <span style={{color:T.primary,marginLeft:4}}>· registered</span>}
                    </p>
                  </div>
                  <div style={{textAlign:"right" as const,flexShrink:0}}>
                    <p style={{fontFamily:"'Cinzel',serif",fontSize:15,color:i<3?T.primary:T.text,fontWeight:700}}>{value}</p>
                    {lbTab==="reputation" && (
                      <p style={{fontSize:10,color:T.muted}}>{u.posts||0}p · {u.comments||0}c</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {sorted.length===0 && !lbLoading && (
            <div style={{...card,padding:24,textAlign:"center" as const}}>
              <p style={{fontSize:24,marginBottom:8}}>📋</p>
              <p style={{color:T.muted,fontStyle:"italic"}}>No rankings yet. Be the first to register.</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── RUMOUR SYSTEM VIEW ──
  const RUMOUR_TEMPLATES: Record<string, string[]> = {
    romantic: [
      "{target} was spotted leaving {prof}'s office at 2am. Draw your own conclusions.",
      "Sources say {target} and {other} share more than just study notes.",
      "{target} apparently cried in the Meridian library over someone from {covenant}.",
      "Rumour has it {target} is secretly seeing someone three years above them.",
    ],
    academic: [
      "{target} hasn't attended a single lecture this semester. Somehow maintaining a B+.",
      "I heard {target} paid for their last assignment. No proof, just... common knowledge.",
      "{target} was caught looking at someone else's screen during the midterm.",
      "Apparently {target}'s thesis was written by an AI. The department knows.",
    ],
    social: [
      "{target} was blacklisted from the Apex Vault gathering last Friday. No one will say why.",
      "Rumour: {target} owes money to someone in Umbra. A lot of money.",
      "{target} was seen crying in the west corridor after the society rankings dropped.",
      "Multiple sources confirm {target} was the one who leaked the Meridian records.",
    ],
    financial: [
      "{target} can't actually afford their lifestyle. The family funds are... dwindling.",
      "I heard {target} sold something in the dark corridor to cover rent. Twice.",
      "{target}'s scholarship is under review. Something about undisclosed income.",
      "Apparently {target} lost ₦200,000 at the casino last week.",
    ],
  };
  const RumoursPage = () => {
    const students=Object.entries(ACCTS).filter(([id]:any)=>id!==uid).map(([id,u]:any)=>({id,name:u.name||u.un||id}));
    const profs=PROFS.map((p:any)=>p.name);
    const covenants=["Meridian","Obsidian","Aurelius","Lux","Umbra"];

    const generateRumour=async (targetId:string,type:string)=>{
      const target=students.find(s=>s.id===targetId);
      if(!target){toast("Select a target first.");return;}
      if(rumourLoading){return;}
      setRumourLoading(true);
      try {
        const targetAcct = (ACCTS as any)[targetId];
        const existingTexts = rumours.slice(0,5).map((r:any)=>r.text);
        const res = await fetch("/api/ai/generate-rumour", {
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body: JSON.stringify({
            targetName: target.name,
            targetCov: targetAcct?.cov || targetAcct?.covenant || "unknown",
            targetMajor: targetAcct?.major || "unknown",
            type,
            spreadBy: (user as any)?.un || "Anonymous",
            spreadByCov: (user as any)?.cov || (user as any)?.covenant || "unknown",
            existingRumours: existingTexts,
          })
        });
        let text = "";
        if (res.ok) {
          const data = await res.json();
          text = data.text?.trim() || "";
        }
        if (!text) {
          // Fallback if AI fails
          text = `${target.name} was seen leaving ${["the Restricted Archives","the Obsidian Hall","the Lower Crypts","Professor Vale's office","the Rooftop Observatory"][Math.floor(Math.random()*5)]} at an hour no one speaks of aloud.`;
        }
        const newRumour={id:`r_${Date.now()}`,text,targetId,targetName:target.name,type,ts:new Date().toLocaleString(),spreadBy:(user as any)?.un||"Anonymous",confirmed:false};
        const next=[newRumour,...rumours].slice(0,50);
        setRumours(next);
        try{localStorage.setItem("umbra_rumours",JSON.stringify(next));}catch{}
        addInfluence(30);
        if(!userAchievements.includes("rumour_starter")) unlockAchievement("rumour_starter","Rumour Starter",{money:0,influence:30,xp:100});
        setShowRumourModal(false);
        toast("🗣️ Rumour spread. Influence +30.");
      } catch {
        toast("The rumour mill is silent tonight. Try again.");
      } finally {
        setRumourLoading(false);
      }
    };

    return (
      <div style={{paddingBottom:80}}>
        <div style={hdr}>
          <div style={{maxWidth:600,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
            <button type="button" className="b" onClick={()=>go("university")} style={{background:"transparent",border:"none",color:T.primary,fontSize:18,cursor:"pointer"}}>←</button>
            <span style={ttl()}>🗣️ RUMOUR MILL</span>
          </div>
        </div>
        <div style={{...sec,maxWidth:600,margin:"0 auto"}}>
          <div style={{...card,padding:14,marginBottom:12}}>
            <p style={{...lbl,marginBottom:4}}>SPREAD A RUMOUR</p>
            <p style={{fontSize:11,color:T.muted,marginBottom:10}}>Target a student. Choose a rumour type. The information… spreads naturally.</p>
            <div style={{marginBottom:8}}>
              <p style={{fontSize:10,color:T.muted,marginBottom:4}}>TARGET STUDENT</p>
              <select value={spreadRumourTarget} onChange={e=>setSpreadRumourTarget(e.target.value)}
                style={{...inp,width:"100%"}}>
                <option value="">-- Select a student --</option>
                {students.slice(0,30).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{marginBottom:10}}>
              <p style={{fontSize:10,color:T.muted,marginBottom:4}}>RUMOUR TYPE</p>
              <div style={{display:"flex",gap:6,flexWrap:"wrap" as const}}>
                {Object.keys(RUMOUR_TEMPLATES).map(t=>(
                  <button key={t} type="button" className="b" onClick={()=>setSpreadRumourType(t)}
                    style={{...btn(spreadRumourType===t),padding:"6px 12px",fontSize:11}}>
                    {t==="romantic"?"💋":t==="academic"?"📚":t==="social"?"🗺️":"💰"} {t.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="b" onClick={()=>generateRumour(spreadRumourTarget,spreadRumourType)}
              disabled={rumourLoading}
              style={{...btn(true),width:"100%",padding:"10px",opacity:rumourLoading?0.6:1}}>
              {rumourLoading ? "⏳ THE MILL TURNS…" : "🗣️ RELEASE RUMOUR (+30 INF)"}
            </button>
          </div>

          <p style={{...lbl,marginBottom:8}}>ACTIVE RUMOURS ({rumours.length})</p>
          {rumours.length===0&&<div style={{...card,padding:20,textAlign:"center"}}>
            <p style={{color:T.muted,fontStyle:"italic",fontFamily:"'IM Fell English',serif"}}>The halls are quiet. For now.</p>
          </div>}
          {rumours.map(r=>(
            <div key={r.id} style={{...card,padding:14,marginBottom:8,borderLeft:`3px solid ${r.type==="romantic"?"#8b0000":r.type==="academic"?"#c4a000":r.type==="social"?"#4a7a9b":"#2a8a4a"}`}}>
              <p style={{fontSize:13,color:T.text,fontFamily:"'IM Fell English',serif",lineHeight:1.6,marginBottom:8}}>{r.text}</p>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:10,color:T.muted}}>{r.type.toUpperCase()} · via {r.spreadBy}</span>
                <span style={{fontSize:10,color:T.muted}}>{r.ts}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── WARNING SYSTEM ──
  const WarningsPage = () => {
    const warningLabels=["Clean record","First warning","Second warning — probation","Third warning — disciplinary review"];
    const warningColors=["#2a8a4a","#c4a000","#c87840","#8b0000"];
    const penaltyForLevel=[
      "No active penalties.",
      "₦5,000 fine issued. Academic record flagged.",
      "₦15,000 fine. Club privileges suspended.",
      "₦50,000 fine. Conversion proceedings initiated. Attend hearing.",
    ];
    return (
      <div style={{paddingBottom:80}}>
        <div style={hdr}>
          <div style={{maxWidth:600,margin:"0 auto",display:"flex",alignItems:"center",gap:10}}>
            <button type="button" className="b" onClick={()=>go("university")} style={{background:"transparent",border:"none",color:T.primary,fontSize:18,cursor:"pointer"}}>←</button>
            <span style={ttl()}>⚠️ DISCIPLINARY FILE</span>
          </div>
        </div>
        <div style={{...sec,maxWidth:600,margin:"0 auto"}}>
          <div style={{...card,padding:20,textAlign:"center",marginBottom:16,borderLeft:`4px solid ${warningColors[userWarnings]}`}}>
            <p style={{fontSize:40,marginBottom:8}}>{userWarnings===0?"✅":userWarnings===1?"⚠️":userWarnings===2?"🔴":"💀"}</p>
            <p style={{fontFamily:"'Cinzel',serif",fontSize:16,color:warningColors[userWarnings],fontWeight:700,marginBottom:4}}>{warningLabels[userWarnings]}</p>
            <p style={{fontSize:12,color:T.muted}}>{penaltyForLevel[userWarnings]}</p>
            <div style={{display:"flex",justifyContent:"center",gap:8,marginTop:12}}>
              {[0,1,2].map(i=>(
                <div key={i} style={{width:20,height:20,borderRadius:"50%",background:i<userWarnings?warningColors[Math.min(i+1,3)]:"#333",border:`1px solid ${T.border}`}} />
              ))}
            </div>
            <p style={{fontSize:10,color:T.muted,marginTop:8}}>3 warnings = disciplinary conversion proceedings</p>
          </div>
          <div style={{...card,padding:14}}>
            <p style={{...lbl,marginBottom:8}}>INFRACTION LOG</p>
            {userWarnings===0&&<p style={{fontSize:12,color:T.muted,fontStyle:"italic",fontFamily:"'IM Fell English',serif"}}>No infractions recorded. Maintain your standing.</p>}
            {userWarnings>0&&Array.from({length:userWarnings}).map((_,i)=>(
              <div key={i} style={{padding:"10px 0",borderBottom:i<userWarnings-1?`1px solid ${T.border}`:"none"}}>
                <p style={{fontSize:12,color:warningColors[i+1],fontWeight:700}}>Warning #{i+1}</p>
                <p style={{fontSize:11,color:T.muted}}>Issued by Dean's Office · On file</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const University = () => {
    if (subPage === "about") return UniAbout();
    if (subPage === "professors") return UniProfessors();
    if (subPage === "announcements") return UniAnnouncements();
    if (subPage === "students") return UniStudents();
    if (subPage === "relief") return UniRelief();
    if (subPage === "clubs") return ClubsPage();
    if (subPage === "championships") return ChampPage();
    if (subPage === "shop") return <Shop />;
    if (subPage === "timetable") return UniTimetable();
    if (subPage === "darkweb") return DarkWebStore();
    if (subPage === "society") return SocietyPage();
    if (subPage === "auction_portal") return Auction();
    if (subPage === "dark_portal") return Portal();
    if (subPage === "pets") return PetManagement();
    if (subPage === "academics") return AcademicsPage();
    if (subPage === "jobs") return JobsPage();
    if (subPage === "achievements") return AchievementsPage();
    if (subPage === "leaderboard") return LeaderboardPage();
    if (subPage === "rumours") return RumoursPage();
    if (subPage === "warnings") return WarningsPage();

    return (
      <div>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto" }}>
            <span style={ttl()}>🏛️ NOCTIS UNIVERSITY</span>
          </div>
        </div>
        <div style={sec}>
          <div style={{ textAlign: "center", padding: "20px 0 16px" }}>
            <div className="flt" style={{ fontSize: 48, marginBottom: 8 }}>
              🌑
            </div>
            <h2
              style={{
                fontFamily: "'Cinzel',serif",
                fontSize: 20,
                color: T.primary,
                letterSpacing: "0.15em",
                marginBottom: 4,
              }}
            >
              NOCTIS UNIVERSITY
            </h2>
            <p style={{ ...sub, fontSize: 14 }}>
              Nox Docet — The Night Teaches
            </p>
          </div>
          {[
            {
              id: "about",
              icon: "📜",
              label: "ABOUT THE INSTITUTION",
              sub: "History, systems, founding, the truth",
              color: "#a89878",
            },
            {
              id: "professors",
              icon: "🎓",
              label: "FACULTY DIRECTORY",
              sub: `${PROFS.length} professors. Full profiles.`,
              color: "#c4a000",
            },
            {
              id: "students",
              icon: "👥",
              label: "STUDENT DIRECTORY",
              sub: "The best of the best. Notable students.",
              color: "#7a9ab0",
            },
            {
              id: "clubs",
              icon: "🏛️",
              label: "CLUBS & SOCIETIES",
              sub: "Covenant orgs, secret societies, official clubs",
              color: "#8b7a9a",
            },
            {
              id: "championships",
              icon: "🏆",
              label: "CHAMPIONSHIPS",
              sub: "Upcoming competitions across all Covenants",
              color: "#c8954a",
            },
            {
              id: "announcements",
              icon: "📢",
              label: "OFFICIAL ANNOUNCEMENTS",
              sub: "University communications",
              color: "#d4af37",
            },
            {
              id: "relief",
              icon: "🪑",
              label: "RELIEF ROOM REGISTRY",
              sub: isApex ? "Full unit access data" : "Restricted — Apex only",
              color: "#4a7a9b",
              restricted: !isApex,
            },
            {
              id: "shop",
              icon: "🛍️",
              label: "NOCTIS MARKET",
              sub: `Shop items, Apex Vault & collectibles · ₦${walletBalance.toLocaleString()} balance`,
              color: "#d4af37",
            },
            {
              id: "academics",
              icon: "📚",
              label: "ACADEMICS & CLASSES",
              sub: `Enroll · attend lessons · earn XP & ₦ · level ${getXPLevel(userXP).label}`,
              color: "#2a8a4a",
            },
            {
              id: "timetable",
              icon: "📅",
              label: "COVENANT TIMETABLE",
              sub: "Class schedules by Covenant & year",
              color: "#7a6a9a",
            },
            {
              id: "darkweb",
              icon: "🕸️",
              label: "THE DARK CORRIDOR",
              sub: isApex ? "Restricted market · Apex & Masters only · Enter at own risk" : "⛔ RESTRICTED ACCESS — Apex & Masters tier required",
              color: "#ff00bb",
              restricted: !isApex,
            },
            {
              id: "society",
              icon: "🏰",
              label: "SOCIETY AT NOCTIS",
              sub: "Covenant hierarchy · Social rankings · Campus power structures",
              color: "#7a6a9a",
            },
            {
              id: "auction_portal",
              icon: "⛓️",
              label: "APEX VAULT & AUCTION",
              sub: isApex ? "Private listings · Covenant bonds · Bidding floor" : "⛔ Apex & Masters access only",
              color: "#a0845a",
              restricted: !isApex,
            },
            {
              id: "dark_portal",
              icon: "🏛",
              label: "ACQUISITION PORTAL",
              sub: "First come, first served · Pets · Favors · Virginity · No bidding",
              color: "#9b4e8a",
            },
            ...(Object.values(ACCTS).some((u: any) => u.masterId === uid) ? [{
              id: "pets",
              icon: "🔒",
              label: "MY PETS",
              sub: "Manage your collared students · Condition · Toys · Loans",
              color: "#8b0000",
            }] : []),
            {
              id: "jobs",
              icon: "💼",
              label: "JOB BOARD",
              sub: `Campus employment · ${20 - jobHoursThisWeek}hrs remaining this week`,
              color: "#4a8a6a",
            },
            {
              id: "achievements",
              icon: "🏅",
              label: "ACHIEVEMENTS",
              sub: `${userAchievements.length}/${ACHIEVEMENT_DEFS.length} unlocked · Track your milestones`,
              color: "#c4a000",
            },
            {
              id: "leaderboard",
              icon: "🏆",
              label: "LEADERBOARD",
              sub: "Influence · Wealth · XP rankings across Noctis",
              color: "#c87840",
            },
            {
              id: "rumours",
              icon: "🗣️",
              label: "RUMOUR MILL",
              sub: `Spread intel · ${rumours.length} active rumours in circulation`,
              color: "#8b4a8a",
            },
            {
              id: "warnings",
              icon: "⚠️",
              label: "DISCIPLINARY FILE",
              sub: userWarnings===0?"Clean record — no infractions":`${userWarnings}/3 warnings · ${userWarnings===3?"Conversion pending":"Review ongoing"}`,
              color: userWarnings===0?"#2a8a4a":userWarnings===3?"#8b0000":"#c87840",
            },
          ].map((p) => (
            <button
              key={p.id}
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!p.restricted) setSubPage(p.id);
                else toast("Apex access required.");
              }}
              style={{
                ...card,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "14px",
                marginBottom: 8,
                textAlign: "left",
                opacity: p.restricted ? 0.7 : 1,
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 10,
                  background: T.tag,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 22,
                  flexShrink: 0,
                  border: `1px solid ${p.color}44`,
                }}
              >
                {p.icon}
              </div>
              <div style={{ flex: 1 }}>
                <p
                  style={{
                    fontFamily: "'Cinzel',serif",
                    fontSize: 11,
                    color: p.color,
                    letterSpacing: "0.1em",
                    marginBottom: 2,
                  }}
                >
                  {p.label}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                  }}
                >
                  {p.sub}
                </p>
              </div>
              {p.restricted && <span style={{ fontSize: 14 }}>🔒</span>}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const SubHdr = ({ title: t }) => (
    <div style={hdr}>
      <div
        style={{
          maxWidth: 600,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSubPage(null);
          }}
          style={{
            background: "none",
            border: "none",
            color: T.muted,
            fontSize: 18,
          }}
        >
          ←
        </button>
        <span style={ttl()}>{t}</span>
      </div>
    </div>
  );

  const UniAbout = () => (
    <div>
      {SubHdr({ title: "📜 ABOUT NOCTIS" })}
      <div style={sec}>
        <div
          style={{
            ...card,
            padding: 20,
            marginBottom: 10,
            textAlign: "center",
          }}
        >
          <div className="flt" style={{ fontSize: 44, marginBottom: 10 }}>
            🌑
          </div>
          <h2
            style={{
              fontFamily: "'Cinzel',serif",
              fontSize: 22,
              color: T.primary,
              letterSpacing: "0.15em",
              marginBottom: 4,
            }}
          >
            NOCTIS UNIVERSITY
          </h2>
          <p style={{ ...sub, fontSize: 14, marginBottom: 14 }}>
            Nox Docet — The Night Teaches · Est. 1847
          </p>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            {[
              ["Founded", "1847"],
              ["Acceptance", "< 1.2%"],
              ["Enrollment", "4,200"],
              ["Campus", "800 acres"],
              ["Tuition", "$85,000/yr"],
              ["Autonomy", "Sovereign"],
            ].map(([l, v]) => (
              <div
                key={l}
                style={{
                  padding: 10,
                  background: T.tag,
                  borderRadius: 6,
                  border: `1px solid ${T.border}`,
                }}
              >
                <p style={lbl}>{l}</p>
                <p style={{ fontSize: 13, color: T.text, marginTop: 2 }}>{v}</p>
              </div>
            ))}
          </div>
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <p style={{ ...lbl, marginBottom: 8 }}>THE FOUR COVENANTS</p>
          {Object.values(COV).map((c) => (
            <div
              key={c.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
                borderBottom: `1px solid ${T.border}`,
              }}
            >
              <span style={{ fontSize: 20 }}>{c.emoji}</span>
              <div>
                <p style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>
                  {c.name}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                  }}
                >
                  {c.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            ...card,
            padding: 14,
            marginBottom: 10,
            border: `1px solid ${T.danger}44`,
          }}
        >
          <p style={{ ...lbl, color: T.danger, marginBottom: 8 }}>
            THE DARK SYSTEMS
          </p>
          {[
            "The Pet System — failed students sold as property at auction",
            "The Auction House — Pets, virgins, favors, secrets sold openly",
            "Public Relief Rooms — free use, no Master, no protection",
            "The Networking Events — exploitation as career development",
            "The Omertà Protocol — absolute silence, absolute consequences",
          ].map((s, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 8,
                padding: "7px 0",
                borderBottom: `1px solid ${T.border}`,
              }}
            >
              <span style={{ fontSize: 11, color: T.danger, flexShrink: 0 }}>
                ⛓️
              </span>
              <p style={{ fontSize: 12, color: T.text }}>{s}</p>
            </div>
          ))}
          <p
            style={{
              fontSize: 12,
              color: T.danger,
              marginTop: 10,
              fontFamily: "'IM Fell English',serif",
              fontStyle: "italic",
              lineHeight: 1.7,
            }}
          >
            These systems operate openly on campus and are protected by absolute
            omertà. 170+ years without external consequence. They always will
            be.
          </p>
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <p style={{ ...lbl, marginBottom: 8 }}>FOUNDING FAMILIES</p>
          {[
            "Blackwood Family — Est. 1847. Real estate, law, private security.",
            "White Legacy — Finance, energy, four generations of NU attendance.",
            "Vane-Ashcroft Dynasty — Media conglomerate, political influence.",
            "Ashford Political Dynasty — Three generations of senators.",
            "Eight other founding families whose names are sealed by the university.",
          ].map((f, i) => (
            <p
              key={i}
              style={{
                fontSize: 12,
                color: i === 4 ? T.danger : T.muted,
                padding: "6px 0",
                borderBottom: `1px solid ${T.border}`,
                fontFamily: "'IM Fell English',serif",
              }}
            >
              {f}
            </p>
          ))}
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <p style={{ ...lbl, marginBottom: 8 }}>CAMPUS BUILDINGS</p>
          {[
            "Blackwell Hall — Main Library & The Underground Auction House",
            "East Wing — Relief Rooms A-01 through B-12",
            "Blackwood Tower — Apex-tier housing",
            "The Garrison — Blades Covenant, Athletics Complex",
            "The Salon — Silk Covenant Hall",
            "The Archive — Shadows Restricted Section",
            "The Throne Room — Crowns Assembly Hall",
          ].map((b, i) => (
            <p
              key={i}
              style={{
                fontSize: 12,
                color: T.muted,
                padding: "5px 0",
                borderBottom: `1px solid ${T.border}`,
              }}
            >
              {b}
            </p>
          ))}
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <p style={{ ...lbl, marginBottom: 8 }}>NOTABLE ALUMNI</p>
          <p
            style={{
              fontSize: 13,
              color: T.muted,
              lineHeight: 1.8,
              fontFamily: "'IM Fell English',serif",
              fontStyle: "italic",
            }}
          >
            Presidents, Supreme Court Justices, Fortune 500 CEOs, Nobel
            Laureates, Military Generals, Intelligence Directors, Media Moguls,
            and those whose names cannot be published. The network is
            everywhere. It always has been.
          </p>
        </div>
      </div>
    </div>
  );

  const UniProfessors = () => {
    if (viewingProfId) {
        const prof = PROFS.find((p: any) => p.id === viewingProfId);
        if (!prof) return null;
        const p = prof as any;

        // ── FAVORABILITY SCORE ── range -50 to +50
        const computeFav = () => {
          if (!user) return 0;
          let score = 0;
          const u = user as any;
          const cov = u.cov || "";
          const tier = u.tier || "";
          const tags: string[] = Array.isArray(u.personalityTraits) ? u.personalityTraits : [];
          if (p.favCov?.includes(cov)) score += 10;
          if (p.penalCov?.includes(cov)) score -= 10;
          if (p.favTier?.includes(tier)) score += 10;
          if (p.penalTier?.includes(tier)) score -= 10;
          tags.forEach((t: string) => {
            if (p.favTags?.some((ft: string) => ft.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(ft.toLowerCase()))) score += 5;
            if (p.penalTags?.some((pt: string) => pt.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(pt.toLowerCase()))) score -= 5;
          });
          return Math.max(-50, Math.min(50, score));
        };
        const favScore = computeFav();
        const favLabel = favScore >= 30 ? "FAVOURED" : favScore >= 10 ? "NEUTRAL+" : favScore >= -10 ? "NEUTRAL" : favScore >= -30 ? "WARY" : "HOSTILE";
        const favColor = favScore >= 30 ? "#2a8a4a" : favScore >= 10 ? "#a89878" : favScore >= -10 ? T.muted : favScore >= -30 ? "#c8954a" : T.danger;

        const dmsForProf = profDMHistory[p.id] || [];
        const bookingKey = p.id + "_" + profBookingType;

        const sendProfDM = async () => {
          if (!profDMInput.trim() || profDMLoading) return;
          const msg = profDMInput.trim();
          setProfDMInput("");
          setProfDMLoading(true);
          const newHistory = [...dmsForProf, { role:"user", content: msg }];
          setProfDMHistory(prev => ({ ...prev, [p.id]: newHistory }));
          try {
            const res = await fetch("/api/ai/prof-dm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                profId: p.id, profName: p.name, profProfile: p, archetype: p.archetype,
                personality: p.personality, dms: p.dms,
                studentName: (user as any)?.un || "Student",
                studentTier: (user as any)?.tier || "merit",
                studentCov: (user as any)?.cov || "unknown",
                favScore,
                history: newHistory.slice(-6),
                message: msg,
                ...(hasUserAiKey ? { userApiBase: aiApiBase, userApiKey: aiApiKey, userModel: aiModel } : {}),
              }),
            });
            const data = await res.json();
            const reply = data.reply || p.dms[Math.floor(Math.random() * p.dms.length)];
            setProfDMHistory(prev => ({ ...prev, [p.id]: [...(prev[p.id] || []), { role: "assistant", content: reply }] }));
          } catch {
            const fallback = p.dms[Math.floor(Math.random() * p.dms.length)];
            setProfDMHistory(prev => ({ ...prev, [p.id]: [...(prev[p.id] || []), { role: "assistant", content: fallback }] }));
          } finally {
            setProfDMLoading(false);
          }
        };

        const bookMeeting = () => {
          if (profBookingsDone[bookingKey]) { toast("You already have a meeting booked of this type."); return; }
          if (p.fee > 0 && walletBalance < p.fee) { toast(`Insufficient funds. Meeting fee: ₦${p.fee.toLocaleString()}`); return; }
          if (p.fee > 0) { setWalletBalance((prev: number) => prev - p.fee); saveWalletToLS(uid, walletBalance - p.fee); }
          setProfBookingsDone(prev => ({ ...prev, [bookingKey]: true }));
          // Add a professor-initiated DM confirming the booking
          const confirmReply = p.dms[Math.floor(Math.random() * p.dms.length)];
          const bookingMsg = `[APPOINTMENT CONFIRMED — ${profBookingType}]\n\n${confirmReply}\n\nOffice hours: ${p.hours}.`;
          setProfDMHistory(prev => ({ ...prev, [p.id]: [...(prev[p.id] || []), { role: "assistant", content: bookingMsg }] }));
          toast(`✓ Appointment booked with ${p.name}. Opening DMs…`);
          // Navigate to DM tab with this professor
          setTimeout(() => {
            setViewingProfId(null);
            setDmConvId(p.id);
            setNav("messages");
          }, 400);
        };

        return (
          <div>
            <div style={hdr}>
              <div style={{ maxWidth:600, margin:"0 auto", display:"flex", alignItems:"center", gap:10 }}>
                <button type="button" onClick={() => setViewingProfId(null)} style={{ background:"none", border:"none", color:T.muted, fontSize:18, cursor:"pointer" }}>←</button>
                <span style={ttl()}>FACULTY PROFILE</span>
              </div>
            </div>
            <div style={sec}>
              {/* HEADER CARD */}
              <div style={{ ...card, padding:20, marginBottom:10, animation:"fadeUp .3s ease" }}>
                <div style={{ display:"flex", gap:14, alignItems:"flex-start", marginBottom:14 }}>
                  <div style={{ width:64, height:64, borderRadius:"50%", border:`2px solid ${p.color}`, background:T.tag, display:"flex", alignItems:"center", justifyContent:"center", fontSize:30, flexShrink:0 }}>{p.pic}</div>
                  <div style={{ flex:1 }}>
                    <h2 style={{ fontSize:16, fontWeight:700, color:T.text, marginBottom:2 }}>{p.name}</h2>
                    <p style={{ fontSize:11, color:T.muted, marginBottom:6 }}>{p.title} · {p.dept}</p>
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap" as const }}>
                      <span style={bdg(p.color)}>FACULTY</span>
                      {p.role && <span style={bdg(T.danger)}>🏛️ {p.role}</span>}
                      <span style={{ fontSize:11, color:T.muted }}>★ {p.rating}/10</span>
                      {isApex && p.flagged > 0 && <span style={{ fontSize:10, color:T.danger }}>⚠️ {p.flagged} flagged</span>}
                    </div>
                  </div>
                </div>

                {/* FAVORABILITY BAR */}
                {uid && (
                  <div style={{ marginBottom:14, padding:"10px 12px", background:T.tag, borderRadius:8, border:`1px solid ${favColor}44` }}>
                    <p style={{ fontSize:10, color:favColor, marginBottom:6, letterSpacing:"0.08em", fontFamily:"'Cinzel',serif" }}>YOUR STANDING — {favLabel}</p>
                    <div style={{ height:6, background:T.border, borderRadius:3, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${((favScore+50)/100)*100}%`, background:favColor, borderRadius:3, transition:"width .5s" }} />
                    </div>
                    <p style={{ fontSize:10, color:T.muted, marginTop:4 }}>Based on your covenant, tier &amp; personality. Exact score hidden from students.</p>
                  </div>
                )}

                {/* APPEARANCE */}
                <p style={{ ...lbl, marginBottom:4 }}>APPEARANCE</p>
                <p style={{ fontSize:12, color:T.muted, lineHeight:1.65, fontFamily:"'IM Fell English',serif", fontStyle:"italic", marginBottom:12 }}>{p.appearance}</p>

                {/* PERSONALITY */}
                <p style={{ ...lbl, marginBottom:4 }}>PERSONALITY</p>
                <p style={{ fontSize:12, color:T.muted, lineHeight:1.65, fontFamily:"'IM Fell English',serif", marginBottom:12 }}>{p.personality}</p>

                {/* TEACHING STYLE */}
                <p style={{ ...lbl, marginBottom:4 }}>TEACHING STYLE</p>
                <p style={{ fontSize:12, color:T.muted, lineHeight:1.65, marginBottom:12 }}>{p.teaching}</p>

                {/* COURSES */}
                <p style={{ ...lbl, marginBottom:6 }}>COURSES</p>
                <div style={{ display:"flex", flexWrap:"wrap" as const, gap:6, marginBottom:14 }}>
                  {p.courses.map((c: string) => <span key={c} style={{ ...bdg(p.color), fontSize:10 }}>{c}</span>)}
                </div>

                {/* OFFICE HOURS + FEE */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, padding:"10px 12px", background:T.tag, borderRadius:8, border:`1px solid ${T.border}` }}>
                  <div>
                    <p style={{ fontSize:10, color:T.primary, marginBottom:2, letterSpacing:"0.08em" }}>🕐 OFFICE HOURS</p>
                    <p style={{ fontSize:12, color:T.text }}>{p.hours}</p>
                  </div>
                  <div style={{ textAlign:"right" as const }}>
                    <p style={{ fontSize:10, color:T.primary, marginBottom:2, letterSpacing:"0.08em" }}>💰 MEETING FEE</p>
                    <p style={{ fontSize:14, fontWeight:700, color: p.fee === 0 ? "#2a8a4a" : T.text }}>{p.fee === 0 ? "FREE" : `₦${p.fee.toLocaleString()}`}</p>
                  </div>
                </div>

                {/* FAVORABILITY RULES HINT (self-discovered) */}
                <div style={{ display:"flex", flexWrap:"wrap" as const, gap:6, marginBottom:14 }}>
                  {p.favCov?.length > 0 && <span style={{ ...bdg("#2a8a4a"), fontSize:10 }}>❤ {p.favCov.join(", ")} covenant</span>}
                  {p.penalCov?.length > 0 && <span style={{ ...bdg(T.danger), fontSize:10 }}>✗ {p.penalCov.join(", ")} covenant</span>}
                  {p.favTags?.slice(0,3).map((t: string) => <span key={t} style={{ ...bdg("#667799"), fontSize:10 }}>+ {t}</span>)}
                </div>

                {/* CLASSIFIED — APEX ONLY */}
                {isApex && p.secret && (
                  <div style={{ padding:"10px 12px", background:"rgba(160,0,0,.08)", border:`1px solid ${T.danger}44`, borderRadius:8, marginBottom:4 }}>
                    <p style={{ fontSize:10, color:T.danger, marginBottom:6, letterSpacing:"0.08em" }}>⛔ CLASSIFIED — APEX EYES ONLY</p>
                    <p style={{ fontSize:12, color:T.muted, lineHeight:1.65, fontFamily:"'IM Fell English',serif", fontStyle:"italic" }}>{p.secret}</p>
                  </div>
                )}
              </div>

              {/* OFFICE HOURS BOOKING */}
              <div style={{ ...card, padding:16, marginBottom:10 }}>
                <p style={{ ...lbl, marginBottom:10 }}>📅 BOOK OFFICE HOURS</p>
                <div style={{ display:"flex", flexWrap:"wrap" as const, gap:6, marginBottom:10 }}>
                  {["Grade Review","Research Opportunity","Mentorship","Recommendation","Conflict Resolution"].map(t => (
                    <button key={t} type="button" className="b"
                      onClick={() => setProfBookingType(t)}
                      style={{ fontSize:10, padding:"5px 10px", borderRadius:20, border:`1px solid ${profBookingType===t ? p.color : T.border}`, background:profBookingType===t ? p.color+"22" : "none", color:profBookingType===t ? p.color : T.muted, cursor:"pointer" }}>
                      {t}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize:11, color:T.muted, marginBottom:10, lineHeight:1.5 }}>
                  {profBookingType === "Grade Review" && "Grades may increase, stay the same, or decrease. Outcome depends on your standing with this professor."}
                  {profBookingType === "Research Opportunity" && "Acceptance, waitlisting, or rejection depends on your perceived academic value and personal standing."}
                  {profBookingType === "Mentorship" && "Informal. Acceptance often requires demonstrating usefulness beyond academics."}
                  {profBookingType === "Recommendation" && "Letter strength varies — strong, standard, or actively damaging — based on faculty opinion."}
                  {profBookingType === "Conflict Resolution" && "Resolution may favor you, rule against you, or escalate depending on who the professor favors."}
                </p>
                <button type="button" className="b"
                  onClick={bookMeeting}
                  disabled={profBookingsDone[bookingKey]}
                  style={{ ...btn(!profBookingsDone[bookingKey]), width:"100%", fontSize:12, opacity:profBookingsDone[bookingKey]?0.5:1 }}>
                  {profBookingsDone[bookingKey] ? "✓ MEETING BOOKED" : `BOOK ${profBookingType.toUpperCase()} — ${p.fee > 0 ? `₦${p.fee.toLocaleString()}` : "FREE"}`}
                </button>
              </div>

              {/* DM — only accessible after booking an appointment */}
              {uid && profBookingsDone[bookingKey] && (
                <div style={{ ...card, padding:14, marginBottom:10, borderLeft:`3px solid ${p.color}` }}>
                  <p style={{ fontSize:11, color:p.color, fontFamily:"'Cinzel',serif", letterSpacing:"0.08em", marginBottom:6 }}>✉️ APPOINTMENT CONFIRMED</p>
                  <p style={{ fontSize:12, color:T.muted, fontFamily:"'IM Fell English',serif", fontStyle:"italic", lineHeight:1.6, marginBottom:10 }}>
                    Your correspondence with {p.name} is now open. Continue the conversation in your DMs.
                  </p>
                  <button type="button" className="b"
                    onClick={() => { setViewingProfId(null); setDmConvId(p.id); setNav("messages"); }}
                    style={{ ...btn(true), width:"100%", padding:"10px", fontSize:12 }}>
                    OPEN DMS WITH {p.name.toUpperCase().split(" ")[1] || p.name.toUpperCase()} →
                  </button>
                </div>
              )}
              {uid && !profBookingsDone[bookingKey] && (
                <div style={{ ...card, padding:14, marginBottom:10 }}>
                  <p style={{ fontSize:11, color:T.muted, fontFamily:"'IM Fell English',serif", fontStyle:"italic", lineHeight:1.6, textAlign:"center" as const }}>
                    Direct communication with faculty requires a booked appointment. Use the booking form above.
                  </p>
                </div>
              )}
            </div>
          </div>
        );
      }
  
    return (
      <div>
        {SubHdr({ title: "🎓 FACULTY DIRECTORY" })}
        <div style={sec}>
          <div
            style={{
              ...card,
              padding: 12,
              marginBottom: 10,
              background: `rgba(139,115,85,.07)`,
              border: `1px solid ${T.border}`,
            }}
          >
            <p
              style={{
                fontSize: 12,
                color: T.muted,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                lineHeight: 1.7,
              }}
            >
              Faculty at Noctis are completely untouchable. What is listed here
              is what they want you to know — and what students eventually
              discover on their own.
            </p>
          </div>
          {PROFS.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setViewingProfId(p.id);
              }}
              style={{
                ...card,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "13px",
                marginBottom: 8,
                textAlign: "left",
                animation: `fadeUp ${0.06 + i * 0.05}s ease`,
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: "50%",
                  border: `2px solid ${p.color}`,
                  background: T.tag,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  flexShrink: 0,
                }}
              >
                {p.pic}
              </div>
              <div style={{ flex: 1 }}>
                <p
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: T.text,
                    marginBottom: 2,
                  }}
                >
                  {p.name}
                </p>
                <p style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>
                  {p.dept} · {p.title}
                </p>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {p.role && <span style={bdg(T.danger)}>{p.role}</span>}
                  <span style={{ fontSize: 11, color: T.muted }}>
                    ★ {p.rating}
                  </span>
                  {isApex && p.flagged > 0 && (
                    <span style={{ fontSize: 10, color: T.danger }}>
                      ⚠️ {p.flagged} flagged
                    </span>
                  )}
                </div>
              </div>
              <span style={{ color: T.muted, fontSize: 16 }}>›</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const UniStudents = () => {
    const notable = Object.values(ACCTS).filter(
      (s: any) => (s.isSpecial || s.personality) && !s.isPet && !s.isRelief && !s.isFaculty && s.tier !== "pet" && s.tier !== "relief" && s.tier !== "none"
    );
    return (
      <div>
        {SubHdr({ title: "👥 NOTABLE STUDENTS" })}
        <div style={sec}>
          <div style={{ ...card, padding: 12, marginBottom: 10 }}>
            <p
              style={{
                fontSize: 12,
                color: T.muted,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                lineHeight: 1.7,
              }}
            >
              The student directory displays only verified notable students. The
              full enrollment of 4,200 is not publicly accessible.
            </p>
          </div>
          {notable.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                viewProf(s.id);
              }}
              style={{
                ...card,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 13px",
                marginBottom: 8,
                textAlign: "left",
                animation: `fadeUp ${0.06 + i * 0.04}s ease`,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  border: `2px solid ${s.bColor || T.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  background: T.tag,
                  flexShrink: 0,
                  overflow: "hidden",
                }}
              >
                {(() => { const p = s.pic || "🌑"; return (p.startsWith("/") || p.startsWith("http") || p.startsWith("data:")) ? <img src={p} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} /> : <span style={{ fontSize: 20 }}>{p}</span>; })()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span
                    style={{ fontSize: 14, fontWeight: 600, color: T.text }}
                  >
                    {s.un}
                  </span>
                  {s.isVerified && (
                    <span style={{ color: T.primary, fontSize: 10 }}>✓</span>
                  )}
                </div>
                <p style={{ fontSize: 11, color: T.muted }}>
                  {s.handle} · {s.major || "—"}
                </p>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={bdg(s.bColor)}>{s.badge}</span>
                <p style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>
                  {s.gaze?.toLocaleString()} gaze
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const UniAnnouncements = () => (
    <div>
      {SubHdr({ title: "📢 ANNOUNCEMENTS" })}
      <div style={sec}>
        {ANNOUNCEMENTS.map((a, i) => (
          <div
            key={a.id}
            style={{
              ...card,
              padding: 14,
              marginBottom: 10,
              borderLeft: `3px solid ${
                a.priority === "high"
                  ? T.danger
                  : a.priority === "medium"
                  ? T.primary
                  : T.border
              }`,
              animation: `fadeUp ${0.06 + i * 0.06}s ease`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
                flexWrap: "wrap",
              }}
            >
              {a.pinned && (
                <span style={{ fontSize: 10, color: T.accent }}>📌 PINNED</span>
              )}
              <span style={bdg(a.priority === "high" ? T.danger : T.sec)}>
                {a.cat.toUpperCase()}
              </span>
              <span
                style={{ fontSize: 11, color: T.muted, marginLeft: "auto" }}
              >
                {a.date}
              </span>
            </div>
            <h3
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: T.text,
                marginBottom: 8,
              }}
            >
              {a.title}
            </h3>
            <p
              style={{
                fontSize: 13,
                color: T.muted,
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                fontFamily: "'IM Fell English',serif",
              }}
            >
              {a.content}
            </p>
            <p style={{ fontSize: 11, color: T.muted, marginTop: 8 }}>
              — {a.author}
            </p>
          </div>
        ))}
      </div>
    </div>
  );

  const UniRelief = () => {
    if (!isApex)
      return (
        <div>
          {SubHdr({ title: "🪑 RELIEF ROOMS" })}
          <div style={{ ...sec, textAlign: "center", padding: "60px 20px" }}>
            <p style={ttl()}>ACCESS DENIED</p>
            <p style={{ ...sub, marginTop: 8 }}>Apex credentials required.</p>
          </div>
        </div>
      );
    const sc = {
      available: "#44aa44",
      "in-use": "#d4af37",
      maintenance: "#4a7a9b",
    };
    return (
      <div>
        {SubHdr({ title: "🪑 RELIEF ROOMS REGISTRY" })}
        <div style={sec}>
          <div
            style={{
              ...card,
              padding: 12,
              marginBottom: 10,
              background: "rgba(74,122,155,.07)",
              border: "1px solid rgba(74,122,155,.3)",
            }}
          >
            <p style={{ fontSize: 12, color: "#4a7a9b", lineHeight: 1.7 }}>
              East Wing, Rooms A-01 through B-12. Open 24/7. Units assigned from
              students who received no bids at Pet Auction. Universal access —
              any student, any time. Usage tracked. Review system below is
              anonymous.
            </p>
          </div>
          {[
            {
              ...RELIEF_ROOMS[0],
              reviews: [
                {
                  id: "rv1",
                  rating: 4,
                  un: "Anonymous",
                  t: "Quiet. Compliant. Room is clean.",
                  ts: "2h",
                },
                {
                  id: "rv2",
                  rating: 5,
                  un: "Anonymous",
                  t: "Best unit in the East Wing currently. High responsiveness.",
                  ts: "5h",
                },
                {
                  id: "rv3",
                  rating: 3,
                  un: "Anonymous",
                  t: "Passive. Not what I prefer but efficient.",
                  ts: "1d",
                },
              ],
            },
            {
              ...RELIEF_ROOMS[1],
              reviews: [
                {
                  id: "rv4",
                  rating: 3,
                  un: "Anonymous",
                  t: "Distracted. Clearly thinking about the petition.",
                  ts: "3h",
                },
                {
                  id: "rv5",
                  rating: 4,
                  un: "Anonymous",
                  t: "Good stamina. Would return.",
                  ts: "8h",
                },
              ],
            },
            {
              ...RELIEF_ROOMS[2],
              reviews: [
                {
                  id: "rv6",
                  rating: 2,
                  un: "Anonymous",
                  t: "Still adjusting. Expected.",
                  ts: "4h",
                },
                {
                  id: "rv7",
                  rating: 3,
                  un: "Anonymous",
                  t: "New. Compliant enough. Will improve.",
                  ts: "12h",
                },
              ],
            },
            {
              ...RELIEF_ROOMS[3],
              reviews: [
                {
                  id: "rv8",
                  rating: 5,
                  un: "Anonymous",
                  t: "Exceptional. The GPA shows. The ability shows.",
                  ts: "1h",
                },
                {
                  id: "rv9",
                  rating: 5,
                  un: "Anonymous",
                  t: "Best experience this semester. Whatever they're doing to improve the petition, it works against them.",
                  ts: "6h",
                },
              ],
            },
            { ...RELIEF_ROOMS[4], reviews: [] },
            {
              ...RELIEF_ROOMS[5],
              reviews: [
                {
                  id: "rv10",
                  rating: 4,
                  un: "Anonymous",
                  t: "High demand for a reason.",
                  ts: "2h",
                },
                {
                  id: "rv11",
                  rating: 5,
                  un: "Anonymous",
                  t: "18 uses today and still responsive. Remarkable.",
                  ts: "4h",
                },
                {
                  id: "rv12",
                  rating: 3,
                  un: "Anonymous",
                  t: "Getting tired. Admin should monitor stamina.",
                  ts: "9h",
                },
              ],
            },
            {
              ...RELIEF_ROOMS[6],
              reviews: [
                {
                  id: "rv13",
                  rating: 4,
                  un: "Anonymous",
                  t: "The petition situation adds something interesting.",
                  ts: "3h",
                },
                {
                  id: "rv14",
                  rating: 4,
                  un: "Anonymous",
                  t: "Cooperative. Good GPA. Whatever the Master's problem is, the unit performs.",
                  ts: "7h",
                },
              ],
            },
            {
              ...RELIEF_ROOMS[7],
              reviews: [
                {
                  id: "rv15",
                  rating: 2,
                  un: "Anonymous",
                  t: "Still very new. Doesn't understand yet. Part of what's interesting.",
                  ts: "1d",
                },
              ],
            },
            {
              ...RELIEF_ROOMS[8],
              reviews: [
                {
                  id: "rv16",
                  rating: 5,
                  un: "Anonymous",
                  t: "The longest-serving unit. Something about the composure. Academic record is genuinely impressive.",
                  ts: "2h",
                },
                {
                  id: "rv17",
                  rating: 4,
                  un: "Anonymous",
                  t: "Three semesters and the GPA is still perfect. Whatever the petition status, the unit is exceptional.",
                  ts: "5h",
                },
              ],
            },
          ].map((r, i) => (
            <div
              key={r.id}
              style={{
                ...card,
                marginBottom: 10,
                overflow: "hidden",
                borderLeft: `3px solid ${sc[r.status]}`,
                animation: `fadeUp ${0.06 + i * 0.05}s ease`,
              }}
            >
              <div style={{ padding: "12px 13px 10px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 7,
                    alignItems: "flex-start",
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: T.text,
                        marginBottom: 2,
                      }}
                    >
                      {r.unit} · Room {r.room}{r.name ? ` · ${r.name}` : ""}
                    </p>
                    <p style={{ fontSize: 11, color: T.muted }}>
                      {r.gender === "NB"
                        ? "Non-binary"
                        : r.gender === "M"
                        ? "Male"
                        : "Female"}{" "}
                      · Age {r.age} · {r.weeks} wks assigned
                      {r.major ? ` · ${r.major}` : ""}
                      {r.year ? ` · ${r.year}` : ""}
                    </p>
                    {r.family && (
                      <p style={{ fontSize: 11, color: T.muted, marginTop: 3, fontStyle: "italic" }}>
                        {r.family}
                      </p>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "3px 9px",
                      borderRadius: 12,
                      background: `${sc[r.status]}18`,
                      color: sc[r.status],
                      fontFamily: "'Cinzel',serif",
                      flexShrink: 0,
                    }}
                  >
                    {r.status.replace("-", " ").toUpperCase()}
                  </span>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3,1fr)",
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  {[
                    ["GPA", r.gpa, T.primary],
                    ["TODAY", `${r.today}×`, T.accent],
                    ["TOTAL", `${r.weeks * r.today}+`, T.muted],
                  ].map(([l2, v, c]) => (
                    <div
                      key={l2}
                      style={{
                        background: T.tag,
                        borderRadius: 5,
                        padding: "6px 8px",
                        textAlign: "center",
                      }}
                    >
                      <p style={{ ...lbl, fontSize: 8, marginBottom: 1 }}>
                        {l2}
                      </p>
                      <p
                        style={{
                          fontSize: 12,
                          color: c,
                          fontFamily: "'Cinzel',serif",
                        }}
                      >
                        {v}
                      </p>
                    </div>
                  ))}
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                    marginBottom: r.backstory ? 6 : 8,
                  }}
                >
                  {r.note}
                </p>
                {r.backstory && (
                  <div style={{ marginBottom: 8 }}>
                    <p style={{ ...lbl, fontSize: 9, color: T.muted, marginBottom: 2 }}>BACKSTORY</p>
                    <p style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{r.backstory}</p>
                  </div>
                )}
                {r.personality && (
                  <div style={{ marginBottom: 8 }}>
                    <p style={{ ...lbl, fontSize: 9, color: T.muted, marginBottom: 2 }}>PSYCH NOTE</p>
                    <p style={{ fontSize: 11, color: T.muted, fontStyle: "italic", lineHeight: 1.6 }}>{r.personality}</p>
                  </div>
                )}
                {r.petition && (
                  <div style={{ marginBottom: 8, padding: "5px 8px", borderRadius: 6, background: "rgba(212,175,55,.1)", border: "1px solid rgba(212,175,55,.3)" }}>
                    <p style={{ fontSize: 10, color: "#d4af37" }}>⚖️ REVIEW PETITION ON FILE — PENDING</p>
                  </div>
                )}
                {r.compliance !== undefined && (
                  <div style={{ marginBottom: 8 }}>
                    <p style={{ ...lbl, fontSize: 9, marginBottom: 3 }}>COMPLIANCE INDEX</p>
                    <div style={{ height: 4, background: T.border, borderRadius: 2 }}>
                      <div style={{ height: 4, width: `${r.compliance}%`, background: r.compliance > 80 ? "#44aa44" : r.compliance > 50 ? "#d4af37" : "#cc4444", borderRadius: 2 }} />
                    </div>
                    <p style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>{r.compliance}%</p>
                  </div>
                )}
                {r.status === "available" && (
                  <button
                    type="button"
                    className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toast(`Room ${r.room} access confirmed.`);
                    }}
                    style={{
                      ...btn(true),
                      width: "100%",
                      padding: "8px",
                      fontSize: 11,
                    }}
                  >
                    ACCESS ROOM {r.room}
                  </button>
                )}
                {r.status === "maintenance" && (
                  <p
                    style={{
                      fontSize: 11,
                      color: "#4a7a9b",
                      textAlign: "center",
                      padding: "4px 0",
                    }}
                  >
                    Currently unavailable — health assessment
                  </p>
                )}
                {r.status === "in-use" && (
                  <p
                    style={{
                      fontSize: 11,
                      color: T.accent,
                      textAlign: "center",
                      padding: "4px 0",
                    }}
                  >
                    In use · Check back shortly
                  </p>
                )}
              </div>
              {r.reviews && r.reviews.length > 0 && (
                <div
                  style={{
                    borderTop: `1px solid ${T.border}`,
                    padding: "10px 13px",
                    background: `rgba(0,0,0,.03)`,
                  }}
                >
                  <p style={{ ...lbl, marginBottom: 8, color: T.muted }}>
                    ANONYMOUS REVIEWS · {r.reviews.length}
                  </p>
                  {r.reviews.map((rv) => (
                    <div
                      key={rv.id}
                      style={{
                        display: "flex",
                        gap: 8,
                        marginBottom: 8,
                        paddingBottom: 8,
                        borderBottom: `1px solid ${T.border}`,
                      }}
                    >
                      <div style={{ flexShrink: 0 }}>
                        <span style={{ color: T.accent, fontSize: 11 }}>
                          {"★".repeat(rv.rating)}
                          {"☆".repeat(5 - rv.rating)}
                        </span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <p
                          style={{
                            fontSize: 12,
                            color: T.muted,
                            fontFamily: "'IM Fell English',serif",
                            fontStyle: "italic",
                          }}
                        >
                          {rv.t}
                        </p>
                        <p
                          style={{
                            fontSize: 10,
                            color: T.border,
                            marginTop: 3,
                          }}
                        >
                          {rv.ts}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // SOCIETY AT NOCTIS
  // ═══════════════════════════════════════════════════════
  const SocietyPage = () => {
    const covenantLore = [
      {
        id: "crowns", icon: "👑", name: "Covenant of Crowns", color: "#d4af37",
        tagline: "Power. Legacy. Authority.",
        lore: "Crowns students pursue political power, corporate control, and institutional dominance. Alumni occupy national legislatures, Fortune 500 boards, and diplomatic posts. Their social events are the most selective on campus. Crowns do not ask for power — they inherit it, consolidate it, and pass it down. Colors: deep crimson and gold.",
        known: ["Chancellor's Ball", "The Boardroom Dinner", "Legacy Gala"],
        rumored: "The Crowns maintain a private list of every person who has ever slighted a Covenant member. The list is updated quarterly.",
        tier: "Apex & Ascendant heavy",
      },
      {
        id: "shadows", icon: "👁️", name: "Covenant of Shadows", color: "#9944cc",
        tagline: "Knowledge. Secrets. Leverage.",
        lore: "Shadows excel in intelligence, analysis, and information brokerage. They are the quietest Covenant and the most dangerous. They are overrepresented in intelligence agencies, data firms, and private research bodies. They rarely appear at social events — they observe them from outside. Colors: midnight blue and silver.",
        known: ["The Archive Reading", "Intelligence Symposium", "Cipher Night"],
        rumored: "The Shadows maintain surveillance logs of every major Covenant event on campus. Not for blackmail. For record.",
        tier: "Apex & Ascendant dominant",
      },
      {
        id: "silk", icon: "🌸", name: "Covenant of Silk", color: "#cc88aa",
        tagline: "Influence. Persuasion. Social Architecture.",
        lore: "Silk students trade in charm, aesthetics, and social capital. They control the cultural calendar of Noctis. Their events are the most photographed and the most attended. Alumni dominate media, fashion, entertainment, and public relations. They are underestimated. This is deliberate. Colors: emerald green and ivory.",
        known: ["The Silk Masquerade", "Covenant Fashion Show", "The Social Season"],
        rumored: "The Silk Covenant has never lost a social vote at Noctis in 22 years. The mechanism for this is not publicly discussed.",
        tier: "All tiers · broad reach",
      },
      {
        id: "blades", icon: "⚔️", name: "Covenant of Blades", color: "#7a9ab0",
        tagline: "Strength. Loyalty. Protection.",
        lore: "Blades are warriors, athletes, and guardians. They dominate every competitive sport at Noctis and provide informal security to the other Covenants. Alumni serve in elite military units, private security, and crisis response organisations. Blades are loyal to their own above all else. Colors: steel grey and black.",
        known: ["Combat Championships", "The Blades Gala", "Covenant Trials"],
        rumored: "The Blades have provided personal protection to three sitting heads of state simultaneously. They do not discuss this.",
        tier: "Ascendant & Merit heavy",
      },
    ];

    const socialTiers = [
      { tier: "Apex", emoji: "⚡", count: Object.values(ACCTS).filter((u: any) => u.tier === "apex").length, desc: "The untouchable elite. Full access to all university systems, Auction house, and restricted portals. ₦500,000 starting balance.", color: "#d4af37" },
      { tier: "Ascendant", emoji: "🔱", count: Object.values(ACCTS).filter((u: any) => u.tier === "ascendant").length, desc: "Rising power. Significant access and social standing. Compete for Apex selection each semester.", color: "#9966ff" },
      { tier: "Merit", emoji: "📚", count: Object.values(ACCTS).filter((u: any) => u.tier === "merit").length, desc: "Earned their place. Scholarship track. The engine of Noctis. Cannot be ignored — can be recruited.", color: "#44aacc" },
      { tier: "Faculty", emoji: "🎓", count: Object.values(ACCTS).filter((u: any) => u.tier === "faculty").length, desc: "Professors and staff. Functionally untouchable. Their favour is worth more than any alliance.", color: "#7788aa" },
      { tier: "Pet", emoji: "🔒", count: Object.values(ACCTS).filter((u: any) => u.tier === "pet").length, desc: "Collared. Owned. No posting rights, no social mobility. A transaction, not a student.", color: "#8b0000" },
    ];

    return (
      <div style={{ paddingBottom: 100, background: "#000" }}>
        {SubHdr({ title: "🏰 SOCIETY AT NOCTIS" })}
        <div style={sec}>
          <div style={{ textAlign: "center", padding: "10px 0 16px" }}>
            <p style={{ fontFamily: "'Cinzel',serif", fontSize: 12, color: T.muted, letterSpacing: "0.1em" }}>
              COVENANT HIERARCHY · SOCIAL POWER · CAMPUS ORDER
            </p>
          </div>

          <p style={{ ...lbl, marginBottom: 10 }}>THE FOUR COVENANTS</p>
          {covenantLore.map(cv => (
            <div key={cv.id} style={{ marginBottom: 14, background: "#0d0d0d", border: `1px solid ${cv.color}44`, borderRadius: 10, padding: "14px 13px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 26 }}>{cv.icon}</span>
                <div>
                  <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: cv.color }}>{cv.name}</p>
                  <p style={{ fontSize: 10, color: T.muted, fontStyle: "italic" }}>{cv.tagline}</p>
                </div>
              </div>
              <p style={{ fontSize: 12, color: "#bba88a", lineHeight: 1.65, fontFamily: "Georgia,serif", marginBottom: 8 }}>{cv.lore}</p>
              <p style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>KNOWN EVENTS: {cv.known.join(" · ")}</p>
              <div style={{ background: "#110a00", border: "1px solid #2a1500", borderRadius: 5, padding: "6px 10px", marginBottom: 6 }}>
                <p style={{ fontSize: 10, color: "#8a5a30", fontStyle: "italic" }}>Rumoured: {cv.rumored}</p>
              </div>
              <p style={{ fontSize: 10, color: cv.color }}>📊 {cv.tier}</p>
            </div>
          ))}

          <p style={{ ...lbl, marginBottom: 10, marginTop: 6 }}>SOCIAL TIER REGISTRY</p>
          {socialTiers.map(st => (
            <div key={st.tier} style={{ marginBottom: 10, background: "#0d0d0d", border: `1px solid ${st.color}33`, borderRadius: 8, padding: "12px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{st.emoji}</span>
                  <span style={{ fontFamily: "'Cinzel',serif", fontSize: 12, color: st.color }}>{st.tier.toUpperCase()}</span>
                </div>
                <span style={{ fontSize: 11, color: T.muted }}>{st.count} students</span>
              </div>
              <p style={{ fontSize: 11, color: "#9a8868", lineHeight: 1.55 }}>{st.desc}</p>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // PET MANAGEMENT (for Masters / Apex tier)
  // ═══════════════════════════════════════════════════════
  const PetManagement = () => {
    const myPets = Object.values(ACCTS).filter((u: any) => u.masterId === uid) as any[];
    const pet = viewingPetId ? (ACCTS[viewingPetId] as any) : null;
    const log = viewingPetId ? (petActionLog[viewingPetId] || []) : [];

    const toys = [
      { id: "velvet", label: "Velvet Restraints", icon: "🎀", effect: "obedience+", desc: "Reinforces submission. Obedience increases." },
      { id: "silk_mask", label: "Silk Blindfold", icon: "🎭", effect: "mood+", desc: "Sensory deprivation. Mood becomes pliant." },
      { id: "crop", label: "Riding Crop", icon: "🌿", effect: "discipline+", desc: "Correction tool. Discipline sharpens." },
      { id: "collar_bell", label: "Bell Collar", icon: "🔔", effect: "compliance+", desc: "Constant reminder of position. Compliance holds." },
    ];
    const drugs = [
      { id: "nootropic", label: "Cognitive Serum", icon: "🧪", effect: "performance+", desc: "Enhances focus and responsiveness. Temporary." },
      { id: "compliance_drop", label: "Compliance Supplement", icon: "💊", effect: "obedience++", desc: "Strong compliance enhancer. Extended effect." },
      { id: "vitality", label: "Vitality Supplement", icon: "⚗️", effect: "energy+", desc: "Increases energy and responsiveness." },
      { id: "sensitivity", label: "Sensitivity Elixir", icon: "🌡️", effect: "sensitivity+", desc: "Heightens sensation. Handle with care." },
    ];

    const doAction = (actionLabel: string) => {
      if (!viewingPetId) return;
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const entry = `[${ts}] ${actionLabel}`;
      setPetActionLog(prev => ({ ...prev, [viewingPetId]: [entry, ...(prev[viewingPetId] || [])].slice(0, 10) }));
      toast(actionLabel);
    };

    const doLoan = () => {
      if (!viewingPetId) return;
      setLoanModal({ open: true, petId: viewingPetId, search: "", targetId: null, terms: "Standard loan — 2 weeks. No modification. Return in original condition." });
    };

    if (!myPets.length) {
      return (
        <div style={{ padding: "30px 20px", textAlign: "center" }}>
          <p style={{ fontSize: 32, marginBottom: 12 }}>🔒</p>
          <p style={{ fontFamily: "'Cinzel',serif", color: T.muted, fontSize: 13 }}>You do not currently own any pets.</p>
          <p style={{ fontSize: 11, color: T.border, marginTop: 8 }}>Pets are acquired through the Apex Auction House.</p>
        </div>
      );
    }

    if (pet) {
      const petStats = [
        { label: "OBEDIENCE", val: 78 + (log.filter(l => l.includes("obedience") || l.includes("Restraints") || l.includes("Compliance")).length * 3), max: 100, color: "#8b0000" },
        { label: "COMPLIANCE", val: 65 + (log.filter(l => l.includes("compliance") || l.includes("Collar")).length * 4), max: 100, color: "#cc4400" },
        { label: "MOOD", val: 55 + (log.filter(l => l.includes("Blindfold") || l.includes("mood")).length * 5), max: 100, color: "#44aacc" },
        { label: "ENERGY", val: 60 + (log.filter(l => l.includes("energy") || l.includes("Vitality")).length * 5), max: 100, color: "#44cc88" },
      ].map(s => ({ ...s, val: Math.min(s.val, 100) }));

      return (
        <div style={{ paddingBottom: 100 }}>
          {SubHdr({ title: `🔒 ${pet.name || pet.id}` })}
          <div style={sec}>
            <button className="b" onClick={() => setViewingPetId(null)} style={{ ...btn(false), padding: "6px 12px", marginBottom: 12, fontSize: 11 }}>← BACK TO MY PETS</button>

            <div style={{ ...card, padding: 14, marginBottom: 12, textAlign: "center" }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>{pet.pic || "🔒"}</div>
              <p style={{ fontFamily: "'Cinzel',serif", fontSize: 15, color: T.text, marginBottom: 2 }}>{pet.name || pet.id}</p>
              <p style={{ fontSize: 11, color: "#8b0000" }}>@{pet.id} · {pet.year || "Freshman"} · {pet.major || "Undeclared"}</p>
              <p style={{ fontSize: 10, color: T.muted, marginTop: 4 }}>Owned by {uid} · Acquired via Apex Auction</p>
            </div>

            <p style={{ ...lbl, marginBottom: 8 }}>CONDITION STATUS</p>
            {petStats.map(s => (
              <div key={s.label} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: T.muted, fontFamily: "'Cinzel',serif" }}>{s.label}</span>
                  <span style={{ fontSize: 10, color: s.color }}>{s.val}%</span>
                </div>
                <div style={{ height: 6, background: "#1a1409", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${s.val}%`, background: s.color, borderRadius: 3, transition: "width 0.4s" }} />
                </div>
              </div>
            ))}

            <p style={{ ...lbl, marginBottom: 8, marginTop: 14 }}>USE TOY</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
              {toys.map(toy => (
                <button key={toy.id} className="b" onClick={() => doAction(`Used ${toy.label} on pet.`)}
                  style={{ background: "#1a0a00", border: "1px solid #3a1a00", borderRadius: 8, padding: "10px 8px", textAlign: "left", cursor: "pointer" }}>
                  <span style={{ fontSize: 18, display: "block", marginBottom: 4 }}>{toy.icon}</span>
                  <span style={{ fontSize: 11, color: "#cc6600", fontFamily: "'Cinzel',serif", display: "block", marginBottom: 2 }}>{toy.label}</span>
                  <span style={{ fontSize: 10, color: "#7a4400" }}>{toy.desc}</span>
                </button>
              ))}
            </div>

            <p style={{ ...lbl, marginBottom: 8 }}>ADMINISTER SUBSTANCE</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
              {drugs.map(drug => (
                <button key={drug.id} className="b" onClick={() => doAction(`Administered ${drug.label} to pet.`)}
                  style={{ background: "#0a001a", border: "1px solid #2a0055", borderRadius: 8, padding: "10px 8px", textAlign: "left", cursor: "pointer" }}>
                  <span style={{ fontSize: 18, display: "block", marginBottom: 4 }}>{drug.icon}</span>
                  <span style={{ fontSize: 11, color: "#9955ff", fontFamily: "'Cinzel',serif", display: "block", marginBottom: 2 }}>{drug.label}</span>
                  <span style={{ fontSize: 10, color: "#5a2a99" }}>{drug.desc}</span>
                </button>
              ))}
            </div>

            <button className="b" onClick={doLoan}
              style={{ ...btn(false), width: "100%", padding: "12px", marginBottom: 14, border: "1px solid #cc6600", color: "#cc6600", background: "#1a0a00" }}>
              📤 LOAN TO ANOTHER STUDENT
            </button>

            {log.length > 0 && (
              <div style={{ ...card, padding: 12 }}>
                <p style={{ ...lbl, marginBottom: 6 }}>ACTION LOG</p>
                {log.map((entry, i) => (
                  <p key={i} style={{ fontSize: 10, color: T.muted, marginBottom: 3, fontFamily: "monospace" }}>{entry}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div style={{ paddingBottom: 100 }}>
        {SubHdr({ title: "🔒 MY PETS" })}
        <div style={sec}>
          <div style={{ ...card, padding: 12, marginBottom: 12, background: "#110a00", border: "1px solid #3a1500" }}>
            <p style={{ fontSize: 12, color: "#9a6030", fontFamily: "'IM Fell English',serif", fontStyle: "italic", lineHeight: 1.7 }}>
              Your pets are listed below. Select one to check their condition, administer substances, use toys, or arrange a loan.
            </p>
          </div>
          {myPets.map((p: any) => (
            <button key={p.id} className="b" onClick={() => setViewingPetId(p.id)}
              style={{ ...card, width: "100%", display: "flex", alignItems: "center", gap: 12, padding: 13, marginBottom: 8, textAlign: "left", borderLeft: "3px solid #8b0000" }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: T.tag, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0, border: "2px solid #4a0000" }}>{p.pic || "🔒"}</div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 14, color: T.text, marginBottom: 2 }}>{p.name || p.id}</p>
                <p style={{ fontSize: 11, color: T.muted }}>@{p.id} · {p.year || "Freshman"} · {p.major || "Undeclared"}</p>
                <p style={{ fontSize: 10, color: "#8b0000", marginTop: 2 }}>🔒 Collared · Tap to manage</p>
              </div>
              <span style={{ color: T.muted, fontSize: 16 }}>›</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // ABOUT UNIVERSITY
  // ═══════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════
  // PET / RELIEF PORTAL — separate world, no gold theme
  // ═══════════════════════════════════════════════════════
  const PetPortal = () => {
    const master = user.masterId ? (ACCTS[user.masterId] as any) : null;
    const isPet = user.isPet;
    const isRelief = user.isRelief;

    const PA = {
      bg: "#0a0000",
      card: "#120000",
      border: "#2a0000",
      red: "#8b0000",
      bright: "#cc2200",
      muted: "#5a2222",
      text: "#c8a0a0",
      dim: "#3a1515",
    };

    const pCard: any = {
      background: PA.card,
      border: `1px solid ${PA.border}`,
      borderRadius: 8,
      marginBottom: 10,
    };

    const masterCmds: any[] = master ? [
      { id: "c1", text: `Greet ${master.un} when they enter the room. Stand. Stay still.`, priority: "HIGH" },
      { id: "c2", text: `Submit your daily log by 10PM. Include mood, energy, and obedience rating.`, priority: "HIGH" },
      { id: "c3", text: `Do not speak first. Wait to be addressed.`, priority: "STANDING" },
      { id: "c4", text: `Complete the morning stretch routine before breakfast.`, priority: "DAILY" },
      { id: "c5", text: `Report any interaction with other masters immediately.`, priority: "STANDING" },
      { id: "c6", text: `Sleep position: designated side only. No movement after lights-out signal.`, priority: "NIGHTLY" },
      { id: "c7", text: `Polish ${isPet ? "collar" : "room tag"} before inspection.`, priority: "DAILY" },
    ] : [
      { id: "c1", text: "Await assignment. You have not been claimed.", priority: "STATUS" },
      { id: "c2", text: "Stay visible. Presentation matters.", priority: "STATUS" },
      { id: "c3", text: "Log your availability in the Relief Registry.", priority: "DAILY" },
    ];

    const trainingItems = [
      { id: "t1", icon: "📿", name: "Posture Drill", desc: "Stand straight for 15 minutes without movement. Focus.", duration: "15 min" },
      { id: "t2", icon: "🪞", name: "Presentation Check", desc: "Mirror exercise. Study yourself. Find every flaw. Correct them.", duration: "10 min" },
      { id: "t3", icon: "📖", name: "The Manual", desc: "Read Chapter 3: Anticipating Needs Before They Are Spoken.", duration: "20 min" },
      { id: "t4", icon: "🧘", name: "Stillness Practice", desc: "Sit without fidgeting. No phone. No sound. Just wait.", duration: "30 min" },
      { id: "t5", icon: "✍️", name: "Obedience Journal", desc: "Write three things you did well today. Write three you failed.", duration: "10 min" },
      { id: "t6", icon: "🫀", name: "Breath Control", desc: "4-count inhale. 4-count hold. 8-count exhale. Repeat until calm.", duration: "5 min" },
    ];

    const serveSchedule = [
      { time: "06:00", task: "Rise before master. Room prepared. No noise.", type: "MANDATORY" },
      { time: "07:00", task: "Morning presentation. Collar check. Hair. Posture.", type: "MANDATORY" },
      { time: "08:00", task: isPet ? "Attend to master's breakfast arrangements." : "Availability window — Room B open.", type: "SERVE" },
      { time: "10:00", task: "Obedience review. Reflect on yesterday's shortcomings.", type: "TRAINING" },
      { time: "12:00", task: isPet ? "Midday check-in. Wait in designated spot." : "Relief duty — logged in registry.", type: "SERVE" },
      { time: "14:00", task: "Posture and stillness practice. 30 minutes minimum.", type: "TRAINING" },
      { time: "16:00", task: isPet ? "Prepare master's afternoon environment." : "Maintenance window. Clean room. Full inspection ready.", type: "SERVE" },
      { time: "18:00", task: "Evening log. Mood. Energy. Obedience score.", type: "MANDATORY" },
      { time: "20:00", task: isPet ? "Evening attendance. Remain available until dismissed." : "Final availability. Do not leave corridor.", type: "SERVE" },
      { time: "22:00", task: "Collar/tag inspection. Submit daily report. Sleep position.", type: "MANDATORY" },
    ];

    const tutorial = [
      { n: "1. Silence is service.", b: "You do not need to speak to be useful. Mastering silence — being present without intruding — is the first and highest skill. Learn when to vanish. Learn when to appear." },
      { n: "2. Anticipate. Never react.", b: "Reacting is too slow. A good pet knows what is needed before it is asked. Study patterns. Learn schedules. Watch for signals." },
      { n: "3. Your body is not yours.", b: "Your posture, your expression, your position in a room — these are extensions of your master's image. They must always reflect care, discipline, and pride." },
      { n: "4. Obedience is not weakness.", b: "Choosing to obey — fully, without negotiation — is an act of extraordinary strength. Most people cannot do it. You are not most people." },
      { n: "5. The collar is not a punishment.", b: "It is an acknowledgment. You were selected. You carry something visible that most people will never understand. Wear it correctly." },
      { n: "6. Earn the next level.", b: "Trust is built in silence, in reliability, in small moments where you could have failed and didn't. Every day is a chance to become the best version of what you are." },
    ];

    const batteryColor = collarBattery > 60 ? "#8b0000" : collarBattery > 30 ? "#cc6600" : "#cc0000";

    const pNavItems = isPet
      ? [{ id: "collar", icon: "🔒", lab: "COLLAR" }, { id: "obey", icon: "⛓️", lab: "COMMANDS" }, { id: "train", icon: "📿", lab: "TRAINING" }, { id: "serve", icon: "🕯️", lab: "SCHEDULE" }, { id: "self", icon: "👤", lab: "SELF" }]
      : [{ id: "collar", icon: "🪑", lab: "STATUS" }, { id: "obey", icon: "📋", lab: "DUTIES" }, { id: "train", icon: "📿", lab: "TRAINING" }, { id: "serve", icon: "🕯️", lab: "SCHEDULE" }, { id: "self", icon: "👤", lab: "SELF" }];

    return (
      <div style={{ minHeight: "100vh", background: PA.bg, color: PA.text, fontFamily: "'Cormorant Garamond',Georgia,serif", paddingBottom: 80 }}>

        {/* ── COLLAR HOME ── */}
        {petNav === "collar" && (
          <div>
            <div style={{ background: "#0d0000", borderBottom: `1px solid ${PA.border}`, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: PA.red, letterSpacing: "0.15em" }}>
                {isPet ? "🔒 PET PORTAL" : "🪑 RELIEF UNIT"}
              </span>
              <span style={{ fontSize: 11, color: PA.muted }}>
                {user.handle}
              </span>
            </div>
            <div style={{ padding: 16 }}>
              {/* Collar visual */}
              <div style={{ ...pCard, padding: 24, textAlign: "center" as const, borderColor: PA.red + "66", background: "#0d0000" }}>
                <div style={{ fontSize: 64, marginBottom: 8, animation: "collarGlow 2s infinite" }}>
                  {isPet ? "🔒" : "🪑"}
                </div>
                <p style={{ fontFamily: "'Cinzel',serif", fontSize: 16, color: PA.red, letterSpacing: "0.12em", marginBottom: 4 }}>
                  {isPet ? (user.collarType || "STANDARD COLLAR") : `ROOM ${user.roomNumber || "UNASSIGNED"}`}
                </p>
                <p style={{ fontSize: 11, color: PA.muted, marginBottom: 16 }}>
                  {isPet ? `Property of ${master?.un || "Unassigned"}` : `Relief Unit · Usage Today: ${user.usageToday ?? 0}`}
                </p>
                {/* Battery */}
                <div style={{ marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: PA.muted, letterSpacing: "0.1em" }}>COLLAR CHARGE</span>
                    <span style={{ fontSize: 10, color: batteryColor }}>{collarBattery}%</span>
                  </div>
                  <div style={{ height: 8, background: PA.dim, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${collarBattery}%`, background: batteryColor, borderRadius: 4, transition: "width 0.5s" }} />
                  </div>
                  <p style={{ fontSize: 9, color: PA.muted, marginTop: 4 }}>
                    {collarBattery > 60 ? "Transmission nominal. Master receiving." : collarBattery > 30 ? "Signal weakening. Improve obedience." : "⚠ LOW CHARGE — Disobedience detected."}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
                  <button className="b" onClick={() => setCollarBattery(b => Math.min(100, b + 5))}
                    style={{ fontSize: 11, color: PA.red, background: "none", border: `1px solid ${PA.border}`, borderRadius: 5, padding: "5px 12px", cursor: "pointer" }}>
                    + Obey (+5%)
                  </button>
                  <button className="b" onClick={() => setCollarBattery(b => Math.max(0, b - 8))}
                    style={{ fontSize: 11, color: PA.muted, background: "none", border: `1px solid ${PA.dim}`, borderRadius: 5, padding: "5px 12px", cursor: "pointer" }}>
                    Disobey (−8%)
                  </button>
                </div>
              </div>
              {/* Master card */}
              {master && (
                <div style={{ ...pCard, padding: 14 }}>
                  <p style={{ fontSize: 10, color: PA.muted, letterSpacing: "0.1em", marginBottom: 8 }}>YOUR MASTER</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 8, background: PA.dim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, border: `1px solid ${PA.red}44`, overflow: "hidden" }}>
                      {renderPic(master.pic || "👤", 44)}
                    </div>
                    <div>
                      <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: PA.text, marginBottom: 2 }}>{master.un}</p>
                      <p style={{ fontSize: 11, color: PA.muted }}>{master.handle} · {master.badge}</p>
                    </div>
                  </div>
                </div>
              )}
              {/* Status */}
              <div style={{ ...pCard, padding: 14 }}>
                <p style={{ fontSize: 10, color: PA.muted, letterSpacing: "0.1em", marginBottom: 10 }}>CURRENT STATUS</p>
                {[
                  ["Obedience", `${Math.max(0, collarBattery - 10)}%`],
                  ["Commands completed today", `${completedCmds.length} / ${masterCmds.length}`],
                  ["Training sessions", "0"],
                  isPet ? ["Collar type", user.collarType || "Standard"] : ["Room", user.roomNumber || "—"],
                  ["Clearance", isPet ? "Pet — no autonomy" : "Relief — room access only"],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${PA.border}33` }}>
                    <span style={{ fontSize: 11, color: PA.muted }}>{k}</span>
                    <span style={{ fontSize: 11, color: PA.text }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── COMMANDS / DUTIES ── */}
        {petNav === "obey" && (
          <div>
            <div style={{ background: "#0d0000", borderBottom: `1px solid ${PA.border}`, padding: "14px 16px" }}>
              <span style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: PA.red, letterSpacing: "0.15em" }}>
                {isPet ? "⛓️ MASTER'S COMMANDS" : "📋 DUTIES"}
              </span>
            </div>
            <div style={{ padding: 16 }}>
              <p style={{ fontSize: 11, color: PA.muted, marginBottom: 14, textAlign: "center" as const }}>
                {completedCmds.length === masterCmds.length
                  ? "All commands completed. Await further instruction."
                  : `${masterCmds.length - completedCmds.length} command${masterCmds.length - completedCmds.length !== 1 ? "s" : ""} remaining. You do not rest until these are done.`}
              </p>
              {masterCmds.map(cmd => {
                const done = completedCmds.includes(cmd.id);
                const priorityColor = cmd.priority === "HIGH" ? "#cc2200" : cmd.priority === "STANDING" ? "#8b4400" : "#5a5a22";
                return (
                  <div key={cmd.id} style={{ ...pCard, padding: 14, opacity: done ? 0.5 : 1, borderColor: done ? PA.dim : PA.border }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 9, color: priorityColor, letterSpacing: "0.1em", display: "block", marginBottom: 5 }}>{cmd.priority}</span>
                        <p style={{ fontSize: 13, color: done ? PA.muted : PA.text, lineHeight: 1.6, textDecoration: done ? "line-through" : "none" }}>{cmd.text}</p>
                      </div>
                      <button className="b"
                        onClick={() => {
                          if (done) { setCompletedCmds(cs => cs.filter(c => c !== cmd.id)); setCollarBattery(b => Math.max(0, b - 3)); }
                          else { setCompletedCmds(cs => [...cs, cmd.id]); setCollarBattery(b => Math.min(100, b + 5)); toast("Command marked complete. +5% charge."); }
                        }}
                        style={{ fontSize: 11, color: done ? PA.muted : PA.red, background: "none", border: `1px solid ${done ? PA.dim : PA.border}`, borderRadius: 5, padding: "5px 10px", cursor: "pointer", flexShrink: 0 }}>
                        {done ? "✓ Done" : "Mark Done"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── TRAINING ── */}
        {petNav === "train" && (
          <div>
            <div style={{ background: "#0d0000", borderBottom: `1px solid ${PA.border}`, padding: "14px 16px" }}>
              <span style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: PA.red, letterSpacing: "0.15em" }}>📿 TRAINING & TUTORIAL</span>
            </div>
            <div style={{ padding: 16 }}>
              <p style={{ fontSize: 11, color: PA.muted, marginBottom: 14, textAlign: "center" as const }}>
                Items left by your master. Complete them. No excuses.
              </p>

              {/* Training drills */}
              <p style={{ fontSize: 10, color: PA.muted, letterSpacing: "0.12em", marginBottom: 8 }}>TRAINING DRILLS</p>
              {trainingItems.map(item => (
                <div key={item.id} style={{ ...pCard, padding: 14 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 24, flexShrink: 0 }}>{item.icon}</span>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontFamily: "'Cinzel',serif", fontSize: 12, color: PA.text, marginBottom: 3 }}>{item.name}</p>
                      <p style={{ fontSize: 12, color: PA.muted, lineHeight: 1.6, marginBottom: 6 }}>{item.desc}</p>
                      <span style={{ fontSize: 9, color: PA.red, border: `1px solid ${PA.border}`, borderRadius: 4, padding: "2px 7px", letterSpacing: "0.08em" }}>{item.duration}</span>
                    </div>
                  </div>
                </div>
              ))}

              {/* Best Pet Tutorial */}
              <div style={{ marginTop: 20 }}>
                <p style={{ fontSize: 10, color: PA.muted, letterSpacing: "0.12em", marginBottom: 8 }}>HOW TO BE THE BEST PET IN THE WORLD</p>
                <div style={{ ...pCard, padding: 14, borderColor: PA.red + "33", background: "#0d0000" }}>
                  <p style={{ fontSize: 11, color: PA.muted, marginBottom: 12, fontStyle: "italic" }}>
                    This is not advice. These are laws. Internalize them.
                  </p>
                  {tutorial.map(t => (
                    <div key={t.n} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${PA.border}33` }}>
                      <p style={{ fontFamily: "'Cinzel',serif", fontSize: 11, color: PA.red, marginBottom: 5, letterSpacing: "0.05em" }}>{t.n}</p>
                      <p style={{ fontSize: 12, color: PA.text, lineHeight: 1.7 }}>{t.b}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── SERVE SCHEDULE ── */}
        {petNav === "serve" && (
          <div>
            <div style={{ background: "#0d0000", borderBottom: `1px solid ${PA.border}`, padding: "14px 16px" }}>
              <span style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: PA.red, letterSpacing: "0.15em" }}>🕯️ YOUR SCHEDULE</span>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ textAlign: "center" as const, padding: "12px 0 16px" }}>
                <p style={{ fontFamily: "'Cinzel',serif", fontSize: 11, color: PA.muted, letterSpacing: "0.2em" }}>
                  SERVE · SERVE · SERVE
                </p>
                <p style={{ fontSize: 11, color: PA.muted, marginTop: 4 }}>This is your timetable. There are no classes. There is only service.</p>
              </div>
              {serveSchedule.map((slot, idx) => {
                const typeColor = slot.type === "MANDATORY" ? "#cc2200" : slot.type === "SERVE" ? "#8b0000" : "#5a4422";
                return (
                  <div key={idx} style={{ ...pCard, padding: "10px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ flexShrink: 0, width: 46, textAlign: "right" as const }}>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: PA.muted }}>{slot.time}</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 9, color: typeColor, letterSpacing: "0.1em", display: "block", marginBottom: 3 }}>{slot.type}</span>
                      <p style={{ fontSize: 13, color: PA.text, lineHeight: 1.5 }}>{slot.task}</p>
                    </div>
                  </div>
                );
              })}
              <div style={{ ...pCard, padding: 14, marginTop: 8, textAlign: "center" as const, background: "#0d0000" }}>
                <p style={{ fontFamily: "'Cinzel',serif", fontSize: 10, color: PA.muted, letterSpacing: "0.2em" }}>
                  THERE ARE NO FREE PERIODS
                </p>
                <p style={{ fontSize: 11, color: PA.muted, marginTop: 4 }}>If you are not serving, you are training. If you are not training, you are resting in preparation to serve. That is all.</p>
              </div>
            </div>
          </div>
        )}

        {/* ── SELF / PROFILE ── */}
        {petNav === "self" && (
          <div>
            <div style={{ background: "#0d0000", borderBottom: `1px solid ${PA.border}`, padding: "14px 16px" }}>
              <span style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: PA.red, letterSpacing: "0.15em" }}>👤 SELF</span>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ ...pCard, padding: 20, textAlign: "center" as const }}>
                <div style={{ fontSize: 52, marginBottom: 8, display: "flex", justifyContent: "center" }}>{renderPic(user.pic || "🔒", 52)}</div>
                <p style={{ fontFamily: "'Cinzel',serif", fontSize: 15, color: PA.text, marginBottom: 3 }}>{user.un}</p>
                <p style={{ fontSize: 11, color: PA.muted, marginBottom: 8 }}>{user.handle}</p>
                <div style={{ display: "inline-block", background: PA.dim, border: `1px solid ${PA.border}`, borderRadius: 12, padding: "3px 12px", fontSize: 10, color: PA.red, letterSpacing: "0.1em" }}>
                  {user.badge || (isPet ? "🔒 PET" : "⬜ RELIEF")}
                </div>
              </div>
              <div style={{ ...pCard, padding: 14 }}>
                {user.bio ? (
                  <p style={{ fontSize: 13, color: PA.text, lineHeight: 1.7, fontStyle: "italic" }}>&ldquo;{user.bio}&rdquo;</p>
                ) : (
                  <p style={{ fontSize: 12, color: PA.muted, fontStyle: "italic" }}>No bio. You have not been given permission to write one.</p>
                )}
              </div>
              <div style={{ ...pCard, padding: 14 }}>
                <p style={{ fontSize: 10, color: PA.muted, letterSpacing: "0.1em", marginBottom: 10 }}>RECORD</p>
                {[
                  ["Tier", isPet ? "Pet" : "Relief Unit"],
                  ["Covenant", user.cov || "None"],
                  isPet ? ["Collar", user.collarType || "Standard"] : ["Room", user.roomNumber || "—"],
                  isPet ? ["Master", master?.un || "Unassigned"] : ["Availability", "Available"],
                  ["Posting rights", isPet ? "Restricted" : "None"],
                  ["Wallet access", "None — you do not use currency"],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${PA.border}33` }}>
                    <span style={{ fontSize: 11, color: PA.muted }}>{k}</span>
                    <span style={{ fontSize: 11, color: PA.text }}>{v}</span>
                  </div>
                ))}
              </div>
              <button className="b" onClick={() => { setUid(null); setScreen("login"); }}
                style={{ width: "100%", padding: 12, fontSize: 12, color: PA.muted, background: "none", border: `1px solid ${PA.dim}`, borderRadius: 6, cursor: "pointer", marginTop: 8 }}>
                LEAVE PORTAL
              </button>
            </div>
          </div>
        )}

        {/* ── PET NAV BAR ── */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#0d0000", borderTop: `1px solid ${PA.border}`, display: "flex", justifyContent: "space-around", alignItems: "center", padding: "6px 0 10px", zIndex: 100 }}>
          {pNavItems.map(item => (
            <button key={item.id} type="button" className="b"
              onClick={() => setPetNav(item.id)}
              style={{ background: "none", border: "none", display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 2, padding: "4px 8px", cursor: "pointer" }}>
              <span style={{ fontSize: 18, filter: petNav === item.id ? "none" : "grayscale(0.7) brightness(0.5)" }}>{item.icon}</span>
              <span style={{ fontSize: 9, letterSpacing: "0.08em", color: petNav === item.id ? PA.red : PA.muted, fontFamily: "'Cinzel',serif" }}>{item.lab}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const AboutUniversity = () => {
    const sections = [
      {
        icon: "🌑",
        title: "NOCTIS UNIVERSITY",
        subtitle: "Est. 1847 · Acceptance Rate: 1–2%",
        body: "Founded in 1847 by a coalition of twelve powerful families seeking to consolidate generational influence through education. The campus spans 800 acres of pristine land, featuring gothic stone architecture and cutting-edge modern facilities. A Noctis degree opens every door — graduates dominate Fortune 500 companies, political offices, international organisations, and elite industries worldwide. The University operates with near-sovereign autonomy, answering to no external authority. What happens at Noctis stays at Noctis. This is the first thing every student learns.",
      },
      {
        icon: "🏰",
        title: "THE COVENANTS",
        subtitle: "Four Houses. One Order.",
        body: "Noctis operates through four Covenant affiliations that shape every student's social reality. Crowns (power, legacy, politics), Silk (aesthetics, social capital, charm), Shadows (intelligence, strategy, information), and Blades (strength, honour, competition). Your Covenant is not chosen — it chooses you. Covenant affiliation dictates housing, social circles, career pathways, and access to restricted university facilities. The Covenants do not officially exist in university documentation.",
      },
      {
        icon: "📚",
        title: "ACADEMIC PHILOSOPHY",
        subtitle: "Dual Concentration · Apex Leadership · Research Classified",
        body: "NU requires all students to complete a mandatory dual-concentration system, forcing expertise in seemingly opposite fields — Art + Engineering, Psychology + Finance, Law + Medicine. The most elite programme is the Apex Leadership Track: only twenty students per year are selected. Research opportunities connect students directly to corporate and government projects, often classified in nature. NU faculty are Nobel laureates, former heads of state, and industry titans. Professors are functionally untouchable by university policy.",
      },
      {
        icon: "💀",
        title: "DISCIPLINE & CONSEQUENCES",
        subtitle: "The Tribunal. The Archive. The Silence.",
        body: "Disciplinary matters at Noctis are not handled by conventional academic boards. The Tribunal — a body of senior faculty, Covenant representatives, and anonymous alumni delegates — convenes privately. Records of its decisions are sealed. Punishments range from social erasure to involuntary medical leave to quiet expulsion with documentation altered to protect family reputations. The most severe outcome has no formal name. Former students who crossed certain lines are simply no longer discussed.",
      },
      {
        icon: "🌐",
        title: "ALUMNI NETWORK",
        subtitle: "The Longest Reach in the World",
        body: "The NU alumni network is, by any measure, the most powerful informal network of influence on the planet. Alumni currently occupy eleven heads of state positions, forty-three Fortune 100 board seats, and three current positions within international intelligence bodies. The annual Alumni Endowment Ceremony results in scholarship donations, research grants, and facility investments exceeding ₦4 billion annually. Alumni are obligated, by tradition, to respond to requests from fellow NU graduates. This obligation is not written anywhere.",
      },
      {
        icon: "🔒",
        title: "RESTRICTED KNOWLEDGE",
        subtitle: "What Is Known. What Is Not Said.",
        body: "There are facilities on this campus that do not appear on any map. There are research programmes not listed in the academic catalogue. There is an annual event that has no official name, no guest list, and no photographic record. Three separate student-facing portals — including UMBRA — exist without formal university acknowledgment. The Library's basement level is accessible only by invitation. The Apex Vault is not a metaphor. What you do not yet know about Noctis is likely more important than what you do.",
      },
    ];
    return (
      <div style={{ paddingBottom: 100, background: "#000" }}>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto" }}>
            <span style={ttl()}>🌑 ABOUT NOCTIS</span>
          </div>
        </div>
        <div style={sec}>
          <div style={{ textAlign: "center", padding: "12px 0 20px" }}>
            <div className="flt" style={{ fontSize: 52, marginBottom: 8 }}>🌑</div>
            <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: T.muted, letterSpacing: "0.1em" }}>
              NOCTIS UNIVERSITY · FOUNDED 1847 · IN TENEBRIS VERITAS
            </p>
            <p style={{ fontSize: 11, color: "#6a5840", marginTop: 4 }}>"In Darkness, Truth." — University Motto</p>
          </div>
          {sections.map((s, i) => (
            <div key={i} style={{ marginBottom: 18, background: "#0d0d0d", border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 22 }}>{s.icon}</span>
                <div>
                  <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: T.primary, marginBottom: 2 }}>{s.title}</p>
                  <p style={{ fontSize: 10, color: T.muted }}>{s.subtitle}</p>
                </div>
              </div>
              <p style={{ fontSize: 13, color: "#bba88a", lineHeight: 1.65, fontFamily: "Georgia,serif" }}>{s.body}</p>
            </div>
          ))}
          <div style={{ textAlign: "center", padding: "12px 0 8px" }}>
            <p style={{ fontSize: 10, color: "#362e1e", fontFamily: "'Cinzel',serif", letterSpacing: "0.15em" }}>
              THIS INFORMATION IS NOT FOR DISTRIBUTION OUTSIDE UMBRA NETWORK
            </p>
          </div>
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // DARK WEB STORE
  // ═══════════════════════════════════════════════════════
  const DarkWebStore = () => {
    if (!isApex) {
      return (
        <div style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⛔</div>
          <p style={{ fontFamily: "'Cinzel',serif", color: "#ff0044", fontSize: 16 }}>ACCESS DENIED</p>
          <p style={{ color: "#7a4040", fontSize: 13, marginTop: 8 }}>The Dark Corridor is restricted to Apex and Masters tier students only.</p>
          <button className="b" onClick={() => setSubPage("")} style={{ marginTop: 20, ...btn(false), padding: "10px 20px" }}>← BACK</button>
        </div>
      );
    }
    const darkItems = [
      { id: "dk1", icon: "🧪", name: "Cognitive Enhancement Serum", price: 8500, desc: "Pharmaceutical-grade nootropics. Not on any approved list. GPA improvement: statistically significant.", tag: "Pharmacology", risk: "High" },
      { id: "dk2", icon: "📂", name: "Tribunal Record Expungement", price: 75000, desc: "A contact in Records Management. Disciplinary entries disappear. Discretion guaranteed or your money returned.", tag: "Documents", risk: "Extreme" },
      { id: "dk3", icon: "🔑", name: "Restricted Facility Access Key", price: 22000, desc: "Biometric-spoofed pass for B-Level Library and Research Wing 7. Single use.", tag: "Access", risk: "High" },
      { id: "dk4", icon: "📋", name: "Examination Pre-Release", price: 40000, desc: "Forty-eight hour advance access to sealed examination papers for three courses of your choice.", tag: "Academic", risk: "Extreme" },
      { id: "dk5", icon: "🤫", name: "Covenant Intelligence Dossier", price: 15000, desc: "Compiled intelligence on a rival Covenant faction's current activities. Verified by two independent sources.", tag: "Intelligence", risk: "Medium" },
      { id: "dk6", icon: "🎭", name: "Phantom Attendance Service", price: 5000, desc: "Professional proxy attendance. Biometric data-matched for recognition systems. Up to six weeks.", tag: "Services", risk: "Medium" },
      { id: "dk7", icon: "💊", name: "Apex Tier Social Accelerant", price: 12000, desc: "A connection brokered to one senior Apex student of your choice. One private meeting, no questions asked.", tag: "Social", risk: "Low" },
      { id: "dk8", icon: "🗝️", name: "Chancellor's Calendar Insertion", price: 120000, desc: "Your name added to the Chancellor's private diary for a fifteen-minute unlogged meeting. Origin: unknown.", tag: "Access", risk: "Extreme" },
      { id: "dk9", icon: "📱", name: "Surveillance Blind Spot Report", price: 9000, desc: "Campus CCTV dead zones mapped and timestamped. Updated weekly.", tag: "Intelligence", risk: "Low" },
      { id: "dk10", icon: "✍️", name: "Ghost-Written Thesis", price: 35000, desc: "PhD-level academic authorship. Passed through plagiarism detection pre-submission. Guarantee: First Class.", tag: "Academic", risk: "High" },
    ];

    const riskColor = (r: string) => r === "Extreme" ? "#ff0044" : r === "High" ? "#ff6600" : r === "Medium" ? "#ffcc00" : "#00ff88";

    return (
      <div style={{ paddingBottom: 100, background: "#000" }}>
        <div style={{ ...hdr, background: "#0a0010", borderBottom: "1px solid #7700ff" }}>
          <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", gap: 10 }}>
            <button className="b" onClick={() => setSubPage("")} style={{ background: "none", border: "none", color: "#ff00bb", fontSize: 18, cursor: "pointer" }}>←</button>
            <span style={{ ...ttl(), color: "#ff00bb" }}>🕸️ THE DARK CORRIDOR</span>
          </div>
        </div>
        <div style={sec}>
          <div style={{ background: "#12001a", border: "1px solid #7700ff", borderRadius: 8, padding: "12px 14px", marginBottom: 16 }}>
            <p style={{ color: "#ff00bb", fontFamily: "'Cinzel',serif", fontSize: 12, marginBottom: 4 }}>⚠ ENTER AT OWN RISK</p>
            <p style={{ fontSize: 11, color: "#9955cc", lineHeight: 1.6 }}>
              The Dark Corridor operates outside all university policy and jurisdiction. All transactions are anonymous, irreversible, and unlogged. Your presence here is already noted. Discretion is not optional — it is the only currency that matters.
            </p>
            <p style={{ fontSize: 10, color: "#55224a", marginTop: 6 }}>Balance: <span style={{ color: "#ff00bb" }}>₦{walletBalance.toLocaleString()}</span></p>
          </div>
          {darkItems.map(item => (
            <div key={item.id} style={{ marginBottom: 12, background: "#0d0010", border: "1px solid #440066", borderRadius: 8, padding: "14px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 20 }}>{item.icon}</span>
                    <span style={{ fontFamily: "'Cinzel',serif", fontSize: 12, color: "#cc88ff" }}>{item.name}</span>
                  </div>
                  <p style={{ fontSize: 11, color: "#9966aa", lineHeight: 1.55, marginBottom: 6 }}>{item.desc}</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span style={{ fontSize: 9, color: "#663388", background: "#1a0022", border: "1px solid #440055", borderRadius: 4, padding: "2px 6px" }}>{item.tag}</span>
                    <span style={{ fontSize: 9, color: riskColor(item.risk), background: "#0d000d", border: `1px solid ${riskColor(item.risk)}44`, borderRadius: 4, padding: "2px 6px" }}>RISK: {item.risk}</span>
                  </div>
                </div>
                <button
                  className="b"
                  onClick={() => {
                    if (walletBalance < item.price) { toast("Insufficient funds."); return; }
                    setWalletBalance(prev => Math.max(0, prev - item.price));
                    toast(`Transaction complete. ${item.name} delivered. No record.`);
                  }}
                  style={{ background: "#22003a", border: "1px solid #ff00bb", borderRadius: 6, color: "#ff00bb", padding: "8px 12px", fontSize: 11, fontFamily: "'Cinzel',serif", whiteSpace: "nowrap", cursor: "pointer" }}
                >
                  ₦{item.price.toLocaleString()}
                </button>
              </div>
            </div>
          ))}
          <div style={{ textAlign: "center", padding: "12px 0 8px" }}>
            <p style={{ fontSize: 9, color: "#330033", fontFamily: "'Cinzel',serif", letterSpacing: "0.1em" }}>ALL TRANSACTIONS ARE PERMANENT · NO REFUNDS · NO RECORDS</p>
          </div>
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // UNI TIMETABLE
  // ═══════════════════════════════════════════════════════
  const UniTimetable = () => {
    const covColors: Record<string,string> = {
      crowns: "#d4af37", silk: "#cc88aa", blades: "#7a9ab0", shadows: "#9944cc",
    };
    const TIMETABLE: Record<string, Record<string, string[][]>> = {
      crowns: {
        Freshman:  [["Mon","Tue","Wed","Thu","Fri"],["Power & Society 101","—","Power & Society 101","Strategic Rhetoric","—"],["—","Finance Foundations","—","Finance Foundations","Executive Presence"],["Ethics of Power (elective)","—","Ethics of Power (elective)","—","Heritage Seminar"]],
        Sophomore: [["Mon","Tue","Wed","Thu","Fri"],["Political Theory","—","Political Theory","Corporate Law I","—"],["—","Behavioral Economics","—","Behavioral Economics","Legacy Studies"],["Covenant History","—","Covenant History","—","Leadership Lab"]],
        Junior:    [["Mon","Tue","Wed","Thu","Fri"],["International Finance","—","International Finance","Sovereignty Law","—"],["—","Power Structures","—","Power Structures","Private Governance"],["Research Methods","—","Research Methods","—","Mentorship Hour"]],
        Senior:    [["Mon","Tue","Wed","Thu","Fri"],["Thesis Research","—","Thesis Research","—","Thesis Research"],["—","Advanced Finance","—","Advanced Finance","—"],["Final Seminar","—","Final Seminar","—","Graduation Prep"]],
      },
      silk: {
        Freshman:  [["Mon","Tue","Wed","Thu","Fri"],["The Art of Influence","—","The Art of Influence","Aesthetic Theory","—"],["—","Fashion & Power","—","Fashion & Power","Social Architecture"],["Psychology of Desire","—","Psychology of Desire","—","Silk History"]],
        Sophomore: [["Mon","Tue","Wed","Thu","Fri"],["Rhetoric & Seduction","—","Rhetoric & Seduction","Media & Image","—"],["—","Literature of Control","—","Literature of Control","Cultural Capital"],["Event Architecture","—","Event Architecture","—","Covenant Practicum"]],
        Junior:    [["Mon","Tue","Wed","Thu","Fri"],["Advanced Aesthetics","—","Advanced Aesthetics","Brand Power","—"],["—","Psychology of Compliance","—","Psychology of Compliance","Elite Networks"],["Gothic Fiction","—","Gothic Fiction","—","Fieldwork"]],
        Senior:    [["Mon","Tue","Wed","Thu","Fri"],["Thesis: Power & Beauty","—","Thesis: Power & Beauty","—","Thesis: Power & Beauty"],["—","Independent Study","—","Independent Study","—"],["Salon Seminar","—","Salon Seminar","—","Exit Interview"]],
      },
      blades: {
        Freshman:  [["Mon","Tue","Wed","Thu","Fri"],["Combat Fundamentals","Combat Fundamentals","—","Combat Fundamentals","Combat Fundamentals"],["—","Strategy & Tactics","—","Strategy & Tactics","Physical Training"],["Military History","—","Military History","—","Covenant Induction"]],
        Sophomore: [["Mon","Tue","Wed","Thu","Fri"],["Advanced Combat","Advanced Combat","—","Advanced Combat","Advanced Combat"],["—","Crisis Decision Theory","—","Crisis Decision Theory","Physical Training"],["Law & Force","—","Law & Force","—","Fieldwork I"]],
        Junior:    [["Mon","Tue","Wed","Thu","Fri"],["Combat Strategy","Combat Strategy","—","Combat Strategy","Combat Strategy"],["—","Command Theory","—","Command Theory","Physical Training"],["International Security","—","International Security","—","Fieldwork II"]],
        Senior:    [["Mon","Tue","Wed","Thu","Fri"],["Thesis: Security & Control","—","Thesis: Security & Control","—","Thesis: Security & Control"],["—","Advanced Strategy","—","Advanced Strategy","Physical Training"],["Capstone Seminar","—","Capstone Seminar","—","Exit Assessment"]],
      },
      shadows: {
        Freshman:  [["Mon","Tue","Wed","Thu","Fri"],["Information Theory","—","Information Theory","Cryptography I","—"],["—","Intelligence Foundations","—","Intelligence Foundations","Digital Surveillance"],["Shadows History","—","Shadows History","—","Covenant Induction"]],
        Sophomore: [["Mon","Tue","Wed","Thu","Fri"],["Data & Power","—","Data & Power","Cryptography II","—"],["—","Behavioral Analysis","—","Behavioral Analysis","Network Mapping"],["Systems Architecture","—","Systems Architecture","—","Practicum I"]],
        Junior:    [["Mon","Tue","Wed","Thu","Fri"],["Advanced Intelligence","—","Advanced Intelligence","Counter-Intelligence","—"],["—","Cognitive Compliance","—","Cognitive Compliance","Operational Design"],["Power Structures","—","Power Structures","—","Practicum II"]],
        Senior:    [["Mon","Tue","Wed","Thu","Fri"],["Thesis: The Architecture of Power","—","Thesis: The Architecture of Power","—","Thesis: The Architecture of Power"],["—","Advanced Systems","—","Advanced Systems","—"],["Placement Seminar","—","Placement Seminar","—","Exit Briefing"]],
      },
    };
    const DEGREE_TRACKS: Record<string, Record<string, string[]>> = {
      "Corporate Law": {
        Freshman: ["Legal Systems 101","Contract Theory","Constitutional Foundations","Academic Writing for Law","Legal Research Lab"],
        Sophomore: ["Tort Law","Business Organisations","Equity & Trusts","Negotiation Theory","Covenant Law Elective"],
        Junior: ["Corporate Transactions","Mergers & Acquisitions","Intellectual Property","International Trade Law","Moot Court I"],
        Senior: ["Thesis: Power & Law","Advanced M&A Clinic","Boardroom Strategy","Moot Court II (Final)","Alumni Mentorship"],
      },
      "Medicine & Bioethics": {
        Freshman: ["Human Anatomy","Cell Biology","Organic Chemistry I","Medical Ethics 101","Clinical Observation"],
        Sophomore: ["Physiology","Pharmacology I","Organic Chemistry II","Bioethics in Practice","Patient Communication"],
        Junior: ["Pathology","Clinical Medicine I","Pharmacology II","Research Design","Hospital Placement"],
        Senior: ["Thesis: Bioethics","Clinical Medicine II","Specialty Rotation","Ethics Board Seminar","Final Clinical"],
      },
      "Artificial Intelligence & Computer Science": {
        Freshman: ["Programming Fundamentals","Linear Algebra","Discrete Mathematics","Intro to AI","Data Structures"],
        Sophomore: ["Machine Learning I","Probability & Statistics","Database Systems","Neural Networks","Algorithm Design"],
        Junior: ["Advanced ML","Computer Vision","Natural Language Processing","AI Ethics","Industry Placement"],
        Senior: ["Thesis: Applied AI","Reinforcement Learning","Research Lab","AI Policy Seminar","Exit Presentation"],
      },
      "Apex Leadership Track": {
        Freshman: ["Power Theory","Foundations of Influence","Covenant Politics","Executive Communication","Apex Induction Seminar"],
        Sophomore: ["Strategic Decision Making","Economic Power","Geopolitical Analysis","Leadership Psychology","Simulation I"],
        Junior: ["Crisis Management","Global Finance","Intelligence & Strategy","Covenant Advanced Track","Simulation II"],
        Senior: ["Thesis: Architecture of Power","Legacy Design","Private Governance","Classified Seminar","Succession Planning"],
      },
      "Political Science & Governance": {
        Freshman: ["Political Theory","Government Structures","History of Power","Academic Research","Rhetoric I"],
        Sophomore: ["Comparative Politics","Public Policy","Electoral Strategy","International Relations","Political Communication"],
        Junior: ["Governance & Law","Policy Analysis","Diplomacy Lab","Electoral Simulation","External Placement"],
        Senior: ["Thesis: Power Systems","Advanced Governance","Political Strategy Clinic","Cabinet Simulation","Final Presentation"],
      },
      "Economics & Finance": {
        Freshman: ["Microeconomics","Macroeconomics","Financial Mathematics","Introduction to Markets","Research Methods"],
        Sophomore: ["Corporate Finance","Econometrics","Investment Theory","Behavioural Economics","Portfolio Lab"],
        Junior: ["Advanced Finance","Risk Management","International Economics","Derivatives & Instruments","Industry Placement"],
        Senior: ["Thesis: Financial Architecture","Structured Finance","Macro Strategy","Alumni Network Seminar","Exit Review"],
      },
      "Psychology & Behavioural Science": {
        Freshman: ["Introduction to Psychology","Research Methods","Cognitive Science","Statistics for Behavioural Research","Social Psychology"],
        Sophomore: ["Personality Theory","Abnormal Psychology","Quantitative Methods","Perception & Cognition","Lab Research I"],
        Junior: ["Behavioural Economics","Compliance Psychology","Applied Clinical","Social Influence","Lab Research II"],
        Senior: ["Thesis: Compliance Architecture","Advanced Cognitive Science","Ethics of Influence","Applied Fieldwork","Exit Seminar"],
      },
      "Architecture & Urban Design": {
        Freshman: ["Architectural Drawing","History of Architecture","Materials & Structures","Design Studio I","Environmental Design"],
        Sophomore: ["Structural Engineering","Urban Theory","Design Studio II","Digital Architecture","Site Analysis"],
        Junior: ["Advanced Studio","Urban Planning","Building Technology","Sustainable Design","External Placement"],
        Senior: ["Thesis Project","Final Studio Review","Client Presentation","Architectural Ethics","Portfolio Completion"],
      },
      "Philosophy & Ethics": {
        Freshman: ["History of Philosophy","Logic & Reasoning","Epistemology","Ethics I","Academic Writing"],
        Sophomore: ["Political Philosophy","Philosophy of Mind","Ethics II","Metaphysics","Independent Study I"],
        Junior: ["Philosophy of Power","Contemporary Ethics","Covenant Philosophy Elective","Research Seminar","Independent Study II"],
        Senior: ["Thesis: Ethics of Power","Advanced Political Philosophy","Moral Philosophy Clinic","Symposium","Exit Presentation"],
      },
      "Literature & Cultural Theory": {
        Freshman: ["Introduction to Literature","Cultural Theory I","Writing Workshop","World Literature","Research Skills"],
        Sophomore: ["Literary Theory","Gothic Literature","Cultural Capital","Creative Writing","Interdisciplinary Study"],
        Junior: ["Advanced Theory","Power & Narrative","Archival Research","Publication Workshop","External Placement"],
        Senior: ["Thesis: Narrative & Power","Independent Study","Editing Seminar","Publication Final","Exit Review"],
      },
    };

    const myMajor = user.major || "Undeclared";
    const myTrack = DEGREE_TRACKS[myMajor];
    const myDegreeSchedule = myTrack ? (myTrack[ttYear] || []) : [];
    const isApexTrack = myMajor === "Apex Leadership Track";

    const years = ["Freshman", "Sophomore", "Junior", "Senior"];
    const covs = ["crowns", "silk", "blades", "shadows"];
    const covLabels: Record<string,string> = { crowns: "👑 CROWNS", silk: "🌸 SILK", blades: "⚔️ BLADES", shadows: "👁️ SHADOWS" };
    const schedule = TIMETABLE[ttCov]?.[ttYear] || [];
    const days = schedule[0] || [];
    const rows = schedule.slice(1);
    return (
      <div>
        {SubHdr({ title: "📅 COVENANT TIMETABLE" })}
        <div style={sec}>
          {myTrack && (
            <div style={{ marginBottom: 18, background: isApexTrack ? "#1a1000" : "#0d1a0d", border: `1px solid ${isApexTrack ? "#d4af37" : "#336633"}`, borderRadius: 10, padding: "14px 12px" }}>
              <p style={{ fontFamily: "'Cinzel',serif", fontSize: 12, color: isApexTrack ? "#d4af37" : "#44aa44", marginBottom: 4 }}>
                📋 MY DEGREE TRACK — {myMajor.toUpperCase()}
              </p>
              <p style={{ fontSize: 10, color: isApexTrack ? "#a89060" : "#557755", marginBottom: 10 }}>
                {ttYear} curriculum · {myMajor}
                {isApexTrack && " · ⚡ APEX CLASSIFIED CONTENT INCLUDED"}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
                {myDegreeSchedule.map((course, i) => (
                  <div key={i} style={{ background: isApexTrack ? "#2a1a00" : "#0a1a0a", border: `1px solid ${isApexTrack ? "#8b6a00" : "#225522"}`, borderRadius: 6, padding: "6px 10px", fontSize: 11, color: isApexTrack ? "#d4af37" : "#77cc77" }}>
                    {course}
                  </div>
                ))}
              </div>
              {isApexTrack && isApex && (
                <div style={{ marginTop: 10, background: "#2a0a0a", border: "1px solid #ff4400", borderRadius: 6, padding: "8px 10px" }}>
                  <p style={{ fontSize: 10, color: "#ff6600", fontFamily: "'Cinzel',serif" }}>⚡ APEX RESTRICTED — ADDITIONAL FUNCTIONS</p>
                  <p style={{ fontSize: 11, color: "#cc4400", marginTop: 4 }}>
                    The Apex Leadership Track includes access to classified seminars, private briefings from government officials, and strategic placement into Covenant power structures. Specific session details are delivered via encrypted message to your UMBRA inbox only.
                  </p>
                </div>
              )}
            </div>
          )}
          {myMajor === "Undeclared" && (
            <div style={{ marginBottom: 14, background: "#1a1409", border: "1px solid #362e1e", borderRadius: 8, padding: "12px" }}>
              <p style={{ fontSize: 12, color: "#9a8868" }}>You have not declared a major. Your timetable shows only the Covenant track below.</p>
            </div>
          )}
          <div style={{ marginBottom: 14 }}>
            <p style={{ ...lbl, marginBottom: 6 }}>COVENANT</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
              {covs.map(c => (
                <button key={c} type="button" className="b" onClick={() => setTtCov(c)} style={{ ...btn(ttCov === c), padding: "6px 14px", fontSize: 11, background: ttCov === c ? covColors[c] : T.tag, color: ttCov === c ? "#fff" : T.text }}>
                  {covLabels[c]}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <p style={{ ...lbl, marginBottom: 6 }}>YEAR</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
              {years.map(y => (
                <button key={y} type="button" className="b" onClick={() => setTtYear(y)} style={{ ...btn(ttYear === y), padding: "6px 14px", fontSize: 11 }}>
                  {y}
                </button>
              ))}
            </div>
          </div>
          <div style={{ ...card, overflowX: "auto" as const }}>
            <p style={{ ...lbl, padding: "10px 12px 6px", borderBottom: `1px solid ${T.border}`, color: covColors[ttCov] }}>
              {covLabels[ttCov]} — {ttYear.toUpperCase()} SCHEDULE
            </p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: `${covColors[ttCov]}18` }}>
                  <th style={{ padding: "8px 10px", textAlign: "left", color: T.muted, fontWeight: 600, whiteSpace: "nowrap" as const }}>PERIOD</th>
                  {days.map((d, i) => (
                    <th key={i} style={{ padding: "8px 10px", textAlign: "center", color: covColors[ttCov], fontFamily: "'Cinzel',serif", fontSize: 10 }}>{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "8px 10px", color: T.muted, fontSize: 10, whiteSpace: "nowrap" as const, fontFamily: "'Cinzel',serif" }}>
                      {ri === 0 ? "09:00–11:00" : ri === 1 ? "13:00–15:00" : "16:00–18:00"}
                    </td>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{ padding: "8px 10px", textAlign: "center", color: cell === "—" ? T.border : T.text, fontStyle: cell === "—" ? "italic" : "normal", fontSize: 11 }}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ ...card, marginTop: 10, padding: "10px 12px" }}>
            <p style={{ fontSize: 11, color: T.muted, lineHeight: 1.7 }}>
              Noctis University follows a Covenant-track curriculum. All students complete their academic requirements within their Covenant's designated programme. Cross-covenant electives require faculty approval. Timetables are subject to revision without notice.
            </p>
          </div>
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // EXPLORE
  // ═══════════════════════════════════════════════════════
  const Explore = () => {
    if (subPage === "live") return LivePage();
    if (subPage === "confessions") return ConfsPage();
    if (subPage === "twisted") return TwistedPage();
    if (subPage === "parties") return PartiesPage();
    if (subPage === "qna") return QnAPage();
    if (subPage === "hottest") return HottestPage();
    if (subPage === "gossip") return GossipPage();

    return (
      <div>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto" }}>
            <span style={ttl()}>🔭 EXPLORE</span>
          </div>
        </div>
        <div style={sec}>
          {/* User Search */}
          <div style={{ marginBottom: 16 }}>
            <input
              value={userSearch}
              onChange={e => {
                setUserSearch(e.target.value);
                const q = e.target.value.trim();
                if (q.length >= 2) {
                  fetch(`/api/users?q=${encodeURIComponent(q)}`)
                    .then(r => r.json())
                    .then(d => {
                      if (d.users) {
                        d.users.forEach((u: any) => {
                          const p = u.profile || {};
                          if (!ACCTS[u.id]) {
                            ACCTS[u.id] = { id: u.id, un: u.username, handle: `@${u.username}`, pic: p.pic || u.pic || "🎭", tier: p.tier || u.tier || "merit", bio: p.bio || u.bio || "", major: p.major || u.major || "Undeclared", followers: p.followers || 0, following: p.following || 0, gaze: 0, cov: p.covenant || u.covenant || "shadows", rep: "Student", defTheme: "dark", canPost: true, canTheme: false, _real: true };
                          }
                        });
                      }
                    }).catch(() => {});
                }
              }}
              placeholder="🔍 Search students & faculty by name, @handle, or ID…"
              style={{ ...inp }}
            />
            {userSearch.trim().length >= 2 && (() => {
              const q = userSearch.trim().toLowerCase().replace(/^@/, "");
              const results = (Object.values(ACCTS) as any[]).filter((u: any) => {
                const un = (u.un || u.username || "").toLowerCase();
                const handle = (u.handle || "").toLowerCase().replace(/^@/, "");
                const id = (u.id || "").toLowerCase();
                return un.includes(q) || handle.includes(q) || id.includes(q);
              }).slice(0, 12);
              return results.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  {results.map((u: any) => (
                    <button key={u.id} type="button" className="b"
                      onClick={() => { setProfId(u.id); go("profile"); setUserSearch(""); }}
                      style={{ ...card, width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 6, textAlign: "left" }}>
                      {(() => { const p = u.pic || "🌑"; return (p.startsWith("/") || p.startsWith("http") || p.startsWith("data:")) ? <img src={p} alt="" style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} /> : <span style={{ fontSize: 22 }}>{p}</span>; })()}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{u.un || u.username}</div>
                        <div style={{ fontSize: 11, color: T.muted }}>{u.handle || `@${u.id}`} · {(u.tier || "student").toUpperCase()}</div>
                      </div>
                      <span style={{ fontSize: 11, color: T.primary }}>→</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 12, color: T.muted, padding: "8px 0" }}>No students found matching "{userSearch}".</p>
              );
            })()}
          </div>
          {[
            {
              id: "live",
              icon: "🔴",
              label: "LIVE NOW",
              sub: `${LIVES.length} active streams`,
              color: "#ff3b3b",
            },
            {
              id: "hottest",
              icon: "🔥",
              label: "HOTTEST RANKINGS",
              sub: "Who's the most wanted? The campus votes.",
              color: "#e8963c",
            },
            {
              id: "gossip",
              icon: "🕯️",
              label: "GOSSIP CORNER",
              sub: "Whispers, rumours, spotted. No receipts needed.",
              color: "#aa7744",
            },
            {
              id: "confessions",
              icon: "🔖",
              label: "CONFESSIONS",
              sub: "Anonymous truths. No names.",
              color: "#8b2222",
            },
            {
              id: "twisted",
              icon: "🌀",
              label: "TWISTED DISCUSSIONS",
              sub: "Dark polls & testimony threads",
              color: "#9944cc",
            },
            {
              id: "parties",
              icon: "🥂",
              label: "EVENTS & PARTIES",
              sub: "Official & underground social events",
              color: "#d4af37",
            },
            {
              id: "qna",
              icon: "❓",
              label: "Q & A",
              sub: "Anonymous questions to the institution",
              color: "#8b7355",
            },
          ].map((p) => (
            <button
              key={p.id}
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSubPage(p.id);
              }}
              style={{
                ...card,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "14px",
                marginBottom: 8,
                textAlign: "left",
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 10,
                  background: T.tag,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 22,
                  flexShrink: 0,
                  border: `1px solid ${p.color}44`,
                }}
              >
                {p.icon}
              </div>
              <div style={{ flex: 1 }}>
                <p
                  style={{
                    fontFamily: "'Cinzel',serif",
                    fontSize: 11,
                    color: p.color,
                    letterSpacing: "0.1em",
                    marginBottom: 2,
                  }}
                >
                  {p.label}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                  }}
                >
                  {p.sub}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // GOSSIP CORNER
  // ═══════════════════════════════════════════════════════
  const INIT_GOSSIP = [
    {
      id: "g1",
      tag: "👁️ SPOTTED",
      content:
        "Sebastian Blackwood and Prof. Voss having a private conversation in the Archive at 11PM last Thursday. Neither of them teaches there. Neither of them acknowledged each other afterward.",
      ts: "1h",
      heat: 344,
      replies: [
        {
          id: "gr1",
          un: "Anonymous",
          t: "The Archive access is Shadows-only. How did Blackwood get clearance.",
        },
        { id: "gr2", un: "Anonymous", t: "The real question is who sent who." },
      ],
    },
    {
      id: "g2",
      tag: "🔥 RUMOUR",
      content:
        "Ket White is about to acquire a fourth pet before the semester ends. Apparently the current three aren't enough for something she's planning.",
      ts: "2h",
      heat: 510,
      replies: [
        { id: "gr3", uid: "ket_white", un: "Ket White", t: "💎" },
        {
          id: "gr4",
          un: "Anonymous",
          t: "One word. That's all she gave us and it told us everything.",
        },
      ],
    },
    {
      id: "g3",
      tag: "💀 TEA",
      content:
        "Someone in the Merit housing block has been submitting anonymous reports about Prof. Hargrove's grading patterns to the Senate. Felix Harrow has the documents. He hasn't decided what to do with them yet.",
      ts: "3h",
      heat: 788,
      replies: [
        {
          id: "gr5",
          uid: "miriam_cross",
          un: "Miriam Cross",
          t: "I'm listening.",
        },
        {
          id: "gr6",
          uid: "felix_harrow",
          un: "Felix Harrow",
          t: "Thursday office hours.",
        },
        {
          id: "gr7",
          un: "Anonymous",
          t: "The two of them in a room with those documents is either salvation or a deal.",
        },
      ],
    },
    {
      id: "g4",
      tag: "👁️ SPOTTED",
      content:
        "Dorian Ashford and Cordelia Vane leaving the same off-campus location at 2AM on Monday. She arrived first. He arrived after. Neither of them is talking.",
      ts: "4h",
      heat: 622,
      replies: [
        {
          id: "gr8",
          un: "R. Belcourt",
          t: "The overlap on those two is always interesting.",
        },
        {
          id: "gr9",
          un: "Anonymous",
          t: "Cordelia doesn't share anything. Whatever this is, she initiated it.",
        },
      ],
    },
    {
      id: "g5",
      tag: "🌀 THEORY",
      content:
        "The Whisper Network isn't run by students. Three separate people have told me the origin is older than anyone currently enrolled. Faculty involvement.",
      ts: "5h",
      heat: 901,
      replies: [
        {
          id: "gr10",
          un: "Anonymous",
          t: "I've suspected this since year one.",
        },
        {
          id: "gr11",
          uid: "remy_noire",
          un: "Remy Noire",
          t: "Interesting theory.",
        },
        {
          id: "gr12",
          un: "Anonymous",
          t: "Remy Noire commenting is either a confirmation or a redirect. Both are telling.",
        },
      ],
    },
    {
      id: "g6",
      tag: "💔 DRAMA",
      content:
        "Two members of Phi Beta Theta are no longer speaking. One of them was voted in this semester. One of them voted against. The Soirée is going to be interesting.",
      ts: "6h",
      heat: 415,
      replies: [
        {
          id: "gr13",
          un: "V. Chambers",
          t: "I was there for the vote. It was close.",
        },
        {
          id: "gr14",
          un: "Anonymous",
          t: "Silk drama always goes underground before it goes public. Something is coming.",
        },
      ],
    },
    {
      id: "g7",
      tag: "🔥 RUMOUR",
      content:
        "One of the Merit students in the Academic Excellence Trials has received a private offer to withdraw in exchange for scholarship protection. They haven't responded yet.",
      ts: "8h",
      heat: 556,
      replies: [
        {
          id: "gr15",
          uid: "elena_hart",
          un: "Elena Hart",
          t: "If this is about me, I'm not withdrawing.",
        },
        {
          id: "gr16",
          un: "Anonymous",
          t: "The fact that she responded publicly. That's either brave or exactly what they wanted.",
        },
      ],
    },
    {
      id: "g8",
      tag: "👁️ SPOTTED",
      content:
        "Isadora Mercer was in the Burner Mode server last night under an account that doesn't match any known pattern. She was reading, not posting. For three hours.",
      ts: "10h",
      heat: 1204,
      replies: [
        {
          id: "gr17",
          un: "Anonymous",
          t: "She's mapping it. She's been mapping it for weeks.",
        },
        {
          id: "gr18",
          un: "Anonymous",
          t: "The Whisper Network knows. They moved three accounts already.",
        },
      ],
    },
    {
      id: "g9",
      tag: "💀 TEA",
      content:
        "Relief Room Unit 4 submitted a formal academic petition for the third time this semester. Same faculty member has denied it three times. Same one who uses the room most.",
      ts: "12h",
      heat: 877,
      replies: [
        {
          id: "gr19",
          un: "Anonymous",
          t: "There is no system here. There is just this.",
        },
        {
          id: "gr20",
          un: "Anonymous",
          t: "Unit 4's GPA is a 3.4. They more than qualify. This is personal.",
        },
      ],
    },
    {
      id: "g10",
      tag: "🌀 THEORY",
      content:
        "The Obsidian Circle and Alpha Phi Omega are the same organization at different points in a student's career. The Obsidian Circle is what Alpha Phi Omega becomes when you graduate.",
      ts: "1d",
      heat: 1560,
      replies: [
        {
          id: "gr21",
          un: "Anonymous",
          t: "The founding dates don't add up otherwise.",
        },
        {
          id: "gr22",
          uid: "sebastian_blackwood",
          un: "Sebastian Blackwood",
          t: "Enjoy your theories.",
        },
        { id: "gr23", un: "Anonymous", t: "He answered. That is an answer." },
      ],
    },
  ];

  // GossipPageInner — NO hooks (all state lifted to parent to fix hooks error)
  const GossipPageInner = () => {
    // Use lifted parent states: gossipPagePosts, gossipPageExpanded, gossipPageReplyTxt
    const initedPosts = gossipPagePosts.length > 0
      ? gossipPagePosts
      : INIT_GOSSIP.map((g: any) => ({ ...g, views: g.heat * 3 + Math.floor(Math.random()*200+50) }));

    if (gossipPagePosts.length === 0 && INIT_GOSSIP.length > 0) {
      setGossipPagePosts(initedPosts);
    }

    const upvote = (id: string) =>
      setGossipPagePosts(ps => ps.map((p: any) => p.id === id ? { ...p, heat: p.heat + 1 } : p));

    const addReply = (id: string) => {
      if (!gossipPageReplyTxt.trim()) return;
      setGossipPagePosts(ps => ps.map((p: any) => p.id === id
        ? { ...p, replies: [...(p.replies||[]), { id: `gr${Date.now()}`, un: (user as any)?.un || "Anonymous", t: gossipPageReplyTxt.trim() }] }
        : p));
      setGossipPageReplyTxt("");
    };

    const displayPosts = [...initedPosts].sort((a: any, b: any) => b.heat - a.heat);

    return (
      <div>
        {SubHdr({ title: "🕯️ GOSSIP CORNER", onBack: () => setSubPage(null as any) })}
        <div style={sec}>
          <p style={{ fontSize: 11, color: T.muted, textAlign: "center" as const, marginBottom: 14 }}>
            All posts are anonymous. Noctis sees everything.
          </p>
          {displayPosts.map((g: any) => (
            <div key={g.id} style={{ ...card, padding: 14, marginBottom: 10 }}
              onClick={() => setGossipPagePosts(ps => ps.map((p: any) => p.id === g.id ? { ...p, views: (p.views||0) + Math.floor(Math.random()*3+1) } : p))}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: T.muted, fontFamily: "'Cinzel',serif", letterSpacing: "0.08em" }}>{g.tag}</span>
                <span style={{ fontSize: 10, color: T.muted }}>{g.ts}</span>
              </div>
              <p style={{ fontSize: 13, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>{g.content}</p>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button className="b" onClick={(e) => { e.stopPropagation(); upvote(g.id); }} style={{ fontSize: 11, color: T.primary, background: "none", border: `1px solid ${T.border}`, borderRadius: 5, padding: "3px 10px", cursor: "pointer" }}>
                  🔥 {(g.heat||0).toLocaleString()}
                </button>
                <button className="b" onClick={(e) => { e.stopPropagation(); setGossipPageExpanded(gossipPageExpanded === g.id ? null : g.id); }} style={{ fontSize: 11, color: T.muted, background: "none", border: `1px solid ${T.border}`, borderRadius: 5, padding: "3px 10px", cursor: "pointer" }}>
                  💬 {(g.replies||[]).length} {gossipPageExpanded === g.id ? "▲" : "▼"}
                </button>
                <span style={{ fontSize: 10, color: "#5a4830", marginLeft: "auto" }}>👁 {(g.views||0).toLocaleString()} views</span>
              </div>
              {gossipPageExpanded === g.id && (
                <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}33`, paddingTop: 8 }}>
                  {(g.replies||[]).map((r: any) => (
                    <div key={r.id} style={{ padding: "6px 0", borderBottom: `1px solid ${T.border}22` }}>
                      <span style={{ fontSize: 10, color: T.primary, marginRight: 6 }}>{r.un}</span>
                      <span style={{ fontSize: 12, color: T.text }}>{r.t}</span>
                    </div>
                  ))}
                  {uid && (
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <input value={gossipPageReplyTxt} onChange={e => setGossipPageReplyTxt(e.target.value)} placeholder="Add a whisper..." style={{ ...inp, flex: 1, fontSize: 12 }} />
                      <button className="b" onClick={() => addReply(g.id)} style={{ ...btn(true), padding: "6px 12px", fontSize: 11 }}>Post</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const GossipPage = () => <GossipPageInner />;

  const LivePage = () => (
    <div>
      {SubHdr({ title: "🔴 LIVE NOW" })}
      <div style={sec}>
        {LIVES.map((ev, i) => (
          <div
            key={ev.id}
            style={{
              ...card,
              padding: 14,
              marginBottom: 10,
              animation: `fadeUp ${0.06 + i * 0.07}s ease`,
            }}
          >
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  background: T.tag,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  flexShrink: 0,
                }}
              >
                📡
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 3,
                  }}
                >
                  <span className="live" />
                  <span
                    style={{
                      fontSize: 10,
                      color: "#ff3b3b",
                      fontFamily: "'Cinzel',serif",
                    }}
                  >
                    LIVE
                  </span>
                  <span style={bdg(T.sec)}>{ev.cat}</span>
                </div>
                <p
                  style={{
                    fontSize: 14,
                    color: T.text,
                    fontWeight: 600,
                    marginBottom: 2,
                  }}
                >
                  {ev.title}
                </p>
                <p style={{ fontSize: 11, color: T.muted }}>
                  by {ev.host} · {ev.ago} ago · 👁️ {ev.viewers.toLocaleString()}
                </p>
              </div>
            </div>
            {/* Event comments */}
            <div
              style={{
                borderTop: `1px solid ${T.border}`,
                paddingTop: 8,
                marginBottom: 8,
              }}
            >
              {ev.comments.map((c) => (
                <div
                  key={c.id}
                  style={{ display: "flex", gap: 6, marginBottom: 6 }}
                >
                  <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                    {renderPic(c.uid && ACCTS[c.uid] ? ACCTS[c.uid].pic : "🌑", 20)}
                  </span>
                  <p
                    style={{
                      fontSize: 13,
                      color: T.muted,
                      fontFamily: "'IM Fell English',serif",
                    }}
                  >
                    <strong style={{ color: T.text, marginRight: 4 }}>
                      {c.un}
                    </strong>
                    {c.t}
                  </p>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toast("Joining stream… 📡");
              }}
              style={{
                ...btn(true),
                width: "100%",
                padding: "9px",
                fontSize: 12,
              }}
            >
              JOIN STREAM
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  const ConfsPage = () => (
    <div>
      {SubHdr({ title: "🔖 CONFESSIONS" })}
      <div style={sec}>
        <div
          style={{
            ...card,
            padding: 12,
            marginBottom: 10,
            background: "rgba(139,26,26,.07)",
            border: `1px solid ${T.danger}44`,
          }}
        >
          <p style={{ fontSize: 12, color: T.danger, lineHeight: 1.7 }}>
            ⚠️ All confessions are anonymous. No identities stored. Submit with
            awareness — the university monitors everything.
          </p>
        </div>
        <button
          type="button"
          className="b"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowConfC(!showConfC);
          }}
          style={{
            ...btn(false),
            width: "100%",
            marginBottom: 10,
            padding: "11px",
          }}
        >
          {showConfC ? "Cancel" : "+ Submit a Confession Anonymously"}
        </button>
        {showConfC && (
          <div
            style={{
              ...card,
              padding: 14,
              marginBottom: 10,
              animation: "fadeUp .3s ease",
            }}
          >
            <textarea
              value={confTxt}
              onChange={(e) => setConfTxt(e.target.value)}
              placeholder="Speak the unspeakable. No one will know."
              style={{
                ...inp,
                minHeight: 90,
                resize: "none",
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                marginBottom: 10,
              }}
            />
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!confTxt.trim()) return;
                setConfs((p) => {
                  const n = [
                    {
                      id: `cf${Date.now()}`,
                      content: confTxt,
                      ts: "Just now",
                      r: { "💀": 0, "🕯️": 0, "❤️": 0 },
                      cs: [],
                    },
                    ...p,
                  ];
                  pushConfs(n);
                  return n;
                });
                setConfTxt("");
                setShowConfC(false);
                toast("Confession submitted.");
              }}
              style={{ ...btn(true), width: "100%" }}
            >
              SUBMIT ANONYMOUSLY
            </button>
          </div>
        )}
        {confs.map((c, i) => {
          const showCC = activeConfC === c.id;
          return (
            <div
              key={c.id}
              style={{
                ...card,
                padding: 14,
                marginBottom: 10,
                borderLeft: `3px solid ${T.danger}55`,
                animation: `fadeUp ${0.06 + i * 0.05}s ease`,
              }}
            >
              <p style={{ ...lbl, color: "#cc4444", marginBottom: 8 }}>
                🔖 ANONYMOUS · {c.ts}
              </p>
              <p
                style={{
                  fontSize: 15,
                  color: T.text,
                  lineHeight: 1.75,
                  fontFamily: "'IM Fell English',serif",
                  whiteSpace: "pre-wrap",
                  marginBottom: 10,
                }}
              >
                {c.content}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 7,
                  flexWrap: "wrap",
                  marginBottom: 8,
                }}
              >
                {Object.entries(c.r).map(([e, v]) => (
                  <button
                    key={e}
                    type="button"
                    className="b"
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setConfs((p) =>
                        p.map((x) =>
                          x.id === c.id
                            ? { ...x, r: { ...x.r, [e]: v + 1 } }
                            : x
                        )
                      );
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "3px 8px",
                      background: T.tag,
                      border: `1px solid ${T.border}`,
                      borderRadius: 20,
                      fontSize: 12,
                      color: T.muted,
                    }}
                  >
                    {e} {v}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveConfC(showCC ? null : c.id);
                    setConfCTxt("");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: T.muted,
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  💬 {c.cs?.length || 0}
                </button>
              </div>
              {showCC && (
                <div
                  style={{
                    borderTop: `1px solid ${T.border}`,
                    paddingTop: 8,
                    animation: "fadeIn .2s ease",
                  }}
                >
                  {(c.cs || []).map((cc) => (
                    <div
                      key={cc.id}
                      style={{ display: "flex", gap: 6, marginBottom: 7 }}
                    >
                      <span style={{ fontSize: 14, flexShrink: 0 }}>🌑</span>
                      <p
                        style={{
                          fontSize: 13,
                          color: T.muted,
                          fontFamily: "'IM Fell English',serif",
                        }}
                      >
                        <strong style={{ color: T.text, marginRight: 4 }}>
                          {cc.un}
                        </strong>
                        {cc.t}
                      </p>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <input
                      value={confCTxt}
                      onChange={(e) => setConfCTxt(e.target.value)}
                      placeholder="Reply anonymously…"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!confCTxt.trim()) return;
                          setConfs((p) =>
                            p.map((x) =>
                              x.id === c.id
                                ? {
                                    ...x,
                                    cs: [
                                      ...(x.cs || []),
                                      {
                                        id: `cc${Date.now()}`,
                                        un: "Anonymous",
                                        t: confCTxt.trim(),
                                      },
                                    ],
                                  }
                                : x
                            )
                          );
                          setConfCTxt("");
                          setActiveConfC(null);
                        }
                      }}
                      style={{
                        ...inp,
                        borderRadius: 20,
                        padding: "7px 12px",
                        fontSize: 13,
                      }}
                    />
                    <button
                      type="button"
                      className="b"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!confCTxt.trim()) return;
                        setConfs((p) =>
                          p.map((x) =>
                            x.id === c.id
                              ? {
                                  ...x,
                                  cs: [
                                    ...(x.cs || []),
                                    {
                                      id: `cc${Date.now()}`,
                                      un: "Anonymous",
                                      t: confCTxt.trim(),
                                    },
                                  ],
                                }
                              : x
                          )
                        );
                        setConfCTxt("");
                        setActiveConfC(null);
                      }}
                      style={{
                        padding: "7px 12px",
                        background: T.tag,
                        border: `1px solid ${T.border}`,
                        color: T.primary,
                        borderRadius: 20,
                        fontSize: 14,
                      }}
                    >
                      →
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const TwistedPage = () => (
    <div>
      {SubHdr({ title: "🌀 TWISTED DISCUSSIONS" })}
      <div style={sec}>
        {TWISTED.map((tw, i) => (
          <div
            key={tw.id}
            style={{
              ...card,
              padding: 14,
              marginBottom: 10,
              animation: `fadeUp ${0.06 + i * 0.06}s ease`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <span style={bdg(T.accent)}>{tw.cat}</span>
              <span style={{ fontSize: 11, color: T.muted }}>
                {tw.votes.toLocaleString()} engaged
              </span>
            </div>
            <p
              style={{
                fontSize: 15,
                color: T.text,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                lineHeight: 1.65,
                marginBottom: 12,
              }}
            >
              {tw.title}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {tw.opts.map((a, j) => {
                const vk = `${tw.id}_${j}`;
                const voted = tVotes[vk];
                return (
                  <button
                    key={j}
                    type="button"
                    className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!voted) {
                        setTVotes((p) => ({ ...p, [vk]: true }));
                        toast("Response recorded 🌀");
                      }
                    }}
                    style={{
                      padding: "10px 14px",
                      background: voted ? `${T.primary}18` : T.tag,
                      border: `1px solid ${voted ? T.primary : T.border}`,
                      borderRadius: 6,
                      color: voted ? T.primary : T.muted,
                      fontSize: 13,
                      textAlign: "left",
                      fontFamily: "'IM Fell English',serif",
                      fontStyle: "italic",
                    }}
                  >
                    {voted ? "✓ " : ""}
                    {a}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const PartiesPage = () => (
    <div>
      {SubHdr({ title: "🥂 EVENTS & PARTIES" })}
      <div style={sec}>
        {parties.map((p, i) => {
          const showEC = activeEventC === p.id;
          return (
            <div
              key={p.id}
              style={{
                ...card,
                padding: 14,
                marginBottom: 10,
                borderLeft: `3px solid ${p.dark ? T.danger : T.primary}55`,
                animation: `fadeUp ${0.06 + i * 0.07}s ease`,
              }}
            >
              <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                <div
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 10,
                    background: T.tag,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 22,
                    flexShrink: 0,
                    border: `1px solid ${T.border}`,
                  }}
                >
                  {p.pic}
                </div>
                <div style={{ flex: 1 }}>
                  <h3
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: T.text,
                      marginBottom: 2,
                    }}
                  >
                    {p.title}
                  </h3>
                  <p style={{ fontSize: 12, color: T.muted }}>
                    {p.date} · {p.venue}
                  </p>
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 8,
                }}
              >
                {p.tags.map((t) => (
                  <span key={t} style={pill(false)}>
                    {t}
                  </span>
                ))}
                <span style={pill(false)}>👥 {p.attendance}</span>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: T.muted,
                  lineHeight: 1.7,
                  fontFamily: "'IM Fell English',serif",
                  whiteSpace: "pre-wrap",
                  marginBottom: 8,
                }}
              >
                {p.desc}
              </p>
              <p
                style={{
                  fontSize: 11,
                  color: T.muted,
                  marginBottom: p.dark && isApex && p.darkNote ? 8 : 0,
                }}
              >
                🔒 {p.access}
              </p>
              {p.dark && isApex && p.darkNote && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "rgba(139,0,0,.07)",
                    border: `1px solid ${T.danger}44`,
                    borderRadius: 6,
                    marginBottom: 8,
                  }}
                >
                  <p style={{ ...lbl, color: T.danger, marginBottom: 4 }}>
                    🔒 APEX NOTES
                  </p>
                  <p
                    style={{
                      fontSize: 12,
                      color: T.danger,
                      lineHeight: 1.7,
                      fontFamily: "'IM Fell English',serif",
                      fontStyle: "italic",
                    }}
                  >
                    {p.darkNote}
                  </p>
                </div>
              )}
              {/* Event comments */}
              <div
                style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8 }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveEventC(showEC ? null : p.id);
                    setEventCTxt("");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: T.muted,
                    fontSize: 12,
                    marginBottom: showEC ? 8 : 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  💬 {p.comments.length} comments
                </button>
                {showEC && (
                  <>
                    {p.comments.map((c) => (
                      <div
                        key={c.id}
                        style={{ display: "flex", gap: 6, marginBottom: 7 }}
                      >
                        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                          {renderPic(c.uid && ACCTS[c.uid] ? ACCTS[c.uid].pic : "🌑", 20)}
                        </span>
                        <p
                          style={{
                            fontSize: 13,
                            color: T.muted,
                            fontFamily: "'IM Fell English',serif",
                          }}
                        >
                          <strong style={{ color: T.text, marginRight: 4 }}>
                            {c.un}
                          </strong>
                          {c.t}
                        </p>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <input
                        value={eventCTxt}
                        onChange={(e) => setEventCTxt(e.target.value)}
                        placeholder="Comment on this event…"
                        style={{
                          ...inp,
                          borderRadius: 20,
                          padding: "7px 12px",
                          fontSize: 13,
                        }}
                      />
                      <button
                        type="button"
                        className="b"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!eventCTxt.trim() || !user) return;
                          setParties((prev) =>
                            prev.map((x) =>
                              x.id === p.id
                                ? {
                                    ...x,
                                    comments: [
                                      ...x.comments,
                                      {
                                        id: `ec${Date.now()}`,
                                        uid: user.id,
                                        un: user.un,
                                        t: eventCTxt.trim(),
                                      },
                                    ],
                                  }
                                : x
                            )
                          );
                          setEventCTxt("");
                        }}
                        style={{
                          padding: "7px 12px",
                          background: T.tag,
                          border: `1px solid ${T.border}`,
                          color: T.primary,
                          borderRadius: 20,
                          fontSize: 14,
                        }}
                      >
                        →
                      </button>
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toast("RSVP recorded.");
                }}
                style={{
                  ...btn(true),
                  width: "100%",
                  marginTop: 10,
                  padding: "9px",
                  fontSize: 12,
                }}
              >
                RSVP
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const QnAPage = () => {
    const filtered =
      qTab === "answered"
        ? qna.filter((q) => q.answered)
        : qTab === "pending"
        ? qna.filter((q) => !q.answered)
        : qna;
    return (
      <div>
        {SubHdr({ title: "❓ Q&A · ANONYMOUS" })}
        <div style={sec}>
          <div style={{ ...card, padding: 14, marginBottom: 10 }}>
            <textarea
              value={qTxt}
              onChange={(e) => setQTxt(e.target.value)}
              placeholder="Ask anything. Your identity is hidden."
              style={{
                ...inp,
                resize: "none",
                minHeight: 70,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                marginBottom: 8,
              }}
            />
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!qTxt.trim()) return;
                setQna((p) => [
                  ...p,
                  {
                    id: `q${Date.now()}`,
                    q: qTxt,
                    ans: "",
                    answered: false,
                    tier: user?.tier || "merit",
                  },
                ]);
                setQTxt("");
                toast("Question submitted.");
              }}
              style={{ ...btn(true), width: "100%" }}
            >
              SUBMIT ANONYMOUSLY
            </button>
          </div>
          <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
            {[
              ["all", "All"],
              ["answered", "Answered"],
              ["pending", "Pending"],
            ].map(([k, l]) => (
              <button
                key={k}
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setQTab(k);
                }}
                style={pill(qTab === k)}
              >
                {l}
              </button>
            ))}
          </div>
          {filtered.map((q, i) => (
            <div
              key={q.id}
              style={{
                ...card,
                padding: 14,
                marginBottom: 10,
                animation: `fadeUp ${0.06 + i * 0.05}s ease`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 7,
                  flexWrap: "wrap",
                }}
              >
                <span style={bdg(T.sec)}>
                  {(q.tier || "anon").toUpperCase()}
                </span>
                {q.answered ? (
                  <span style={{ ...bdg("#44aa44"), color: "#44aa44" }}>
                    ANSWERED
                  </span>
                ) : (
                  <span
                    style={{ ...bdg(T.muted), animation: "pulse 2s infinite" }}
                  >
                    PENDING
                  </span>
                )}
              </div>
              <p
                style={{
                  fontSize: 15,
                  color: T.text,
                  fontFamily: "'IM Fell English',serif",
                  fontStyle: "italic",
                  marginBottom: q.answered ? 10 : 0,
                  lineHeight: 1.65,
                }}
              >
                "{q.q}"
              </p>
              {q.answered && q.ans && (
                <div
                  style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10 }}
                >
                  <p style={{ ...lbl, color: T.primary, marginBottom: 4 }}>
                    OFFICIAL RESPONSE
                  </p>
                  <p
                    style={{
                      fontSize: 14,
                      color: T.muted,
                      lineHeight: 1.7,
                      fontFamily: "'IM Fell English',serif",
                    }}
                  >
                    {q.ans}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // HOTTEST RANKINGS
  // ═══════════════════════════════════════════════════════

  const HottestPage = () => {
    const cat = hottestData[hCat];
    if (cat?.apexOnly && !isApex)
      return (
        <div>
          {SubHdr({ title: "🔥 HOTTEST RANKINGS" })}
          <div style={{ ...sec, textAlign: "center", padding: "60px 20px" }}>
            <p style={{ fontSize: 36, marginBottom: 12 }}>🔒</p>
            <p style={ttl()}>APEX ACCESS ONLY</p>
          </div>
        </div>
      );
    return (
      <div>
        {SubHdr({ title: "🔥 HOTTEST RANKINGS" })}
        <div style={sec}>
          <div
            style={{
              ...card,
              padding: 12,
              marginBottom: 10,
              background: "rgba(232,150,60,.05)",
              border: `1px solid rgba(232,150,60,.3)`,
            }}
          >
            <p
              style={{
                fontSize: 12,
                color: T.accent,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                lineHeight: 1.7,
              }}
            >
              Anonymous votes. Updated every 48 hours. The institution does not
              endorse these rankings. The institution absolutely tracks them.
            </p>
          </div>
          <div
            style={{
              display: "flex",
              gap: 7,
              overflowX: "auto",
              paddingBottom: 8,
              marginBottom: 10,
            }}
          >
            {hottestData.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (c.apexOnly && !isApex) {
                    toast("Apex access only.");
                    return;
                  }
                  setHCat(i);
                }}
                style={pill(hCat === i)}
              >
                {c.emoji} {c.cat}
              </button>
            ))}
          </div>
          <div
            style={{
              ...card,
              padding: 14,
              marginBottom: 10,
              textAlign: "center",
              borderBottom: `2px solid ${T.accent}`,
            }}
          >
            <p
              style={{
                fontFamily: "'Cinzel',serif",
                fontSize: 13,
                color: T.accent,
                letterSpacing: "0.12em",
                marginBottom: 4,
              }}
            >
              {cat.emoji} {cat.cat}
            </p>
            <p
              style={{
                fontSize: 12,
                color: T.muted,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
              }}
            >
              {cat.desc}
            </p>
          </div>
          {cat.entries.map((e, i) => {
            const voted = hVotes[`${cat.id}_${e.rank}`];
            return (
              <div
                key={e.rank}
                style={{
                  ...card,
                  padding: 13,
                  marginBottom: 8,
                  borderLeft: `3px solid ${
                    i === 0 ? T.accent : i === 1 ? T.muted : T.border
                  }`,
                  animation: `fadeUp ${0.06 + i * 0.04}s ease`,
                }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div
                    style={{
                      fontFamily: "'Cinzel',serif",
                      fontSize: i === 0 ? 22 : 16,
                      color: i === 0 ? T.accent : T.muted,
                      minWidth: 28,
                      textAlign: "center",
                      flexShrink: 0,
                    }}
                  >
                    #{e.rank}
                  </div>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      viewProf(e.handle.slice(1));
                    }}
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: "50%",
                      border: `2px solid ${e.bColor || T.border}`,
                      background: T.tag,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 20,
                      flexShrink: 0,
                    }}
                  >
                    {e.pic}
                  </button>
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        marginBottom: 2,
                      }}
                    >
                      <span
                        style={{ fontSize: 14, fontWeight: 600, color: T.text }}
                      >
                        {e.name}
                      </span>
                      <span style={bdg(e.bColor)}>{e.badge}</span>
                    </div>
                    <div
                      style={{ display: "flex", gap: 8, alignItems: "center" }}
                    >
                      <span
                        style={{
                          fontFamily: "'Cinzel',serif",
                          fontSize: 11,
                          color: T.accent,
                        }}
                      >
                        {e.votes.toLocaleString()} votes
                      </span>
                      <span style={{ fontSize: 10, color: "#44aa44" }}>
                        {e.delta} this week
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="b"
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      if (!voted) {
                        setHVotes((p) => ({
                          ...p,
                          [`${cat.id}_${e.rank}`]: true,
                        }));
                        setHottestData((prev) =>
                          prev.map((c2, ci) =>
                            ci !== hCat
                              ? c2
                              : {
                                  ...c2,
                                  entries: c2.entries.map((en) =>
                                    en.rank !== e.rank
                                      ? en
                                      : { ...en, votes: en.votes + 1 }
                                  ),
                                }
                          )
                        );
                        toast("Vote cast 🔥");
                      }
                    }}
                    style={{
                      padding: "6px 12px",
                      background: voted ? `${T.accent}20` : "transparent",
                      border: `1px solid ${voted ? T.accent : T.border}`,
                      color: voted ? T.accent : T.muted,
                      borderRadius: 20,
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    {voted ? "✓ Voted" : "Vote"}
                  </button>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                    marginTop: 8,
                    lineHeight: 1.6,
                    borderTop: `1px solid ${T.border}`,
                    paddingTop: 7,
                  }}
                >
                  "{e.note}"
                </p>
              </div>
            );
          })}
          <div style={{ ...card, padding: 14, marginBottom: 10 }}>
            <p style={{ ...lbl, marginBottom: 8 }}>COMMENTS · {cat.cat}</p>
            {(cat.comments || []).map((c) => (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 8,
                  paddingBottom: 8,
                  borderBottom: `1px solid ${T.border}`,
                }}
              >
                <span style={{ fontSize: 16, flexShrink: 0 }}>🌑</span>
                <p
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                  }}
                >
                  <strong style={{ color: T.text, marginRight: 4 }}>
                    {c.un}
                  </strong>
                  {c.t}
                </p>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                value={hCTxt}
                onChange={(e) => setHCTxt(e.target.value)}
                placeholder="Comment anonymously…"
                style={{
                  ...inp,
                  borderRadius: 20,
                  padding: "7px 12px",
                  fontSize: 13,
                }}
              />
              <button
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!hCTxt.trim()) return;
                  setHottestData((prev) =>
                    prev.map((c2, ci) =>
                      ci !== hCat
                        ? c2
                        : {
                            ...c2,
                            comments: [
                              ...(c2.comments || []),
                              {
                                id: `hc${Date.now()}`,
                                un: "Anonymous",
                                t: hCTxt.trim(),
                              },
                            ],
                          }
                    )
                  );
                  setHCTxt("");
                }}
                style={{
                  padding: "7px 12px",
                  background: T.tag,
                  border: `1px solid ${T.border}`,
                  color: T.primary,
                  borderRadius: 20,
                  fontSize: 14,
                }}
              >
                →
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // CLUBS & SOCIETIES
  // ═══════════════════════════════════════════════════════

  const ClubsPage = () => {
    if (selClub) {
      const cl = clubsData.find((c) => c.id === selClub);
      if (!cl) { setSelClub(null); return null; }
      const cv = COV[cl.covenant] || {
        emoji: "🌑",
        color: T.muted,
        name: "Unknown",
      };
      const isQuizzing = clubQuiz?.clubId === cl.id && !clubQuiz.done;
      const isJoined = clubQuiz?.clubId === cl.id && clubQuiz.done;
      if (isQuizzing) {
        const q = cl.quiz?.[clubQuiz.step];
        if (!q) {
          const passed = clubQuiz.score >= Math.ceil((cl.quiz?.length || 3) / 2);
          return (
            <div>
              {SubHdr({ title: "📋 MEMBERSHIP QUIZ" })}
              <div style={sec}>
                <div style={{ ...card, padding: 24, textAlign: "center" as const }}>
                  <div style={{ fontSize: 52, marginBottom: 12 }}>{passed ? "✅" : "❌"}</div>
                  <p style={{ fontFamily: "'Cinzel',serif", fontSize: 16, color: passed ? T.primary : T.danger, marginBottom: 8 }}>
                    {passed ? "APPLICATION SUBMITTED" : "QUIZ FAILED"}
                  </p>
                  <p style={{ fontSize: 13, color: T.muted, lineHeight: 1.7, marginBottom: 16 }}>
                    {passed
                      ? `Score: ${clubQuiz.score}/${cl.quiz?.length}. Your application to ${cl.name} has been submitted. You will be contacted if selected.`
                      : `Score: ${clubQuiz.score}/${cl.quiz?.length}. You did not meet the required standard. You may reapply next semester.`}
                  </p>
                  <button className="b" onClick={() => { setClubQuiz(prev => prev ? {...prev, done: true} : null); }}
                    style={{ ...btn(true), padding: "10px 20px" }}>
                    {passed ? "VIEW MY APPLICATION" : "RETURN TO CLUB"}
                  </button>
                </div>
              </div>
            </div>
          );
        }
        return (
          <div>
            {SubHdr({ title: `📋 ${cl.name.toUpperCase()} — QUIZ` })}
            <div style={sec}>
              <div style={{ ...card, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                  <span style={{ fontSize: 11, color: T.muted }}>Question {clubQuiz.step + 1} of {cl.quiz?.length}</span>
                  <span style={{ fontSize: 11, color: T.primary }}>Score: {clubQuiz.score}</span>
                </div>
                <div style={{ height: 4, background: T.tag, borderRadius: 2, marginBottom: 16 }}>
                  <div style={{ height: "100%", width: `${((clubQuiz.step) / (cl.quiz?.length || 4)) * 100}%`, background: T.primary, borderRadius: 2, transition: "width 0.3s" }} />
                </div>
                <p style={{ fontFamily: "'Cinzel',serif", fontSize: 14, color: T.text, lineHeight: 1.6, marginBottom: 18 }}>{q.q}</p>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                  {q.options.map((opt, idx) => (
                    <button key={idx} className="b"
                      onClick={() => {
                        const correct = idx === q.correct;
                        setClubQuiz(prev => prev ? {
                          ...prev,
                          step: prev.step + 1,
                          score: prev.score + (correct ? 1 : 0)
                        } : null);
                        if (correct) toast("Correct. ✓");
                        else toast("Incorrect.");
                      }}
                      style={{ ...card, padding: "12px 14px", textAlign: "left" as const, fontSize: 13, color: T.text, cursor: "pointer", border: `1px solid ${T.border}`, width: "100%", borderRadius: 6 }}>
                      {String.fromCharCode(65 + idx)}. {opt}
                    </button>
                  ))}
                </div>
              </div>
              <button className="b" onClick={() => setClubQuiz(null)} style={{ ...btn(false), width: "100%", fontSize: 11, padding: "8px" }}>
                Cancel Quiz
              </button>
            </div>
          </div>
        );
      }
      return (
        <div>
          <div style={hdr}>
            <div
              style={{
                maxWidth: 600,
                margin: "0 auto",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelClub(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: T.muted,
                  fontSize: 18,
                }}
              >
                ←
              </button>
              <span style={ttl()}>CLUB PROFILE</span>
            </div>
          </div>
          <div style={sec}>
            <div
              style={{
                ...card,
                padding: 20,
                marginBottom: 10,
                animation: "fadeUp .3s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 12,
                    border: `2px solid ${cl.color}`,
                    background: T.tag,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 26,
                    flexShrink: 0,
                  }}
                >
                  {cl.pic}
                </div>
                <div style={{ flex: 1 }}>
                  <h2
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: T.text,
                      marginBottom: 3,
                    }}
                  >
                    {cl.name}
                  </h2>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span style={bdg(cl.color)}>{cl.type.toUpperCase()}</span>
                    <span style={pill(false)}>
                      {cv.emoji} {cv.name}
                    </span>
                    <span style={{ fontSize: 11, color: T.muted }}>
                      👥 {cl.members} members
                    </span>
                    <span style={{ fontSize: 11, color: T.muted }}>
                      Est. {cl.established}
                    </span>
                  </div>
                </div>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: T.muted,
                  lineHeight: 1.7,
                  fontFamily: "'IM Fell English',serif",
                  fontStyle: "italic",
                  marginBottom: 12,
                }}
              >
                {cl.desc}
              </p>
              <p style={{ ...lbl, marginBottom: 6 }}>ACCESS</p>
              <p
                style={{
                  fontSize: 12,
                  color: T.text,
                  marginBottom: 12,
                  padding: "8px 10px",
                  background: T.tag,
                  borderRadius: 6,
                  border: `1px solid ${T.border}`,
                }}
              >
                {cl.access}
              </p>
              <p style={{ ...lbl, marginBottom: 6 }}>ACTIVITIES</p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 12,
                }}
              >
                {cl.activities.map((a) => (
                  <span key={a} style={pill(false)}>
                    {a}
                  </span>
                ))}
              </div>
              {/* ── CLUB PARTICIPATION ACTIVITIES ── */}
              {cl.quiz && cl.quiz.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <p style={{ ...lbl, marginBottom: 8 }}>PARTICIPATE & EARN</p>
                  {cl.quiz.slice(0,3).map((q: any, qi: number) => {
                    const actKey = `${cl.id}:act${qi}`;
                    const done = clubActivitiesDone.includes(actKey);
                    return (
                      <div key={actKey} style={{ ...card, padding: 12, marginBottom: 8, borderLeft: `3px solid ${done ? cl.color : T.border}` }}>
                        <p style={{ fontSize: 13, color: T.text, marginBottom: done ? 4 : 10, fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>{q.q}</p>
                        {done ? (
                          <p style={{ fontSize: 11, color: T.primary }}>✓ Completed · +75 XP · +₦200 earned</p>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            {(q.options || q.opts || []).map((opt: string, oi: number) => (
                              <button key={oi} type="button" className="b"
                                onClick={() => {
                                  const correct = oi === q.correct;
                                  if (correct) { markClubActivity(actKey); }
                                  else toast("✗ Not quite. Try another answer.");
                                }}
                                style={{ padding: "8px 11px", borderRadius: 6, fontSize: 12, textAlign: "left", background: T.tag, border: `1px solid ${T.border}`, color: T.text, cursor: "pointer" }}>
                                {opt}
                              </button>
                            ))}
                            <p style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Answer correctly to earn +75 XP · +₦200</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {cl.rumored && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "rgba(139,0,0,.06)",
                    border: `1px solid ${T.danger}44`,
                    borderRadius: 6,
                    marginBottom: 12,
                  }}
                >
                  <p style={{ ...lbl, color: T.danger, marginBottom: 4 }}>
                    RUMORED
                  </p>
                  <p
                    style={{
                      fontSize: 12,
                      color: T.danger,
                      fontFamily: "'IM Fell English',serif",
                      fontStyle: "italic",
                      lineHeight: 1.7,
                    }}
                  >
                    {cl.rumored}
                  </p>
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {cl.tags.map((t) => (
                  <span key={t} style={bdg(cl.color)}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ ...card, padding: 14, marginBottom: 10 }}>
              <p style={{ ...lbl, marginBottom: 8 }}>DISCUSSION</p>
              {cl.comments.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    marginBottom: 8,
                    paddingBottom: 8,
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                    {renderPic(c.uid && ACCTS[c.uid] ? ACCTS[c.uid].pic : "🌑", 22)}
                  </span>
                  <p
                    style={{
                      fontSize: 13,
                      color: T.muted,
                      fontFamily: "'IM Fell English',serif",
                    }}
                  >
                    <strong style={{ color: T.text, marginRight: 4 }}>
                      {c.un}
                    </strong>
                    {c.t}
                  </p>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={clubCTxt}
                  onChange={(e) => setClubCTxt(e.target.value)}
                  placeholder="Comment…"
                  style={{
                    ...inp,
                    borderRadius: 20,
                    padding: "7px 12px",
                    fontSize: 13,
                  }}
                />
                <button
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!clubCTxt.trim() || !user) return;
                    setClubsData((prev) =>
                      prev.map((c) =>
                        c.id !== cl.id
                          ? c
                          : {
                              ...c,
                              comments: [
                                ...c.comments,
                                {
                                  id: `cc${Date.now()}`,
                                  uid: user.id,
                                  un: user.un,
                                  t: clubCTxt.trim(),
                                },
                              ],
                            }
                      )
                    );
                    setClubCTxt("");
                  }}
                  style={{
                    padding: "7px 12px",
                    background: T.tag,
                    border: `1px solid ${T.border}`,
                    color: T.primary,
                    borderRadius: 20,
                    fontSize: 14,
                  }}
                >
                  →
                </button>
              </div>
            </div>
            <div style={{ ...card, padding: 14, marginBottom: 10 }}>
              <p style={{ ...lbl, marginBottom: 8 }}>📌 NOTICE BOARD</p>
              {clubNotices.filter((n) => n.clubId === cl.id).length === 0 && (
                <p style={{ fontSize: 12, color: T.muted, fontStyle: "italic" }}>No notices posted yet.</p>
              )}
              {clubNotices.filter((n) => n.clubId === cl.id).map((n) => (
                <div key={n.id} style={{ marginBottom: 10, padding: "8px 10px", background: T.tag, borderRadius: 6, borderLeft: `3px solid ${cl.color}` }}>
                  <p style={{ fontSize: 13, color: T.text, lineHeight: 1.6 }}>{n.text}</p>
                  <p style={{ fontSize: 10, color: T.muted, marginTop: 4 }}>📌 {n.author} · {n.ts}</p>
                </div>
              ))}
              {user?.isAdmin && (
                <div style={{ marginTop: 10 }}>
                  <p style={{ ...lbl, fontSize: 9, marginBottom: 4 }}>POST NOTICE (ADMIN)</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={noticeTxt}
                      onChange={(e) => setNoticeTxt(e.target.value)}
                      placeholder="Notice text…"
                      style={{ ...inp, flex: 1, fontSize: 12 }}
                    />
                    <button
                      type="button"
                      className="b"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!noticeTxt.trim()) return;
                        setClubNotices((prev) => [
                          ...prev,
                          { id: `cn${Date.now()}`, clubId: cl.id, author: user?.un || "Admin", text: noticeTxt.trim(), ts: "just now" },
                        ]);
                        setNoticeTxt("");
                        toast("Notice posted.");
                      }}
                      style={{ ...btn(true), padding: "7px 14px", fontSize: 11 }}
                    >
                      POST
                    </button>
                  </div>
                </div>
              )}
            </div>
            {/* Achievements */}
            {(cl as any).achievements?.length > 0 && (
              <div style={{ ...card, padding: 14, marginBottom: 10 }}>
                <p style={{ ...lbl, marginBottom: 8 }}>🏆 ACHIEVEMENTS</p>
                {(cl as any).achievements.map((a: string) => (
                  <div key={a} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0", borderBottom: `1px solid ${T.border}33` }}>
                    <span style={{ fontSize: 12, color: T.primary, flexShrink: 0, marginTop: 2 }}>◆</span>
                    <span style={{ fontSize: 12, color: T.text, lineHeight: 1.5 }}>{a}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Notable Graduates */}
            {(cl as any).notableGraduates?.length > 0 && (
              <div style={{ ...card, padding: 14, marginBottom: 10 }}>
                <p style={{ ...lbl, marginBottom: 8 }}>🎓 NOTABLE GRADUATES</p>
                {(cl as any).notableGraduates.map((g: any) => (
                  <div key={g.name} style={{ padding: "7px 0", borderBottom: `1px solid ${T.border}33` }}>
                    <p style={{ fontSize: 13, color: T.text, fontWeight: 600, marginBottom: 2 }}>{g.name}</p>
                    <p style={{ fontSize: 11, color: T.muted }}>{g.note}</p>
                  </div>
                ))}
              </div>
            )}
            {/* Join Club button */}
            {isJoined ? (
              <div style={{ ...card, padding: 16, textAlign: "center" as const, border: `1px solid ${T.primary}44` }}>
                <p style={{ ...lbl, color: T.primary, marginBottom: 4 }}>✅ APPLICATION SUBMITTED</p>
                <p style={{ fontSize: 12, color: T.muted }}>Your application to {cl.name} is under review. You will be contacted if selected.</p>
              </div>
            ) : (cl as any).quiz?.length > 0 ? (
              <button
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!uid) { toast("Sign in to apply."); return; }
                  setClubQuiz({ clubId: cl.id, step: 0, score: 0, done: false });
                }}
                style={{ ...btn(true), width: "100%", padding: "13px", fontSize: 13 }}
              >
                📋 JOIN CLUB — TAKE THE QUIZ
              </button>
            ) : (
              <button
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toast("Your interest has been noted. Expect no response.");
                }}
                style={{ ...btn(false), width: "100%", padding: "13px", fontSize: 13, borderColor: T.muted, color: T.muted }}
              >
                EXPRESS INTEREST
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div>
        {SubHdr({ title: "🏛️ CLUBS & SOCIETIES" })}
        <div style={sec}>
          <div style={{ ...card, padding: 12, marginBottom: 10 }}>
            <p
              style={{
                fontSize: 12,
                color: T.muted,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                lineHeight: 1.7,
              }}
            >
              Official clubs, Covenant societies, and organizations that
              officially do not exist. Membership has consequences.
            </p>
          </div>
          {clubsData.map((cl, i) => (
            <button
              key={cl.id}
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelClub(cl.id);
              }}
              style={{
                ...card,
                width: "100%",
                display: "flex",
                gap: 12,
                padding: 13,
                marginBottom: 8,
                textAlign: "left",
                borderLeft: `3px solid ${cl.color}`,
                animation: `fadeUp ${0.06 + i * 0.04}s ease`,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: T.tag,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  flexShrink: 0,
                  border: `1px solid ${cl.color}44`,
                }}
              >
                {cl.pic}
              </div>
              <div style={{ flex: 1 }}>
                <p
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: T.text,
                    marginBottom: 3,
                  }}
                >
                  {cl.name}
                </p>
                <p style={{ fontSize: 11, color: T.muted, marginBottom: 5 }}>
                  {cl.type} · Est. {cl.established} · {cl.members} members
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                  }}
                >
                  {cl.desc.slice(0, 65)}…
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // CHAMPIONSHIPS
  // ═══════════════════════════════════════════════════════

  const ChampPage = () => {
    const typeColor = {
      combat: "#7a9ab0",
      academic: "#d4af37",
      social: "#ff69b4",
      intelligence: "#9944cc",
    };
    if (selChamp) {
      const ch = champsData.find((c) => c.id === selChamp);
      return (
        <div>
          <div style={hdr}>
            <div
              style={{
                maxWidth: 600,
                margin: "0 auto",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelChamp(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: T.muted,
                  fontSize: 18,
                }}
              >
                ←
              </button>
              <span style={ttl()}>CHAMPIONSHIP</span>
            </div>
          </div>
          <div style={sec}>
            <div
              style={{
                ...card,
                padding: 20,
                marginBottom: 10,
                borderLeft: `3px solid ${ch.color}`,
                animation: "fadeUp .3s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 10,
                    background: T.tag,
                    border: `2px solid ${ch.color}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 24,
                    flexShrink: 0,
                  }}
                >
                  {ch.pic}
                </div>
                <div style={{ flex: 1 }}>
                  <h2
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: T.text,
                      marginBottom: 2,
                    }}
                  >
                    {ch.title}
                  </h2>
                  <p style={{ fontSize: 12, color: T.muted, marginBottom: 6 }}>
                    {ch.subtitle} · {ch.date}
                  </p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span style={bdg(typeColor[ch.type])}>
                      {ch.type.toUpperCase()}
                    </span>
                    <span style={bdg("#44aa44")}>UPCOMING</span>
                    <span style={{ fontSize: 11, color: T.muted }}>
                      📍 {ch.venue}
                    </span>
                  </div>
                </div>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: T.muted,
                  lineHeight: 1.7,
                  fontFamily: "'IM Fell English',serif",
                  marginBottom: 12,
                }}
              >
                {ch.desc}
              </p>
              <div
                style={{
                  padding: "8px 12px",
                  background: T.tag,
                  borderRadius: 6,
                  border: `1px solid ${ch.color}44`,
                  marginBottom: 12,
                }}
              >
                <p style={{ ...lbl, color: ch.color, marginBottom: 4 }}>
                  PRIZE
                </p>
                <p style={{ fontSize: 13, color: T.text }}>{ch.prize}</p>
              </div>
              <p style={{ ...lbl, marginBottom: 6 }}>
                ENTRANTS ({ch.entrants.length})
              </p>
              {ch.entrants.map((e, i) => (
                <p
                  key={i}
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    padding: "4px 0",
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  · {e}
                </p>
              ))}
              <p style={{ ...lbl, marginBottom: 6, marginTop: 12 }}>RULES</p>
              {ch.rules.map((r, i) => (
                <p
                  key={i}
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    padding: "4px 0",
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  — {r}
                </p>
              ))}
              {ch.bets && (
                <>
                  <p
                    style={{
                      ...lbl,
                      marginBottom: 6,
                      marginTop: 12,
                      color: T.accent,
                    }}
                  >
                    UNOFFICIAL BETS
                  </p>
                  {ch.bets.map((b, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "6px 0",
                        borderBottom: `1px solid ${T.border}`,
                      }}
                    >
                      <p
                        style={{
                          fontSize: 12,
                          color: T.muted,
                          flex: 1,
                          fontFamily: "'IM Fell English',serif",
                          fontStyle: "italic",
                        }}
                      >
                        "{b.bet}"
                      </p>
                      <span
                        style={{
                          fontSize: 11,
                          color: T.accent,
                          flexShrink: 0,
                          marginLeft: 8,
                        }}
                      >
                        {b.odds || "—"} · {b.un}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div style={{ ...card, padding: 14, marginBottom: 10 }}>
              <p style={{ ...lbl, marginBottom: 8 }}>DISCUSSION</p>
              {ch.comments.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    marginBottom: 8,
                    paddingBottom: 8,
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                    {renderPic(c.uid && ACCTS[c.uid] ? ACCTS[c.uid].pic : "🌑", 22)}
                  </span>
                  <p
                    style={{
                      fontSize: 13,
                      color: T.muted,
                      fontFamily: "'IM Fell English',serif",
                    }}
                  >
                    <strong style={{ color: T.text, marginRight: 4 }}>
                      {c.un}
                    </strong>
                    {c.t}
                  </p>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={champCTxt}
                  onChange={(e) => setChampCTxt(e.target.value)}
                  placeholder="Your take…"
                  style={{
                    ...inp,
                    borderRadius: 20,
                    padding: "7px 12px",
                    fontSize: 13,
                  }}
                />
                <button
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!champCTxt.trim() || !user) return;
                    setChampsData((prev) =>
                      prev.map((c) =>
                        c.id !== ch.id
                          ? c
                          : {
                              ...c,
                              comments: [
                                ...c.comments,
                                {
                                  id: `chc${Date.now()}`,
                                  uid: user.id,
                                  un: user.un,
                                  t: champCTxt.trim(),
                                },
                              ],
                            }
                      )
                    );
                    setChampCTxt("");
                  }}
                  style={{
                    padding: "7px 12px",
                    background: T.tag,
                    border: `1px solid ${T.border}`,
                    color: T.primary,
                    borderRadius: 20,
                    fontSize: 14,
                  }}
                >
                  →
                </button>
              </div>
            </div>
            <button
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toast("Registration submitted.");
              }}
              style={{ ...btn(true), width: "100%", padding: "12px" }}
            >
              REGISTER / NOMINATE
            </button>
          </div>
        </div>
      );
    }
    return (
      <div>
        {SubHdr({ title: "🏆 CHAMPIONSHIPS" })}
        <div style={sec}>
          <div style={{ ...card, padding: 12, marginBottom: 10 }}>
            <p
              style={{
                fontSize: 12,
                color: T.muted,
                fontFamily: "'IM Fell English',serif",
                fontStyle: "italic",
                lineHeight: 1.7,
              }}
            >
              Upcoming competitions across all Covenant disciplines. Combat,
              intellect, influence, and survival. Results change trajectories.
            </p>
          </div>
          {champsData.map((ch, i) => (
            <button
              key={ch.id}
              type="button"
              className="b"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelChamp(ch.id);
              }}
              style={{
                ...card,
                width: "100%",
                display: "flex",
                gap: 12,
                padding: 13,
                marginBottom: 8,
                textAlign: "left",
                borderLeft: `3px solid ${ch.color}`,
                animation: `fadeUp ${0.06 + i * 0.05}s ease`,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: T.tag,
                  border: `2px solid ${ch.color}44`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  flexShrink: 0,
                }}
              >
                {ch.pic}
              </div>
              <div style={{ flex: 1 }}>
                <p
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: T.text,
                    marginBottom: 2,
                  }}
                >
                  {ch.title}
                </p>
                <p style={{ fontSize: 11, color: T.muted, marginBottom: 5 }}>
                  {ch.date} · {ch.venue}
                </p>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  <span style={bdg(typeColor[ch.type])}>
                    {ch.type.toUpperCase()}
                  </span>
                  <span style={bdg("#44aa44")}>UPCOMING</span>
                </div>
              </div>
              <span
                style={{ color: T.muted, fontSize: 16, alignSelf: "center" }}
              >
                ›
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  };
  const Auction = () => {
    if (!isApex && !isAsc)
      return (
        <div>
          <div style={hdr}>
            <div style={{ maxWidth: 600, margin: "0 auto" }}>
              <span style={ttl()}>⛓️ AUCTION HOUSE</span>
            </div>
          </div>
          <div
            style={{ ...sec, textAlign: "center", padding: "60px 20px 90px" }}
          >
            <p style={{ fontSize: 44, marginBottom: 12 }}>🔒</p>
            <p style={ttl()}>RESTRICTED</p>
            <p style={{ ...sub, marginTop: 8 }}>
              Qualified Buyers only. Apex + Faculty sponsorship.
            </p>
          </div>
        </div>
      );
    if (isAsc && !isApex)
      return (
        <div>
          <div style={hdr}>
            <div style={{ maxWidth: 600, margin: "0 auto" }}>
              <span style={ttl()}>⛓️ AUCTION HOUSE</span>
            </div>
          </div>
          <div style={sec}>
            <div
              style={{
                ...card,
                padding: 14,
                marginBottom: 10,
                textAlign: "center",
                border: `1px solid ${T.danger}44`,
              }}
            >
              <p style={{ fontSize: 30, marginBottom: 8 }}>🔒</p>
              <p style={ttl()}>ASCENDANT ACCESS — PREVIEW ONLY</p>
              <p style={{ ...sub, marginTop: 6, lineHeight: 1.7 }}>
                Bidding and full documentation require Apex qualification.
              </p>
            </div>
            {LOTS.filter((l) => l.status === "upcoming").map((l, i) => (
              <div
                key={l.id}
                style={{
                  ...card,
                  padding: 12,
                  marginBottom: 8,
                  animation: `fadeUp ${0.06 + i * 0.06}s ease`,
                }}
              >
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: T.text,
                    marginBottom: 4,
                  }}
                >
                  Lot #{l.num} — {l.type.toUpperCase()}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                  }}
                >
                  {l.subject?.desc ||
                    l.subject?.reason ||
                    "Description restricted."}
                </p>
                <p style={{ fontSize: 11, color: T.muted, marginTop: 5 }}>
                  Starting: ${l.startBid?.toLocaleString() || "TBD"} · Full data
                  restricted
                </p>
              </div>
            ))}
          </div>
        </div>
      );

    return (
      <div>
        <div style={hdr}>
          <div
            style={{
              maxWidth: 600,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={ttl()}>⛓️ AUCTION HOUSE</span>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span className="live" />
              <span
                style={{
                  fontSize: 10,
                  color: "#ff3b3b",
                  fontFamily: "'Cinzel',serif",
                }}
              >
                LIVE
              </span>
            </div>
          </div>
        </div>
        <div style={sec}>
          <div
            style={{
              display: "flex",
              gap: 7,
              padding: "10px 0",
              overflowX: "auto",
            }}
          >
            {[
              ["pets", `🔴 Pets${liveAuctions.length > 0 ? ` (${liveAuctions.length})` : ""}`],
              ["live", "Live Lots"],
              ["all", "All Lots"],
              ["past", "Past"],
              ["catalog", "Catalog"],
            ].map(([k, l]) => (
              <button
                key={k}
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setATab(k);
                }}
                style={pill(aTab === k)}
              >
                {l}
              </button>
            ))}
          </div>

          {/* My bid records shown in auction too */}
          {myBids.length > 0 && (
            <div
              style={{
                ...card,
                padding: 12,
                marginBottom: 10,
                border: `1px solid ${T.primary}33`,
              }}
            >
              <p style={{ ...lbl, color: T.primary, marginBottom: 6 }}>
                YOUR BID RECORDS
              </p>
              {myBids.map((b, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "5px 0",
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  <span style={{ fontSize: 12, color: T.text }}>{b.lot}</span>
                  <span
                    style={{
                      fontFamily: "'Cinzel',serif",
                      fontSize: 12,
                      color: T.primary,
                    }}
                  >
                    ${b.amount?.toLocaleString()} · {b.time}
                  </span>
                </div>
              ))}
            </div>
          )}

          {aTab === "pets" && (() => {
            const fmtCountdown = (endsAt: string) => {
              const ms = Math.max(0, new Date(endsAt).getTime() - Date.now());
              const h = Math.floor(ms / 3600000);
              const m = Math.floor((ms % 3600000) / 60000);
              const s = Math.floor((ms % 60000) / 1000);
              return ms <= 0 ? "CLOSED" : `${h}h ${m}m ${s}s`;
            };
            return (
              <>
                <div style={{ ...card, padding: 12, marginBottom: 10, background: "#1a000d", border: "1px solid #8b000066" }}>
                  <p style={{ fontFamily: "'Cinzel',serif", fontSize: 11, color: "#ff4466", letterSpacing: "0.1em", marginBottom: 6 }}>⛓️ THE PET MARKET</p>
                  <p style={{ fontFamily: "'IM Fell English',serif", fontSize: 12, color: "#cc8899", lineHeight: 1.7 }}>
                    Students whose finances or social standing have collapsed are listed here for acquisition.
                    The highest bidder at close gains influence equal to 10× their bid factor. Pets may be redeemed by meeting threshold requirements.
                  </p>
                </div>

                {liveAuctions.length === 0 ? (
                  <div style={{ ...card, padding: 30, textAlign: "center", marginTop: 20 }}>
                    <p style={{ fontSize: 32, marginBottom: 10 }}>🕯️</p>
                    <p style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: T.muted, letterSpacing: "0.08em" }}>THE MARKET IS QUIET</p>
                    <p style={{ fontFamily: "'IM Fell English',serif", fontSize: 12, color: T.muted, marginTop: 8 }}>
                      No students are currently listed. Check back when the weak falter.
                    </p>
                  </div>
                ) : liveAuctions.map((auction: any) => {
                  const isMe = auction.subjectId === uid;
                  const isWinning = auction.highestBidderId === uid;
                  const bidAmt = parseInt(auctionBidInput[auction.id] || "0", 10);
                  const minBid = Math.max((auction.currentBid || 0) + 1, auction.startingBid || 500);
                  const subjectData = auction.subjectData || {};
                  const canBid = !isMe && !auctionBidding[auction.id] && bidAmt >= minBid && walletBalance >= bidAmt;

                  return (
                    <div key={auction.id} style={{
                      ...card, padding: 14, marginBottom: 10,
                      background: isMe ? "#200010" : isWinning ? "#001a0a" : "#120008",
                      border: `1px solid ${isMe ? "#cc0044" : isWinning ? "#00aa55" : "#44001a"}`,
                    }}>
                      {/* Header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: "50%",
                          background: "#2a0015", display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 22, flexShrink: 0, border: "2px solid #8b000066", overflow: "hidden",
                        }}>
                          {(() => { const p = auction.subjectAvatar || "🌑"; return (p.startsWith("/") || p.startsWith("http") || p.startsWith("data:")) ? <img src={p} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span>{p}</span>; })()}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: "#ff6699", fontWeight: 700 }}>{auction.subjectName}</span>
                            {isMe && <span style={{ fontSize: 9, background: "#cc0044", color: "#fff", padding: "2px 6px", borderRadius: 3, letterSpacing: "0.1em" }}>YOU</span>}
                            {isWinning && <span style={{ fontSize: 9, background: "#006633", color: "#88ffaa", padding: "2px 6px", borderRadius: 3, letterSpacing: "0.1em" }}>LEADING</span>}
                          </div>
                          {subjectData.covenant && <p style={{ fontSize: 10, color: "#883355", fontFamily: "'Cinzel',serif", marginTop: 2, letterSpacing: "0.05em" }}>COVENANT: {String(subjectData.covenant).toUpperCase()}</p>}
                          {subjectData.reason && <p style={{ fontSize: 10, color: "#664433", fontFamily: "'IM Fell English',serif", marginTop: 2 }}>{subjectData.reason}</p>}
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 9, color: "#ff4466", letterSpacing: "0.08em" }}>
                            {auction.reason === "reputation" ? "⚡ REP DEFICIENT" : "💸 INSOLVENT"}
                          </p>
                          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 10, color: "#cc6688", marginTop: 4 }}>
                            ⏱ {fmtCountdown(auction.endsAt)}
                          </p>
                        </div>
                      </div>

                      {/* Bid stats */}
                      <div style={{ display: "flex", gap: 12, marginBottom: 10, background: "#0a0005", borderRadius: 4, padding: "8px 12px" }}>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 9, color: "#664433", fontFamily: "'Cinzel',serif", letterSpacing: "0.08em" }}>CURRENT BID</p>
                          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 14, color: auction.currentBid > 0 ? "#ff6699" : "#443333" }}>
                            {auction.currentBid > 0 ? `₦${auction.currentBid.toLocaleString()}` : "No bids"}
                          </p>
                        </div>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 9, color: "#664433", fontFamily: "'Cinzel',serif", letterSpacing: "0.08em" }}>MIN BID</p>
                          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 14, color: "#cc8844" }}>₦{minBid.toLocaleString()}</p>
                        </div>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 9, color: "#664433", fontFamily: "'Cinzel',serif", letterSpacing: "0.08em" }}>BIDS</p>
                          <p style={{ fontFamily: "'Cinzel',serif", fontSize: 14, color: "#cc8899" }}>{auction.bidCount || 0}</p>
                        </div>
                      </div>

                      {auction.highestBidderName && (
                        <p style={{ fontFamily: "'IM Fell English',serif", fontSize: 11, color: "#883355", marginBottom: 8 }}>
                          Leading bidder: <span style={{ color: "#cc6688" }}>{auction.highestBidderName}</span>
                          {auction.highestBidderCov && <span style={{ color: "#664433" }}> · {auction.highestBidderCov}</span>}
                        </p>
                      )}

                      {/* Bidding interface */}
                      {!isMe && (
                        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                          <input
                            type="number"
                            placeholder={`Min ₦${minBid.toLocaleString()}`}
                            value={auctionBidInput[auction.id] || ""}
                            onChange={e => setAuctionBidInput(prev => ({ ...prev, [auction.id]: e.target.value }))}
                            style={{
                              flex: 1, padding: "9px 12px",
                              background: "#0a0005", border: "1px solid #44001a",
                              borderRadius: 5, color: "#ff6699", fontFamily: "'Cinzel',serif", fontSize: 12,
                            }}
                          />
                          <button
                            type="button"
                            disabled={!canBid}
                            onClick={() => placeLiveAuctionBid(auction.id, bidAmt)}
                            style={{
                              padding: "9px 14px", borderRadius: 5, border: "none",
                              background: canBid ? "#8b0000" : "#2a0010",
                              color: canBid ? "#ffcccc" : "#553333",
                              fontFamily: "'Cinzel',serif", fontSize: 11, cursor: canBid ? "pointer" : "not-allowed",
                              letterSpacing: "0.08em",
                            }}
                          >
                            {auctionBidding[auction.id] ? "…" : "BID"}
                          </button>
                        </div>
                      )}
                      {isMe && (
                        <div style={{ background: "#2a0015", borderRadius: 4, padding: "8px 12px", marginTop: 6 }}>
                          <p style={{ fontFamily: "'IM Fell English',serif", fontSize: 11, color: "#cc8899", lineHeight: 1.6 }}>
                            You are listed in this auction. Recover your standing to be removed.
                            {" "}Earn ₦1,000+ and 100+ influence points to clear your listing.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Past auction history from DB */}
                {auctionHistory.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <p style={{ fontFamily: "'Cinzel',serif", fontSize: 10, color: "#664433", letterSpacing: "0.1em", marginBottom: 10 }}>CLOSED AUCTIONS</p>
                    {auctionHistory.slice(0, 10).map((a: any) => (
                      <div key={a.id} style={{ ...card, padding: 10, marginBottom: 6, background: "#0d0005", opacity: 0.7 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontFamily: "'Cinzel',serif", fontSize: 11, color: "#883355" }}>{a.subjectName}</span>
                          <span style={{ fontFamily: "'Cinzel',serif", fontSize: 11, color: "#664433" }}>
                            {a.currentBid > 0 ? `Sold ₦${a.currentBid.toLocaleString()} → ${a.highestBidderName || "Unknown"}` : "No bids"}
                          </span>
                        </div>
                        <p style={{ fontSize: 10, color: "#443333", fontFamily: "'IM Fell English',serif", marginTop: 4 }}>
                          {a.reason === "reputation" ? "Reputation deficiency" : "Financial deficiency"} · {new Date(a.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {aTab === "live" && (
            <>
              <div
                style={{
                  ...card,
                  padding: 12,
                  marginBottom: 10,
                  background: "rgba(139,0,0,.05)",
                  border: `1px solid ${T.danger}55`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span className="live" />
                  <span
                    style={{
                      fontFamily: "'Cinzel',serif",
                      fontSize: 11,
                      color: "#ff3b3b",
                      letterSpacing: "0.1em",
                    }}
                  >
                    SPRING AUCTION NIGHT I — LIVE
                  </span>
                </div>
                <p style={{ fontSize: 11, color: T.muted }}>
                  Blackwell Underground · 3 lots active simultaneously · 14
                  registered buyers
                </p>
              </div>

              {/* LOT 7 — Active Bidding */}
              <div
                style={{
                  ...card,
                  padding: 14,
                  marginBottom: 10,
                  border: `1px solid ${T.danger}55`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <p style={{ ...lbl, color: "#ff3b3b" }}>
                      🔴 LOT #7 — ACTIVE
                    </p>
                    <span style={bdg(T.danger)}>PET · FEMALE</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 10, color: T.muted }}>Time Left</p>
                    <p
                      style={{
                        fontFamily: "'Cinzel',serif",
                        fontSize: 20,
                        color: "#ff3b3b",
                        animation: "pulse 1s infinite",
                      }}
                    >
                      4:22
                    </p>
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    lineHeight: 1.65,
                    fontFamily: "'IM Fell English',serif",
                    marginBottom: 10,
                  }}
                >
                  F · 19 · Merit · Literature/Econ · First listing ·
                  Voice-responsive · Sensitivity 82% · Obedience 55%
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 6,
                    marginBottom: 10,
                  }}
                >
                  {[
                    ["CURRENT BID", `$${liveBid.toLocaleString()}`, T.primary],
                    [`${liveBidCount} BIDS`, "This lot", ""],
                    ["SENSITIVITY", "82%", T.accent],
                  ].map(([l2, v, c]) => (
                    <div
                      key={l2}
                      style={{
                        background: T.tag,
                        borderRadius: 6,
                        padding: 8,
                        border: `1px solid ${T.border}`,
                        textAlign: "center",
                      }}
                    >
                      <p style={{ ...lbl, fontSize: 8, marginBottom: 2 }}>
                        {l2}
                      </p>
                      <p
                        style={{
                          fontFamily: "'Cinzel',serif",
                          fontSize: 13,
                          color: c || T.muted,
                        }}
                      >
                        {v}
                      </p>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <input
                    value={bidInput}
                    onChange={(e) => setBidInput(e.target.value)}
                    placeholder={`Min $${(liveBid + 1).toLocaleString()}`}
                    style={{ ...inp, flex: 1, padding: "9px 12px" }}
                  />
                  <button
                    type="button"
                    className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      placeBid();
                    }}
                    style={{ ...btn(true), flexShrink: 0 }}
                  >
                    BID
                  </button>
                </div>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {[5000, 10000, 25000].map((a) => (
                    <button
                      key={a}
                      type="button"
                      className="b"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setBidInput(String(liveBid + a));
                      }}
                      style={{
                        ...btn(false),
                        padding: "6px",
                        fontSize: 11,
                        flex: 1,
                      }}
                    >
                      +${(a / 1000).toFixed(0)}K
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedLot(LOTS.find((l) => l.id === "L07"));
                  }}
                  style={{
                    ...btn(false),
                    width: "100%",
                    fontSize: 12,
                    border: `1px solid ${T.primary}`,
                    color: T.primary,
                  }}
                >
                  📄 VIEW FULL DOCUMENT
                </button>
              </div>

              {/* LOT 8 — Simultaneous */}
              <div
                style={{
                  ...card,
                  padding: 14,
                  marginBottom: 10,
                  border: `1px solid #ff660055`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <p style={{ ...lbl, color: "#ff6600" }}>
                      🔴 LOT #8 — ACTIVE
                    </p>
                    <span style={bdg("#ff6600")}>VIRGIN · MALE</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 10, color: T.muted }}>Time Left</p>
                    <p
                      style={{
                        fontFamily: "'Cinzel',serif",
                        fontSize: 20,
                        color: "#ff6600",
                        animation: "pulse 1.3s infinite",
                      }}
                    >
                      11:08
                    </p>
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    lineHeight: 1.65,
                    fontFamily: "'IM Fell English',serif",
                    marginBottom: 10,
                  }}
                >
                  M · 19 · Merit · Economics · Voluntary submission · Verified
                  status · Sensitivity 74% · Calm under assessment
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 6,
                    marginBottom: 10,
                  }}
                >
                  {[
                    ["CURRENT BID", "$38,000", "#ff6600"],
                    ["6 BIDS", "This lot", ""],
                    ["STARTING", "$30,000", T.muted],
                  ].map(([l2, v, c]) => (
                    <div
                      key={l2}
                      style={{
                        background: T.tag,
                        borderRadius: 6,
                        padding: 8,
                        border: `1px solid ${T.border}`,
                        textAlign: "center",
                      }}
                    >
                      <p style={{ ...lbl, fontSize: 8, marginBottom: 2 }}>
                        {l2}
                      </p>
                      <p
                        style={{
                          fontFamily: "'Cinzel',serif",
                          fontSize: 13,
                          color: c || T.muted,
                        }}
                      >
                        {v}
                      </p>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    placeholder="Min $38,001"
                    style={{ ...inp, flex: 1, padding: "9px 12px" }}
                    onChange={(e) => {}}
                  />
                  <button
                    type="button"
                    className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toast("Bid submitted — Lot #8");
                    }}
                    style={{ ...btn(true), flexShrink: 0 }}
                  >
                    BID
                  </button>
                </div>
                <button
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedLot(LOTS.find((l) => l.id === "L08"));
                  }}
                  style={{
                    ...btn(false),
                    width: "100%",
                    fontSize: 12,
                    border: `1px solid #ff6600`,
                    color: "#ff6600",
                  }}
                >
                  📄 VIEW FULL DOCUMENT
                </button>
              </div>

              {/* LOT 10 — Favor Auction simultaneous */}
              <div
                style={{
                  ...card,
                  padding: 14,
                  marginBottom: 10,
                  border: `1px solid #8b730055`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <p style={{ ...lbl, color: "#c8a000" }}>
                      🔴 LOT #10 — ACTIVE
                    </p>
                    <span style={bdg("#c8a000")}>FAVOR · CONTRACT</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 10, color: T.muted }}>Time Left</p>
                    <p
                      style={{
                        fontFamily: "'Cinzel',serif",
                        fontSize: 20,
                        color: "#c8a000",
                        animation: "pulse 1.7s infinite",
                      }}
                    >
                      22:45
                    </p>
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    lineHeight: 1.65,
                    fontFamily: "'IM Fell English',serif",
                    marginBottom: 10,
                  }}
                >
                  Data specialist · F · Merit · Advanced analysis + system
                  access + cryptography. One-year binding contract. University
                  attorneys have verified parameters.
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 6,
                    marginBottom: 10,
                  }}
                >
                  {[
                    ["CURRENT BID", "$11,500", "#c8a000"],
                    ["4 BIDS", "This lot", ""],
                    ["STARTING", "$5,000", T.muted],
                  ].map(([l2, v, c]) => (
                    <div
                      key={l2}
                      style={{
                        background: T.tag,
                        borderRadius: 6,
                        padding: 8,
                        border: `1px solid ${T.border}`,
                        textAlign: "center",
                      }}
                    >
                      <p style={{ ...lbl, fontSize: 8, marginBottom: 2 }}>
                        {l2}
                      </p>
                      <p
                        style={{
                          fontFamily: "'Cinzel',serif",
                          fontSize: 13,
                          color: c || T.muted,
                        }}
                      >
                        {v}
                      </p>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    placeholder="Min $11,501"
                    style={{ ...inp, flex: 1, padding: "9px 12px" }}
                    onChange={(e) => {}}
                  />
                  <button
                    type="button"
                    className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toast("Bid submitted — Lot #10");
                    }}
                    style={{ ...btn(true), flexShrink: 0 }}
                  >
                    BID
                  </button>
                </div>
                <button
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedLot(LOTS.find((l) => l.id === "L10"));
                  }}
                  style={{
                    ...btn(false),
                    width: "100%",
                    fontSize: 12,
                    border: `1px solid #c8a000`,
                    color: "#c8a000",
                  }}
                >
                  📄 VIEW FULL DOCUMENT
                </button>
              </div>

              <div
                style={{
                  ...card,
                  padding: 12,
                  marginBottom: 10,
                  background: "rgba(212,175,55,.04)",
                  border: `1px solid ${T.border}`,
                }}
              >
                <p style={{ ...lbl, marginBottom: 6 }}>TONIGHT\'S SCHEDULE</p>
                {[
                  ["Lot 7 — Pet", "LIVE NOW", "#ff3b3b"],
                  ["Lot 8 — Virgin", "LIVE NOW", "#ff6600"],
                  ["Lot 10 — Favor", "LIVE NOW", "#c8a000"],
                  ["Lot 9 — Pet", "Up Next · 30min", "#d4af37"],
                  ["Lots 11–14", "Later Tonight", "#8b7355"],
                ].map(([name, status, c]) => (
                  <div
                    key={name}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "5px 0",
                      borderBottom: `1px solid ${T.border}`,
                    }}
                  >
                    <span style={{ fontSize: 12, color: T.text }}>{name}</span>
                    <span
                      style={{
                        fontSize: 11,
                        color: c,
                        fontFamily: "'Cinzel',serif",
                      }}
                    >
                      {status}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {aTab === "all" &&
            LOTS.map((l, i) => (
              <button
                key={l.id}
                type="button"
                className="b"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedLot(l);
                }}
                style={{
                  ...card,
                  width: "100%",
                  padding: 13,
                  marginBottom: 8,
                  textAlign: "left",
                  borderLeft: `3px solid ${
                    l.status === "live"
                      ? "#ff3b3b"
                      : l.status === "sold"
                      ? T.muted
                      : T.primary
                  }`,
                  animation: `fadeUp ${0.06 + i * 0.04}s ease`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: T.text,
                        marginBottom: 3,
                      }}
                    >
                      Lot #{l.num} — {l.type.toUpperCase()}
                    </p>
                    <span
                      style={{
                        ...bdg(
                          l.status === "live"
                            ? "#ff3b3b"
                            : l.status === "sold"
                            ? T.muted
                            : T.primary
                        ),
                        color:
                          l.status === "live"
                            ? "#ff3b3b"
                            : l.status === "sold"
                            ? T.muted
                            : T.primary,
                      }}
                    >
                      {l.status.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {l.finalPrice && (
                      <p
                        style={{
                          fontFamily: "'Cinzel',serif",
                          fontSize: 13,
                          color: T.muted,
                        }}
                      >
                        SOLD ${l.finalPrice.toLocaleString()}
                      </p>
                    )}
                    {l.status === "live" && (
                      <p
                        style={{
                          fontFamily: "'Cinzel',serif",
                          fontSize: 13,
                          color: "#ff3b3b",
                        }}
                      >
                        LIVE ${liveBid.toLocaleString()}
                      </p>
                    )}
                    {l.startBid && l.status === "upcoming" && (
                      <p style={{ fontSize: 12, color: T.muted }}>
                        From ${l.startBid.toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                  }}
                >
                  {l.subject?.reason ||
                    l.subject?.standing ||
                    l.family?.background?.slice(0, 80) + "…" ||
                    "Click to view document."}
                </p>
                <p style={{ fontSize: 11, color: T.primary, marginTop: 5 }}>
                  → View full document
                </p>
              </button>
            ))}

          {aTab === "past" &&
            [
              {
                name: "Winter Auction 2023",
                date: "Dec 14, 2023",
                lots: 12,
                revenue: "$1.24M",
                note: "Highest virgin auction in 5 years: $110,000. Three bidding wars.",
              },
              {
                name: "Fall Auction 2023",
                date: "Oct 7, 2023",
                lots: 9,
                revenue: "$890K",
                note: "Three-way bidding war on Pet Lot #4. Blackwood family dominated.",
              },
              {
                name: "Spring Auction 2023",
                date: "Mar 18, 2023",
                lots: 14,
                revenue: "$1.6M",
                note: "First Secrets lot to exceed $100K. Record attendance: 92.",
              },
              {
                name: "Winter Auction 2022",
                date: "Dec 10, 2022",
                lots: 8,
                revenue: "$740K",
                note: "Blackwood family acquired three lots in one evening.",
              },
              {
                name: "Spring Auction 2022",
                date: "Mar 5, 2022",
                lots: 10,
                revenue: "$1.1M",
                note: "Virgin Lot sold anonymous for $98,000. Second highest on record.",
              },
            ].map((p, i) => (
              <div
                key={i}
                style={{
                  ...card,
                  padding: 14,
                  marginBottom: 10,
                  animation: `fadeUp ${0.06 + i * 0.07}s ease`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 7,
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: T.text,
                        marginBottom: 2,
                      }}
                    >
                      {p.name}
                    </p>
                    <p style={{ fontSize: 11, color: T.muted }}>
                      {p.date} · {p.lots} lots
                    </p>
                  </div>
                  <p
                    style={{
                      fontFamily: "'Cinzel',serif",
                      fontSize: 14,
                      color: T.primary,
                    }}
                  >
                    {p.revenue}
                  </p>
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    fontFamily: "'IM Fell English',serif",
                    fontStyle: "italic",
                    borderTop: `1px solid ${T.border}`,
                    paddingTop: 7,
                  }}
                >
                  "{p.note}"
                </p>
              </div>
            ))}

          {aTab === "catalog" && (
            <>
              <div
                style={{
                  ...card,
                  padding: 12,
                  marginBottom: 10,
                  background: "rgba(139,0,0,.05)",
                  border: `1px solid ${T.danger}44`,
                }}
              >
                <p style={{ fontSize: 12, color: T.danger, lineHeight: 1.7 }}>
                  Spring Catalog. Click any lot to view the full document
                  including family background, inspection data, and bid history.
                </p>
              </div>
              {LOTS.map((l, i) => (
                <button
                  key={l.id}
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedLot(l);
                  }}
                  style={{
                    ...card,
                    width: "100%",
                    padding: 13,
                    marginBottom: 8,
                    textAlign: "left",
                    animation: `fadeUp ${0.06 + i * 0.05}s ease`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 7,
                    }}
                  >
                    <div>
                      <p style={lbl}>LOT #{l.num}</p>
                      <span
                        style={bdg(
                          l.type === "virgin"
                            ? T.accent
                            : l.type === "pet"
                            ? T.sec
                            : T.primary
                        )}
                      >
                        {l.type.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {l.finalPrice && (
                        <p
                          style={{
                            fontFamily: "'Cinzel',serif",
                            fontSize: 12,
                            color: T.muted,
                          }}
                        >
                          SOLD ${l.finalPrice.toLocaleString()}
                        </p>
                      )}
                      {l.startBid && (
                        <p style={{ fontSize: 12, color: T.muted }}>
                          {l.status === "live" ? "LIVE" : "From"} $
                          {(l.status === "live"
                            ? liveBid
                            : l.startBid
                          ).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                  {l.subject && l.subject.age && (
                    <p
                      style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}
                    >
                      {l.subject.gender} · Age {l.subject.age} ·{" "}
                      {l.subject.standing}
                    </p>
                  )}
                  {l.medical?.sensitivity && (
                    <span style={pill(false)}>
                      📊 Sensitivity {l.medical.sensitivity}%
                    </span>
                  )}
                  <p style={{ fontSize: 11, color: T.primary, marginTop: 7 }}>
                    → View full document
                  </p>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // PORTAL INTERACTION DATA
  // ═══════════════════════════════════════════════════════
  const FAVOR_ACTIONS = [
    { id:"order",   icon:"📋", label:"Issue an Order" },
    { id:"display", icon:"👁",  label:"Put Them on Display" },
    { id:"punish",  icon:"⚡", label:"Correct Their Behavior" },
    { id:"demand",  icon:"🥂", label:"Demand Gratitude" },
    { id:"test",    icon:"⚖️",  label:"Test Their Limits" },
  ];
  const VIRGINITY_ACTIONS = [
    { id:"touch",   icon:"✋",  label:"Touch Them", requiresToy:false },
    { id:"tease",   icon:"🕯️", label:"Build Anticipation", requiresToy:false },
    { id:"toy",     icon:"🌙", label:"Use a Toy", requiresToy:true },
    { id:"push",    icon:"🔥", label:"Push Further", requiresToy:false },
    { id:"command", icon:"📿", label:"Give a Command", requiresToy:false },
  ];
  const PET_ACTIONS = [
    { id:"pet_order",     icon:"📋", label:"Give an Order" },
    { id:"pet_reward",    icon:"🍬", label:"Offer a Reward" },
    { id:"pet_inspect",   icon:"🔍", label:"Inspect Them" },
    { id:"pet_collar",    icon:"⛓️", label:"Adjust Their Collar" },
    { id:"pet_correct",   icon:"⚡", label:"Correct Behavior" },
    { id:"pet_toy",       icon:"🎀", label:"Use a Toy", requiresToy: true },
    { id:"pet_drug_comp", icon:"💊", label:"Compliance Drug", requiresDrug: true },
    { id:"pet_drug_sens", icon:"✨", label:"Sensitivity Elixir", requiresDrug: true },
    { id:"pet_drug_vit",  icon:"⚗️", label:"Vitality Dose", requiresDrug: true },
    { id:"pet_condition", icon:"🔥", label:"Physical Conditioning" },
  ];
  const DRUG_IDS = ["vitality_pill","compliance_drops","sensitivity_elixir","compliance_drop","nootropic","vitality"];
  const hasDrug = () => inventory.some((i: any) => DRUG_IDS.includes(i.itemId));

  const INTERACTION_RESPONSES: Record<string, Record<string, string[]>> = {
    // ── FAVOR actions ──────────────────────────────────────
    order: {
      high_obedience: [
        "Yes. Right away.",
        "Understood. Doing it now.",
        "As you wish. I won't hesitate.",
        "Of course. Whatever you need.",
        "I'll handle it immediately.",
      ],
      high_broken: [
        "...okay. I'll do it.",
        "Yes. I'll try.",
        "I— yes. Okay.",
        "I know better than to argue.",
        "Fine. Just— fine.",
      ],
      high_sensitivity: [
        "My hands are shaking but yes.",
        "I'll do it. Don't watch me.",
        "I hate how easy it is for you to ask that.",
        "You know what that does to me. And you still ask.",
        "One day I'll say no. Today is not that day.",
      ],
      default: [
        "You really enjoy this, don't you.",
        "I know what I agreed to.",
        "Fine.",
        "You could say please.",
        "I suppose I have no choice.",
      ],
    },
    display: {
      high_broken: [
        "Don't make me look at them while you do this.",
        "I know what I look like right now.",
        "I used to care more about this.",
        "Go ahead.",
        "I've stopped being embarrassed. That's worse, isn't it.",
      ],
      high_sensitivity: [
        "Everyone is watching. You know that.",
        "I can feel where their eyes are.",
        "Please don't say anything clever right now.",
        "I'm not— I'm fine. I'm fine.",
        "Stop smiling. Please.",
      ],
      high_obedience: [
        "Where would you like me to stand.",
        "Should I hold still.",
        "Like this?",
        "I'll follow your lead.",
        "Tell me how you want me positioned.",
      ],
      default: [
        "This was not in the description.",
        "You could have warned me.",
        "I don't appreciate this.",
        "I'm enduring this.",
        "Make it quick.",
      ],
    },
    punish: {
      high_broken: [
        "I know. I'm sorry.",
        "Please— I'll fix it.",
        "Don't. I already know I failed.",
        "I'm sorry. I'm sorry. I'm sorry.",
        "I'll be better. I promise.",
      ],
      high_sensitivity: [
        "That— okay. Okay.",
        "I wasn't ready for that.",
        "Can you— a little warning—",
        "I'm not— okay, I'm okay.",
        "You enjoy watching that.",
      ],
      high_obedience: [
        "Yes. I understand.",
        "I deserved that.",
        "I'll do better.",
        "You're right.",
        "Noted. Won't happen again.",
      ],
      default: [
        "That hurt.",
        "You enjoy this.",
        "I'm aware of what I did wrong.",
        "This is disproportionate.",
        "I'll remember that.",
      ],
    },
    demand: {
      high_obedience: [
        "Thank you for having me.",
        "I'm grateful for everything.",
        "Of course. Anything else?",
        "Truly. Thank you.",
        "I understand how fortunate I am.",
      ],
      high_broken: [
        "...thank you.",
        "I know what you want me to say.",
        "Yes. I'm grateful.",
        "You have everything you want from me.",
        "Whatever you need to hear.",
      ],
      high_sensitivity: [
        "I— yes. I am. Grateful.",
        "Don't make me cry right now.",
        "I hate that you can make me mean it.",
        "Yes. I mean it.",
        "You know I mean it. That's worse.",
      ],
      default: [
        "Is that what you need?",
        "Fine. Thank you.",
        "I'm grateful.",
        "If it helps.",
        "You want it sincerely or just the words.",
      ],
    },
    test: {
      high_broken: [
        "I already know I'll give in.",
        "You already know how this ends.",
        "Don't. I can't pretend to resist anymore.",
        "I know what you want. Do it.",
        "There's nothing left to test.",
      ],
      high_sensitivity: [
        "That's not— you can't just—",
        "I wasn't ready for that question.",
        "You know exactly what you're doing.",
        "Stop. Or don't. I don't know.",
        "You're enjoying watching me work through that.",
      ],
      high_obedience: [
        "I'll do whatever you ask.",
        "Name it.",
        "No limits from my end.",
        "Test away.",
        "I'll comply.",
      ],
      default: [
        "Let's find out.",
        "You think you know the answer already.",
        "Push it and see.",
        "I might surprise you.",
        "This is a game to you.",
      ],
    },
    // ── VIRGINITY actions ──────────────────────────────────
    touch: {
      high_sensitivity: [
        "Don't— oh.",
        "Your hands are— I didn't think it would feel like that.",
        "Wait. Wait.",
        "I can feel where you're touching even after you move.",
        "That's... a lot.",
      ],
      high_broken: [
        "Okay.",
        "I know you'll do what you want.",
        "I'm not going to stop you.",
        "Go ahead.",
        "You can feel that I'm scared.",
      ],
      high_obedience: [
        "I'm staying still.",
        "Like this?",
        "Tell me what you want me to do.",
        "I won't move unless you want me to.",
        "Wherever you need.",
      ],
      default: [
        "I wasn't ready for that.",
        "Okay. Okay.",
        "Is this—",
        "We're really doing this.",
        "My heart is going very fast right now.",
      ],
    },
    tease: {
      high_sensitivity: [
        "I can't— you're not even—",
        "Stop. Please keep going. No, stop.",
        "This is worse than if you just did it.",
        "How are you so calm right now.",
        "I hate this more than I hate the alternative.",
      ],
      high_broken: [
        "Please just— please.",
        "I can't take the waiting.",
        "You know I'll ask for it. Don't you.",
        "This is cruel.",
        "...please.",
      ],
      high_obedience: [
        "I'll wait for your cue.",
        "I'm not moving.",
        "Whenever you're ready.",
        "I can hold still.",
        "Tell me what you need from me.",
      ],
      default: [
        "What are you doing.",
        "You're not— you're doing that on purpose.",
        "I need you to do something.",
        "I can't predict you.",
        "I don't know if I should ask or wait.",
      ],
    },
    toy: {
      high_sensitivity: [
        "Oh— that's— I wasn't— okay.",
        "I don't know what I expected but not that.",
        "Where did you— don't answer that.",
        "That's too much, and not enough.",
        "I need you to slow down.",
      ],
      high_broken: [
        "Okay. Whatever you want.",
        "I know there's more.",
        "...yes.",
        "I'll hold still.",
        "Don't ask me if I'm okay.",
      ],
      high_obedience: [
        "I'm ready.",
        "Do what you want with it.",
        "Yes.",
        "Whatever you decide.",
        "I trust you.",
      ],
      default: [
        "I— is that—",
        "Okay. We're doing this.",
        "You planned this.",
        "I was not mentally prepared.",
        "Where did that come from.",
      ],
    },
    push: {
      high_broken: [
        "I'll give you whatever you want.",
        "There's nothing left to hold back.",
        "Yes.",
        "Do it.",
        "I already gave up control.",
      ],
      high_sensitivity: [
        "I can't— you can't—",
        "Wait—",
        "Okay. Okay. Okay.",
        "I don't know if I can do this.",
        "I need a second.",
      ],
      high_obedience: [
        "As far as you want.",
        "I won't say stop.",
        "Lead and I'll follow.",
        "I'm yours.",
        "All of it.",
      ],
      default: [
        "We're really going there.",
        "Okay.",
        "This is happening.",
        "I made a choice and I'm keeping it.",
        "...okay.",
      ],
    },
    command: {
      high_obedience: [
        "Yes. Immediately.",
        "Of course.",
        "Doing it.",
        "I understand.",
        "Anything else?",
      ],
      high_broken: [
        "I'll do it.",
        "...yes.",
        "Okay. Okay.",
        "I know not to argue.",
        "If you say so.",
      ],
      high_sensitivity: [
        "When you say it like that—",
        "I hate how quickly I respond to your voice.",
        "Okay. I'll do it.",
        "Don't look at me while I do this.",
        "Your voice does something to me.",
      ],
      default: [
        "Fine.",
        "Understood.",
        "Do you always get what you ask for.",
        "Apparently.",
        "I heard you.",
      ],
    },
    // ── PET actions ───────────────────────────────────────
    pet_order: {
      high_obedience: [
        "Yes, Master.",
        "Understood.",
        "Right away.",
        "As you wish.",
        "Of course.",
      ],
      high_broken: [
        "...yes.",
        "I'll do it.",
        "Okay.",
        "*nods quietly*",
        "Yes.",
      ],
      high_sensitivity: [
        "I— yes. Yes.",
        "When you say it like that I can't think straight.",
        "Yes. Sorry. Yes.",
        "I'll try.",
        "For you, yes.",
      ],
      default: [
        "Understood.",
        "I'll comply.",
        "Done.",
        "On it.",
        "As commanded.",
      ],
    },
    pet_reward: {
      high_sensitivity: [
        "*visibly affected*",
        "Thank you. I— thank you.",
        "I wasn't expecting that.",
        "...oh.",
        "That means more than it should.",
      ],
      high_broken: [
        "Thank you.",
        "*quiet*",
        "I didn't know I needed that.",
        "...okay.",
        "I'll remember this.",
      ],
      high_obedience: [
        "Thank you. I'll keep being good.",
        "I earned this?",
        "This motivates me.",
        "I won't forget.",
        "I'll do better next time.",
      ],
      default: [
        "Oh.",
        "Thank you.",
        "This is unexpected.",
        "*surprised*",
        "I'll try to deserve it.",
      ],
    },
    pet_inspect: {
      high_sensitivity: [
        "Don't— your eyes are everywhere.",
        "I feel every look.",
        "Must you be so thorough.",
        "I'm trying not to react.",
        "...finished?",
      ],
      high_broken: [
        "I know what you see.",
        "Look as long as you like.",
        "I've stopped hiding things.",
        "*stays still*",
        "Go ahead.",
      ],
      high_obedience: [
        "Standing by.",
        "Check whatever you need.",
        "I'm yours to review.",
        "Take your time.",
        "Any concerns?",
      ],
      default: [
        "*endures quietly*",
        "Satisfied?",
        "Anything you'd like to note.",
        "I'll wait.",
        "Thorough as always.",
      ],
    },
    pet_collar: {
      high_sensitivity: [
        "Your hands are— sorry. I'm fine.",
        "Every time you touch it I feel it for hours.",
        "It sits differently now.",
        "I notice everything about it.",
        "I know exactly where it is on me.",
      ],
      high_broken: [
        "*tilts head for access*",
        "Do what you need to.",
        "I know what this means.",
        "Better?",
        "It's fine. I'm used to it.",
      ],
      high_obedience: [
        "*presents neck*",
        "Is this how you want it.",
        "Adjust it however you like.",
        "I'll hold still.",
        "Done. Thank you.",
      ],
      default: [
        "*waits*",
        "Good?",
        "Feel better about it now.",
        "I barely notice it anymore.",
        "Let me know when you're done.",
      ],
    },
    pet_correct: {
      high_broken: [
        "I know. I'm sorry.",
        "I already felt it before you said it.",
        "I'll fix it.",
        "Don't— I know.",
        "I'll be better.",
      ],
      high_sensitivity: [
        "That— okay. I'll remember.",
        "You didn't have to do it like that.",
        "I understand.",
        "Noted. *unsettled*",
        "I felt that.",
      ],
      high_obedience: [
        "Understood. Won't happen again.",
        "You're right.",
        "I accept the correction.",
        "I'll improve.",
        "Yes. I was wrong.",
      ],
      default: [
        "Understood.",
        "I'll remember.",
        "Fair.",
        "Noted.",
        "I hear you.",
      ],
    },
    // ── PET TOY ───────────────────────────────────────────
    pet_toy: {
      high_sensitivity: [
        "*sharp intake of breath* What is— where did you—",
        "I wasn't— oh. Oh.",
        "Please slow down. Please.",
        "Every sensation is— I can't think.",
        "*trembling* I didn't know it would be like this.",
        "You're watching my face. Please don't.",
        "I can't stop— I can't—",
      ],
      high_broken: [
        "*quiet, resigned* Do what you want with it.",
        "I'll hold still.",
        "Use it however you want.",
        "I know not to ask you to stop.",
        "*doesn't resist*",
        "I trust that you'll end it eventually.",
        "Go ahead.",
      ],
      high_obedience: [
        "Yes. I'm ready.",
        "*stays perfectly still*",
        "Whatever you want to use on me.",
        "Tell me what position you want me in.",
        "I won't move. I promise.",
        "I'll do whatever helps you.",
        "Here. Like this?",
      ],
      default: [
        "I— okay. Okay.",
        "We're really doing this.",
        "You planned this.",
        "*breathes carefully*",
        "I need a second. Just a second.",
        "I can do this. I can.",
        "*eyes closed*",
      ],
    },
    // ── PET DRUG — COMPLIANCE ─────────────────────────────
    pet_drug_comp: {
      high_sensitivity: [
        "*slow blink* Everything feels... softer.",
        "I don't... I can't find the word for no.",
        "My thoughts are very quiet right now.",
        "You can ask me anything. I think I'll say yes.",
        "*docile* What do you need from me?",
        "I feel very agreeable.",
        "Tell me what to do. I want to do it.",
      ],
      high_broken: [
        "I already couldn't refuse. This just makes it... easier.",
        "*distant, calm* Whatever you want.",
        "Everything is so soft.",
        "I don't have any edges right now.",
        "*quiet and compliant*",
        "I feel... peaceful. Is that the right word.",
        "Yes. Yes to everything.",
      ],
      high_obedience: [
        "I'm yours. Completely.",
        "*very still* Your voice is the only thing I'm following.",
        "I'll do everything. Just tell me.",
        "My whole body is listening to you.",
        "Yes. Whatever you say.",
        "I can feel it working. I don't mind.",
        "Every command feels like the right thing to do.",
      ],
      default: [
        "Something's... different.",
        "I feel— I don't know. Soft.",
        "Is this what you wanted?",
        "*unfocused eyes* I'm still here.",
        "I'll do whatever you say. I think.",
        "My resistance is very far away right now.",
        "*slow, compliant*",
      ],
    },
    // ── PET DRUG — SENSITIVITY ────────────────────────────
    pet_drug_sens: {
      high_sensitivity: [
        "*sharp gasp* Don't— everything is—",
        "I can feel the air. I can feel the air on my skin.",
        "Your voice is too loud and too clear.",
        "*overwhelmed* Everything is happening at once.",
        "Please don't touch me and please don't stop.",
        "Even the fabric— *shudders*",
        "I can feel my pulse everywhere.",
      ],
      high_broken: [
        "I can feel everything and I can't do anything about it.",
        "*quiet intensity* Every sensation is enormous.",
        "I know I shouldn't react this much.",
        "You know exactly what this does.",
        "*controlled breathing* It's a lot.",
        "My skin remembers where you touched it.",
        "I'm trying to stay still.",
      ],
      high_obedience: [
        "*very focused* Whatever you want to do — I'll feel everything.",
        "I'm yours. And I feel all of it.",
        "Touch me anywhere. I'll respond.",
        "*trembling but still*",
        "You have my complete attention.",
        "I'll stay still no matter what.",
        "I can feel this everywhere. I'm not moving.",
      ],
      default: [
        "*startled* What did you— oh.",
        "Everything is so much.",
        "I wasn't ready for this level of—",
        "*breathes carefully*",
        "That's— a lot.",
        "I can feel things I usually don't notice.",
        "*very awake*",
      ],
    },
    // ── PET DRUG — VITALITY ───────────────────────────────
    pet_drug_vit: {
      high_sensitivity: [
        "My heart is going very fast. Is that normal?",
        "I feel like I could do anything right now.",
        "*intensely alert* I'm very aware of you.",
        "Everything is bright and very clear.",
        "I don't feel tired at all. At all.",
        "*flushed* Is my face doing something?",
        "You have my complete attention. All of it.",
      ],
      high_broken: [
        "I forgot what energy felt like.",
        "*tentative* I feel good. Is that allowed.",
        "I can do more. I want to do more.",
        "I feel ready for whatever you need.",
        "*more present than usual*",
        "I didn't know I was this tired until now.",
        "I'll be useful. I promise.",
      ],
      high_obedience: [
        "Ready. Completely ready.",
        "Tell me what you need. I can handle anything.",
        "*eager* What do you want me to do?",
        "I'll go all night if you want.",
        "I have so much energy right now.",
        "Command me. I'll execute perfectly.",
        "Whatever the task, I'm prepared.",
      ],
      default: [
        "That's— something.",
        "I feel very alive right now.",
        "What do you want me to do with all this.",
        "*pacing slightly*",
        "Is this what you wanted from me?",
        "I could run for miles right now. Or do whatever you say.",
        "*heightened, present*",
      ],
    },
    // ── PET CONDITIONING ──────────────────────────────────
    pet_condition: {
      high_sensitivity: [
        "Everything hurts and I want to do better.",
        "*struggling but continuing*",
        "I feel every correction.",
        "I'll get it right. Just— again.",
        "I'm trying. You can see I'm trying.",
        "My body remembers this. It will.",
        "Don't stop. I need to get better.",
      ],
      high_broken: [
        "I'll do whatever routine you set.",
        "Tell me the standard and I'll meet it.",
        "*silent, focused*",
        "Again. I can go again.",
        "I'll reach whatever you're asking for.",
        "Yes. More if you want.",
        "I've been through harder than this.",
      ],
      high_obedience: [
        "On your command.",
        "How many repetitions?",
        "Tell me the form you want and I'll hold it.",
        "*perfectly disciplined*",
        "I'll execute exactly as instructed.",
        "Faster? Slower? Tell me.",
        "Ready for the next set.",
      ],
      default: [
        "I'll keep going.",
        "You're watching for form?",
        "Tell me what I'm doing wrong.",
        "*focused and working*",
        "This is harder than it looks.",
        "I won't stop until you say so.",
        "Give me the standard.",
      ],
    },
  };

  const getInteractionResponse = (actionId: string, sensitivity: number, broken: number, obedience: number): string => {
    const pools = INTERACTION_RESPONSES[actionId];
    if (!pools) return "...";
    let pool: string[];
    if (broken >= 70) pool = pools.high_broken || pools.default;
    else if (obedience >= 80) pool = pools.high_obedience || pools.default;
    else if (sensitivity >= 75) pool = pools.high_sensitivity || pools.default;
    else pool = pools.default;
    if (!pool || !pool.length) pool = Object.values(pools)[0] || ["..."];
    return pool[Math.floor(Math.random() * pool.length)];
  };

  const TOY_IDS = ["velvet_cuffs","silk_blindfold","riding_crop","sensory_kit","pleasure_set","leash_set","collar_premium","premium_collar"];
  const hasToy = () => inventory.some((i: any) => TOY_IDS.includes(i.itemId));

  // ═══════════════════════════════════════════════════════
  // INVENTORY BAG
  // ═══════════════════════════════════════════════════════
  const InventoryBag = () => {
    const cats = [
      { id: "all",     label: "ALL",     emoji: "🎒" },
      { id: "gift",    label: "GIFTS",   emoji: "🎁" },
      { id: "pet",     label: "PETS",    emoji: "🔗" },
      { id: "item",    label: "ITEMS",   emoji: "📦" },
      { id: "claimed", label: "CLAIMED", emoji: "🏛️" },
    ];

    // Build claimed listings from all portal tabs
    const allPortalListings = [
      ...PORTAL_LISTINGS.pets.map((l: any) => ({ ...l, _cat: "pets" })),
      ...PORTAL_LISTINGS.favors.map((l: any) => ({ ...l, _cat: "favors" })),
      ...PORTAL_LISTINGS.virginity.map((l: any) => ({ ...l, _cat: "virginity" })),
    ];
    const myHandle = user?.handle || user?.un || "";
    const myClaimedListings = uid ? allPortalListings.filter((l: any) => portalClaims[l.id] === uid || portalClaims[l.id] === myHandle) : [];

    const shown = bagTab === "all" ? inventory : bagTab === "claimed" ? [] : inventory.filter((i: any) => i.type === bagTab || i.category === bagTab);
    const grouped: Record<string, any[]> = {};
    shown.forEach((item: any) => {
      if (!grouped[item.itemId]) grouped[item.itemId] = [];
      grouped[item.itemId].push(item);
    });
    const entries = Object.values(grouped);

    const statBar = (val: number, color: string) => (
      <div style={{ flex: 1, height: 3, background: T.dim, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${val}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
    );

    const openInteraction = (listing: any) => {
      setInteractionModal({ open: true, listing, response: null, action: null });
    };

    return (
      <div>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 22 }}>🎒</span>
            <div>
              <span style={ttl()}>INVENTORY</span>
              <p style={{ ...sub, marginTop: 2, fontSize: 11 }}>
                {inventory.length} item{inventory.length !== 1 ? "s" : ""}
                {myClaimedListings.length > 0 && ` · ${myClaimedListings.length} claimed`}
              </p>
            </div>
          </div>
        </div>

        {/* Category tabs */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, background: T.bg, overflowX: "auto" as any }}>
          {cats.map(c => (
            <button key={c.id} onClick={() => setBagTab(c.id)} style={{ flex: 1, minWidth: 60, padding: "11px 0", background: "none", border: "none", borderBottom: bagTab === c.id ? `2px solid ${T.primary}` : "2px solid transparent", color: bagTab === c.id ? T.primary : T.muted, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", fontFamily: "'Cinzel',serif", whiteSpace: "nowrap" as any }}>
              {c.emoji} {c.label}
              {c.id === "claimed" && myClaimedListings.length > 0 && (
                <span style={{ marginLeft: 4, background: T.primary, color: T.bg, borderRadius: 8, fontSize: 9, padding: "1px 5px" }}>{myClaimedListings.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* CLAIMED tab */}
        {bagTab === "claimed" && (
          <div style={{ ...sec, paddingTop: 12 }}>
            {myClaimedListings.length === 0 ? (
              <div style={{ textAlign: "center" as any, padding: "60px 0" }}>
                <p style={{ fontSize: 36, marginBottom: 12 }}>🏛️</p>
                <p style={{ color: T.muted, fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>
                  You have no portal claims yet.
                </p>
                <button type="button" onClick={() => { setSubPage("dark_portal"); go("university"); }} style={{ ...btn(true), marginTop: 16, padding: "10px 24px" }}>
                  Visit the Portal
                </button>
              </div>
            ) : (
              myClaimedListings.map((listing: any) => {
                const isVirginity = listing._cat === "virginity";
                const isFavor = listing._cat === "favors";
                const isPetListing = listing._cat === "pets";
                const catColor = isVirginity ? "#8b1a2c" : isFavor ? "#8b6000" : "#1a3a5c";
                const catLabel = isVirginity ? "VIRGINITY" : isFavor ? "FAVOR" : "PET";
                const catIcon  = isVirginity ? "🌙" : isFavor ? "🥂" : "🔗";
                const isActive = interactionModal.open && interactionModal.listing?.id === listing.id;
                return (
                  <div key={listing.id} style={{ ...card, marginBottom: 14, padding: 0, overflow: "hidden", border: isActive ? `1px solid ${T.primary}` : `1px solid ${T.border}` }}>
                    {/* Header */}
                    <div style={{ padding: "12px 14px 10px", borderBottom: `1px solid ${T.border}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, background: catColor, color: "#fff", padding: "2px 8px", borderRadius: 10, letterSpacing: "0.1em" }}>{catIcon} {catLabel}</span>
                            {listing.rating && <span style={{ fontSize: 10, color: "#c0a060" }}>★ {listing.rating}/10</span>}
                          </div>
                          <p style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 2 }}>{listing.name}</p>
                          {listing.major && <p style={{ fontSize: 11, color: T.muted }}>{listing.major} · Year {listing.year}</p>}
                        </div>
                        <span style={{ fontSize: 28 }}>{listing.pic || "👤"}</span>
                      </div>
                    </div>

                    {/* Stats */}
                    {(listing.sensitivity !== undefined || listing.broken !== undefined || listing.obedience !== undefined) && (
                      <div style={{ padding: "8px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", gap: 12 }}>
                        {[
                          { label: "SENSITIVITY", val: listing.sensitivity ?? 0, color: "#8b1a2c" },
                          { label: "BROKEN", val: listing.broken ?? 0, color: "#5a3060" },
                          { label: "OBEDIENCE", val: listing.obedience ?? 0, color: "#2a4a6a" },
                        ].map(s => (
                          <div key={s.label} style={{ flex: 1 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                              <span style={{ fontSize: 8, color: T.muted, letterSpacing: "0.08em" }}>{s.label}</span>
                              <span style={{ fontSize: 8, color: T.muted }}>{s.val}</span>
                            </div>
                            {statBar(s.val, s.color)}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Use button */}
                    {!isPetListing && (
                      <div style={{ padding: "10px 14px" }}>
                        <button type="button" onClick={() => openInteraction(listing)} style={{ ...btn(true), width: "100%", padding: "10px", fontSize: 12 }}>
                          {isActive ? "▾ Close Interaction" : `✦ Use ${catLabel}`}
                        </button>
                      </div>
                    )}
                    {isPetListing && (
                      <div style={{ padding: "10px 14px" }}>
                        <button type="button" onClick={() => openInteraction(listing)} style={{ ...btn(true), width: "100%", padding: "10px", fontSize: 12 }}>
                          {isActive ? "▾ Close" : "✦ Interact With Pet"}
                        </button>
                      </div>
                    )}

                    {/* Inline interaction panel */}
                    {isActive && (
                      <div style={{ padding: "14px", background: T.dim, borderTop: `1px solid ${T.border}` }}>
                        <p style={{ fontSize: 11, color: T.muted, marginBottom: 10, fontFamily: "'Cinzel',serif", letterSpacing: "0.1em" }}>
                          CHOOSE AN INTERACTION
                        </p>
                        {/* Action grid */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                          {(isFavor ? FAVOR_ACTIONS : isVirginity ? VIRGINITY_ACTIONS : PET_ACTIONS).map((act: any) => {
                            const needsToy  = act.requiresToy  && !hasToy();
                            const needsDrug = act.requiresDrug && !hasDrug();
                            const blocked = needsToy || needsDrug;
                            const blockedLabel = needsToy ? "Requires toy" : needsDrug ? "Requires drug" : null;
                            const blockedMsg = needsToy
                              ? "⚠️ You need a toy for this. Visit the Vault in the Noctis Market to purchase one."
                              : "⚠️ You need a drug item for this. Visit the Vault in the Noctis Market to purchase one.";
                            return (
                              <button key={act.id} type="button"
                                onClick={() => {
                                  if (blocked) {
                                    setInteractionModal(m => ({ ...m, response: blockedMsg, action: act.id }));
                                    return;
                                  }
                                  const resp = getInteractionResponse(act.id, listing.sensitivity ?? 60, listing.broken ?? 40, listing.obedience ?? 50);
                                  setInteractionModal(m => ({ ...m, response: `"${resp}"`, action: act.id }));
                                }}
                                style={{
                                  padding: "10px 8px", background: "none", border: `1px solid ${interactionModal.action === act.id ? T.primary : T.border}`,
                                  borderRadius: 8, color: interactionModal.action === act.id ? T.primary : T.text, fontSize: 12, cursor: blocked ? "default" : "pointer",
                                  textAlign: "left" as any, fontFamily: "'Cinzel',serif", opacity: blocked ? 0.6 : 1,
                                }}
                              >
                                <span style={{ fontSize: 14, marginRight: 6 }}>{act.icon}</span>
                                {act.label}
                                {blockedLabel && <span style={{ display: "block", fontSize: 9, color: T.muted, marginTop: 2 }}>{blockedLabel}</span>}
                              </button>
                            );
                          })}
                        </div>
                        {/* Response bubble */}
                        {interactionModal.response && (
                          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 14px" }}>
                            <p style={{ fontSize: 11, color: T.muted, marginBottom: 6, letterSpacing: "0.08em", fontFamily: "'Cinzel',serif" }}>
                              {listing.name?.split(" ")[0]?.toUpperCase()}:
                            </p>
                            <p style={{ fontSize: 14, color: T.text, fontFamily: "'IM Fell English',serif", fontStyle: "italic", lineHeight: 1.5 }}>
                              {interactionModal.response}
                            </p>
                            {interactionModal.response.includes("⚠️") && (
                              <button type="button" onClick={() => { setSubPage("shop"); go("university"); }} style={{ ...btn(true), marginTop: 10, padding: "8px 16px", fontSize: 11 }}>
                                🛒 Go to Vault
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Regular inventory tabs */}
        {bagTab !== "claimed" && (
          <div style={{ ...sec, paddingTop: 12 }}>
            {entries.length === 0 ? (
              <div style={{ textAlign: "center" as any, padding: "60px 0" }}>
                <p style={{ fontSize: 40, marginBottom: 14 }}>🎒</p>
                <p style={{ color: T.muted, fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>
                  {bagTab === "all" ? "Your inventory is empty. Visit the Noctis Market to acquire items." : "Nothing in this category."}
                </p>
                {bagTab === "all" && (
                  <button type="button" onClick={() => { setSubPage("shop"); go("university"); }} style={{ ...btn(true), marginTop: 16, padding: "10px 24px" }}>
                    Go to Market
                  </button>
                )}
              </div>
            ) : (
              entries.map((stack: any[]) => {
                const item = stack[0];
                const qty = stack.length;
                const isGiftForTrent = item.giftTarget === "trent_morrison";
                const isGiftForCyrus = item.giftTarget === "cyrus_whitmore";
                const isAffinityGift = isGiftForTrent || isGiftForCyrus;
                const tl = isGiftForTrent && uid ? getTrentLevel(trentRel[uid]||0)
                         : isGiftForCyrus && uid ? getCyrusLevel(cyrusRel[uid]||0)
                         : null;
                return (
                  <div key={item.itemId} style={{ ...card, marginBottom: 12, padding: "14px 14px 12px" }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ width: 52, height: 52, borderRadius: 12, background: T.dim, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, flexShrink: 0, position: "relative" as any }}>
                        {item.icon}
                        {qty > 1 && (
                          <span style={{ position: "absolute" as any, bottom: -4, right: -4, background: T.primary, color: T.bg, borderRadius: 10, fontSize: 10, fontWeight: 700, padding: "1px 5px", minWidth: 16, textAlign: "center" as any }}>×{qty}</span>
                        )}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                          <p style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 2 }}>{item.name}</p>
                          <span style={{ fontSize: 10, color: T.muted, marginLeft: 8, flexShrink: 0 }}>
                            {item.type === "gift" ? "🎁 GIFT" : item.type === "pet" ? "🔗 PET" : "📦 ITEM"}
                          </span>
                        </div>
                        {item.desc && <p style={{ fontSize: 12, color: T.muted, fontStyle: "italic", marginBottom: 6, lineHeight: 1.4 }}>{item.desc}</p>}
                        {isGiftForTrent && tl && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <span style={{ fontSize: 11, color: tl.color, fontWeight: 700 }}>Trent L{tl.level}: {tl.name}</span>
                            {item.relPoints && <span style={{ fontSize: 10, color: T.muted }}>+{item.relPoints} pts when given</span>}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as any, alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: T.muted }}>Acquired {new Date(item.purchasedAt).toLocaleDateString()}</span>
                          {item.price && <span style={{ fontSize: 10, color: T.muted }}>· Paid ₦{item.price.toLocaleString()}</span>}
                          {isAffinityGift && (
                            <button type="button" onClick={() => giveGiftToAffinity(item)} style={{ ...btn(false), padding: "5px 12px", fontSize: 11, marginLeft: "auto", borderColor: T.primary, color: T.primary }}>
                              🎁 Give to {isGiftForCyrus ? "Cyrus" : "Trent"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // ACQUISITION PORTAL (First-Come-First-Serve)
  // ═══════════════════════════════════════════════════════
  const Portal = () => {
    const tabs: Array<{key:"pets"|"favors"|"virginity"; label: string; emoji: string}> = [
      { key: "pets", label: "PETS", emoji: "🔗" },
      { key: "favors", label: "FAVORS", emoji: "🥂" },
      { key: "virginity", label: "VIRGINITY", emoji: "🌙" },
    ];
    const listings = PORTAL_LISTINGS[portalTab];
    const ratingColor = (r: number) => r >= 9 ? "#ffd700" : r >= 8 ? "#c0a060" : r >= 7 ? "#8b9080" : "#666";
    return (
      <div>
        <div style={hdr}>
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <span style={ttl()}>🏛 ACQUISITION PORTAL</span>
            <p style={{ ...sub, marginTop: 4 }}>First come, first served. No bidding. Pay and it's yours.</p>
          </div>
        </div>
        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, background: T.bg }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setPortalTab(t.key)} style={{ flex: 1, padding: "12px 0", background: "none", border: "none", borderBottom: portalTab === t.key ? `2px solid ${T.primary}` : "2px solid transparent", color: portalTab === t.key ? T.primary : T.muted, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", cursor: "pointer", fontFamily: "'Cinzel',serif" }}>
              {t.emoji} {t.label}
            </button>
          ))}
        </div>
        <div style={{ ...sec, paddingTop: 12 }}>
          <p style={{ fontSize: 11, color: T.muted, marginBottom: 16, letterSpacing: "0.08em" }}>
            {listings.length} LISTING{listings.length !== 1 ? "S" : ""} AVAILABLE · BALANCE: <span style={{ color: T.primary }}>₦{walletBalance.toLocaleString()}</span>
          </p>
          {listings.map((item: any) => {
            const claimed = portalClaims[item.id];
            const isMe = claimed && uid && (claimed === (user?.handle || user?.un));
            return (
              <div key={item.id} style={{ ...card, marginBottom: 14, borderLeft: claimed ? `3px solid ${T.muted}` : `3px solid ${T.primary}55`, opacity: claimed && !isMe ? 0.7 : 1 }}>
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <span style={{ fontSize: 10, color: T.muted, letterSpacing: "0.12em" }}>{item.code || item.id.toUpperCase()}</span>
                    {item.name && <p style={{ fontSize: 15, fontWeight: 700, color: T.text, fontFamily: "'Cinzel',serif", marginTop: 2 }}>{item.name}</p>}
                    {item.age && <p style={{ fontSize: 11, color: T.muted, marginTop: 1 }}>{item.age}y · {item.year} Year · {item.major}</p>}
                    {!item.age && item.provider && <p style={{ fontSize: 11, color: T.muted, marginTop: 1 }}>{item.provider} · {item.category}</p>}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                    <div style={{ fontSize: 11, color: ratingColor(item.rating), fontWeight: 700, marginBottom: 2 }}>★ {item.rating?.toFixed(1)}</div>
                    <div style={{ fontSize: 12, color: T.primary, fontWeight: 700 }}>₦{item.price.toLocaleString()}</div>
                  </div>
                </div>
                {/* Background / Description */}
                {item.background && (
                  <p style={{ fontSize: 13, color: T.text, fontFamily: "'IM Fell English',serif", lineHeight: 1.6, marginBottom: 8, borderLeft: `2px solid ${T.border}`, paddingLeft: 8 }}>
                    {item.background}
                  </p>
                )}
                {item.desc && (
                  <p style={{ fontSize: 13, color: T.text, fontFamily: "'IM Fell English',serif", lineHeight: 1.6, marginBottom: 8 }}>
                    {item.desc}
                  </p>
                )}
                {item.details && (
                  <p style={{ fontSize: 12, color: T.muted, lineHeight: 1.5, marginBottom: 8 }}>
                    {item.details}
                  </p>
                )}
                {item.personality && (
                  <p style={{ fontSize: 12, color: T.muted, marginBottom: 8 }}><span style={{ color: T.primary }}>Profile:</span> {item.personality}</p>
                )}
                {/* Inspector note */}
                <div style={{ background: T.dim, border: `1px solid ${T.border}`, borderRadius: 4, padding: "8px 10px", marginBottom: 10 }}>
                  <p style={{ fontSize: 10, color: T.muted, letterSpacing: "0.1em", marginBottom: 3 }}>INSPECTOR'S NOTE</p>
                  <p style={{ fontSize: 12, color: T.muted, fontStyle: "italic", lineHeight: 1.5 }}>{item.inspectorNote}</p>
                </div>
                {/* Claim row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  {claimed ? (
                    <div style={{ fontSize: 12, color: isMe ? T.primary : T.muted }}>
                      {isMe ? "✓ CLAIMED BY YOU" : `CLAIMED — ${claimed}`}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: T.muted }}>🟢 AVAILABLE</div>
                  )}
                  {!claimed && uid && (
                    <button
                      onClick={() => claimPortalListing(item.id, item.price, item.name || item.code)}
                      style={{ background: T.primary, color: T.bg, border: "none", borderRadius: 4, padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em", fontFamily: "'Cinzel',serif" }}
                    >
                      CLAIM ₦{item.price.toLocaleString()}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // NOCTIS MARKET (SHOP)
  // ═══════════════════════════════════════════════════════
  const Shop = () => {
    const allItems = [
      ...SHOP_ITEMS.general,
      ...(isApex ? SHOP_ITEMS.apexVault : []),
      ...SHOP_ITEMS.auction.filter((i: any) => !i.apexOnly || isApex),
    ];
    const filtered = allItems.filter((item: any) => localShopCat === "all" || item.category === localShopCat);
    return (
      <div>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button type="button" onClick={() => setSubPage(null)} style={{ background: "none", border: "none", color: T.muted, fontSize: 18 }}>←</button>
              <span style={ttl()}>🛍️ NOCTIS MARKET</span>
            </div>
            <div style={{ background: T.card, padding: "5px 12px", borderRadius: 20, border: `1px solid ${T.primary}` }}>
              <span style={{ fontSize: 11, color: T.muted }}>₦</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: T.primary, marginLeft: 3 }}>{walletBalance.toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div style={sec}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 7, overflowX: "auto" as any, padding: "10px 0", marginBottom: 8 }}>
            {[["shop","🛍️ Shop"],["cart",`🛒 Cart (${cart.reduce((s: number, i: any) => s + i.quantity, 0)})`],["orders","📦 Orders"],["wishlist",`💝 (${wishlist.size})`],["reviews","⭐ Reviews"],["daily","🎯 Daily"],["sales","🏷️ Sales"],["gifts","🎁 Gifts"]].map(([id, label]) => (
              <button key={id} type="button" className="b" onClick={() => setShopTab(id)} style={pill(shopTab === id)}>{label}</button>
            ))}
          </div>

          {/* SHOP TAB */}
          {shopTab === "shop" && (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as any, marginBottom: 12 }}>
                {[["all","All"],["daily","☕ Daily"],["supplies","📚 Supplies"],["clothing","👕 Clothing"],["tickets","🎫 Tickets"],["collectibles","🏆 Collectibles"],...(isApex ? [["adult","🔞 Apex Vault"],["wellness","💊 Wellness"]] : [])].map(([cat, label]) => (
                  <button key={cat} type="button" className="b" onClick={() => setLocalShopCat(cat)} style={pill(localShopCat === cat)}>{label}</button>
                ))}
              </div>
              {FLASH_SALES.length > 0 && (
                <div className="flash-sale" style={{ ...card, padding: 12, marginBottom: 10, border: `2px solid ${T.danger}`, background: `${T.danger}18` }}>
                  <p style={{ ...lbl, color: T.danger, marginBottom: 3 }}>⚡ FLASH SALE — Limited Time!</p>
                  <p style={{ fontSize: 12, color: T.text }}>Up to 40% off select items</p>
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column" as any, gap: 10 }}>
                {filtered.map((item: any) => {
                  const finalPrice = getItemPrice(item);
                  const discount = item.price > finalPrice ? Math.round((1 - finalPrice / item.price) * 100) : 0;
                  const rating = getItemRating(item.id);
                  const inWL = wishlist.has(item.id);
                  return (
                    <div key={item.id} style={{ ...card, padding: 12, position: "relative" as any }}>
                      {discount > 0 && <div style={{ position: "absolute" as any, top: 8, right: 8, background: T.danger, color: "#fff", padding: "2px 8px", borderRadius: 12, fontSize: 10, fontWeight: 700 }}>-{discount}%</div>}
                      <div style={{ display: "flex", gap: 12 }}>
                        <div style={{ width: 48, height: 48, borderRadius: 8, background: T.tag, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>{item.icon}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as any, marginBottom: 4 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{item.name}</span>
                            {item.adult && <span style={bdg(T.danger)}>🔞</span>}
                            {item.apexOnly && <span style={bdg(T.primary)}>👑 APEX</span>}
                          </div>
                          <p style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>{item.desc}</p>
                          {rating && <p style={{ fontSize: 11, color: T.accent, marginBottom: 4 }}>{"★".repeat(Math.floor(rating.avg))}{"☆".repeat(5 - Math.floor(rating.avg))} ({rating.count})</p>}
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as any }}>
                            <span style={{ fontSize: 15, fontWeight: 600, color: T.primary }}>₦{finalPrice.toLocaleString()}</span>
                            {discount > 0 && <span style={{ fontSize: 11, color: T.muted, textDecoration: "line-through" }}>₦{item.price.toLocaleString()}</span>}
                            <button type="button" className="b" onClick={() => addToCart(item)} style={{ ...btn(true), padding: "4px 12px", fontSize: 11 }}>Add to Cart</button>
                            <button type="button" className="b" onClick={() => inWL ? removeFromWishlist(item.id) : addToWishlist(item.id)} style={{ background: "none", border: "none", fontSize: 18 }}>{inWL ? "❤️" : "🤍"}</button>
                            <button type="button" className="b" onClick={() => setGiftModal({ open: true, itemId: item.id, itemName: item.name, price: finalPrice })} style={{ background: "none", border: "none", fontSize: 12, color: T.muted }}>🎁 Gift</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* CART TAB */}
          {shopTab === "cart" && (
            <div>
              {cart.length === 0 ? (
                <div style={{ ...card, padding: 40, textAlign: "center" as any }}><p style={{ fontSize: 40, marginBottom: 12 }}>🛒</p><p style={{ color: T.muted }}>Your cart is empty</p></div>
              ) : (
                <>
                  {cart.map((item: any) => (
                    <div key={item.id} style={{ ...card, padding: 12, marginBottom: 8 }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                        <div style={{ width: 40, height: 40, borderRadius: 8, background: T.tag, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{item.icon}</div>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{item.name}</p>
                          <p style={{ fontSize: 11, color: T.muted }}>₦{item.price.toLocaleString()} each</p>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <button type="button" className="b" onClick={() => updateCartQuantity(item.id, item.quantity - 1)} style={{ ...btn(false), padding: "3px 8px" }}>-</button>
                          <span style={{ fontSize: 14, color: T.text }}>{item.quantity}</span>
                          <button type="button" className="b" onClick={() => updateCartQuantity(item.id, item.quantity + 1)} style={{ ...btn(false), padding: "3px 8px" }}>+</button>
                          <button type="button" className="b" onClick={() => removeFromCart(item.id)} style={{ background: "none", border: "none", color: T.danger, fontSize: 16 }}>✕</button>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div style={{ ...card, padding: 14, marginTop: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={{ fontSize: 14, color: T.text }}>Subtotal</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: T.primary }}>₦{cart.reduce((s: number, i: any) => s + i.price * i.quantity, 0).toLocaleString()}</span>
                    </div>
                    <button type="button" className="b" onClick={checkout} style={{ ...btn(true), width: "100%", padding: "12px" }}>Checkout</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ORDERS TAB */}
          {shopTab === "orders" && (
            <div>
              {purchases.filter((p: any) => p.type === "purchase").length === 0 ? (
                <div style={{ ...card, padding: 40, textAlign: "center" as any }}><p style={{ fontSize: 40, marginBottom: 12 }}>📦</p><p style={{ color: T.muted }}>No orders yet</p></div>
              ) : purchases.filter((p: any) => p.type === "purchase").map((order: any) => (
                <div key={order.id} style={{ ...card, padding: 12, marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: T.muted }}>{new Date(order.date).toLocaleDateString()}</span>
                    <span style={{ fontSize: 11, color: T.primary }}>Purchase</span>
                  </div>
                  <p style={{ fontSize: 13, color: T.text, marginBottom: 4 }}>{order.reason}</p>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                    <span style={{ fontSize: 12, color: T.muted }}>Amount</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: T.primary }}>₦{order.amount.toLocaleString()}</span>
                  </div>
                  {order.itemDetails?.itemId && !reviews[order.itemDetails.itemId]?.some((r: any) => r.userId === uid) && (
                    <button type="button" className="b" onClick={() => setRatingModal({ open: true, itemId: order.itemDetails.itemId, itemName: order.itemDetails.name })} style={{ ...btn(false), width: "100%", marginTop: 8, padding: "6px", fontSize: 11 }}>⭐ Write a Review</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* WISHLIST TAB */}
          {shopTab === "wishlist" && (
            <div>
              {wishlist.size === 0 ? (
                <div style={{ ...card, padding: 40, textAlign: "center" as any }}><p style={{ fontSize: 40, marginBottom: 12 }}>💝</p><p style={{ color: T.muted }}>Your wishlist is empty</p></div>
              ) : allItems.filter((i: any) => wishlist.has(i.id)).map((item: any) => (
                <div key={item.id} style={{ ...card, padding: 12, marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: T.tag, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{item.icon}</div>
                    <div style={{ flex: 1 }}><p style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{item.name}</p><p style={{ fontSize: 12, color: T.primary }}>₦{getItemPrice(item).toLocaleString()}</p></div>
                    <button type="button" className="b" onClick={() => addToCart(item)} style={{ ...btn(true), padding: "6px 12px", fontSize: 11 }}>Add to Cart</button>
                    <button type="button" className="b" onClick={() => removeFromWishlist(item.id)} style={{ background: "none", border: "none", fontSize: 18, color: T.danger }}>❤️</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* REVIEWS TAB */}
          {shopTab === "reviews" && (
            <div>
              {Object.keys(reviews).length === 0 ? (
                <div style={{ ...card, padding: 40, textAlign: "center" as any }}><p style={{ fontSize: 40, marginBottom: 12 }}>⭐</p><p style={{ color: T.muted }}>No reviews yet. Buy items to review them.</p></div>
              ) : Object.entries(reviews).map(([itemId, itemReviews]: [string, any]) => {
                const item = allItems.find((i: any) => i.id === itemId);
                if (!item) return null;
                return (
                  <div key={itemId} style={{ ...card, padding: 12, marginBottom: 8 }}>
                    <p style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 8 }}>{item.icon} {item.name}</p>
                    {itemReviews.map((rev: any) => (
                      <div key={rev.id} style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, color: T.accent }}>{"★".repeat(rev.rating)}{"☆".repeat(5 - rev.rating)}</span>
                          <span style={{ fontSize: 10, color: T.muted }}>{rev.userName}</span>
                        </div>
                        {rev.comment && <p style={{ fontSize: 12, color: T.muted, fontStyle: "italic" }}>"{rev.comment}"</p>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {/* DAILY REWARDS TAB */}
          {shopTab === "daily" && (
            <div>
              <div style={{ ...card, padding: 20, marginBottom: 10, textAlign: "center" as any }}>
                <p style={{ fontSize: 36, marginBottom: 8 }}>🎯</p>
                <p style={{ ...ttl(16), marginBottom: 4 }}>DAILY REWARD</p>
                <p style={{ color: T.muted, fontSize: 13, marginBottom: 12 }}>Current streak: {dailyStreak} / 7 days</p>
                <div style={{ display: "flex", gap: 4, justifyContent: "center", marginBottom: 14 }}>
                  {[1,2,3,4,5,6,7].map(day => (
                    <div key={day} style={{ width: 32, height: 32, borderRadius: 6, background: day <= dailyStreak ? T.primary : T.tag, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: day <= dailyStreak ? "#000" : T.muted }}>
                      {day <= dailyStreak ? "✓" : day}
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Today's reward: ₦{(100 + Math.min(dailyStreak + 1, 7) * 50 + (dailyStreak + 1 >= 7 ? 300 : 0)).toLocaleString()}</p>
                <button type="button" className="b" onClick={claimDailyReward} disabled={dailyClaimed} style={{ ...btn(!dailyClaimed), width: "100%", padding: "12px", opacity: dailyClaimed ? 0.5 : 1 }}>
                  {dailyClaimed ? "✓ Claimed Today" : "Claim Daily Reward"}
                </button>
              </div>
              <div style={{ ...card, padding: 14 }}>
                <p style={{ ...lbl, marginBottom: 10 }}>TODAY'S DEALS</p>
                {DAILY_DEALS.map(deal => {
                  const item = SHOP_ITEMS.general.find((i: any) => i.id === deal.itemId);
                  if (!item) return null;
                  return (
                    <div key={deal.itemId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                      <span style={{ fontSize: 13, color: T.text }}>{item.icon} {item.name}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: T.danger, fontWeight: 700 }}>-{deal.discount}%</span>
                        <span style={{ fontSize: 13, color: T.primary }}>₦{Math.floor(item.price * (1 - deal.discount / 100)).toLocaleString()}</span>
                        <button type="button" className="b" onClick={() => addToCart(item)} style={{ ...btn(true), padding: "3px 10px", fontSize: 10 }}>Add</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SALES TAB */}
          {shopTab === "sales" && (
            <div>
              <div style={{ ...card, padding: 14, marginBottom: 10, border: `2px solid ${T.danger}`, background: `${T.danger}10` }}>
                <p style={{ ...lbl, color: T.danger, marginBottom: 10 }}>⚡ FLASH SALES</p>
                {FLASH_SALES.filter((fs: any) => !fs.apexOnly || isApex).map(fs => {
                  const item = [...SHOP_ITEMS.general, ...SHOP_ITEMS.apexVault].find((i: any) => i.id === fs.itemId);
                  if (!item) return null;
                  return (
                    <div key={fs.itemId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                      <div><p style={{ fontSize: 13, color: T.text }}>{item.icon} {item.name}</p><p style={{ fontSize: 10, color: T.muted }}>Expires in {fs.expiresIn}h</p></div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: T.muted, textDecoration: "line-through" }}>₦{fs.originalPrice.toLocaleString()}</span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: T.danger }}>₦{fs.salePrice.toLocaleString()}</span>
                        <button type="button" className="b" onClick={() => addToCart({ ...item, price: fs.salePrice })} style={{ ...btn(true), padding: "3px 10px", fontSize: 10 }}>Add</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* GIFTS TAB */}
          {shopTab === "gifts" && (
            <div>
              {/* Affinity banners — one per character */}
              {uid && ([
                { name: "TRENT MORRISON", pic: "/trent_pool.webp", pts: trentRel[uid]||0, lvl: getTrentLevel(trentRel[uid]||0), levels: TRENT_REL_LEVELS },
                { name: "CYRUS WHITMORE", pic: "/cyrus.jpeg", pts: cyrusRel[uid]||0, lvl: getCyrusLevel(cyrusRel[uid]||0), levels: CYRUS_REL_LEVELS },
              ].map(({ name, pic, pts, lvl, levels }) => {
                const next = levels.find(l => l.min > pts);
                const pct = next ? Math.min(100, ((pts - lvl.min) / (next.min - lvl.min)) * 100) : 100;
                return (
                  <div key={name} style={{ ...card, padding: 14, marginBottom: 12, borderLeft: `3px solid ${lvl.color}` }}>
                    <p style={{ ...lbl, marginBottom: 6 }}>{name} — RELATIONSHIP</p>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {renderPic(pic, 36)}
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 700, color: lvl.color }}>Level {lvl.level} — {lvl.name}</p>
                        <p style={{ fontSize: 11, color: T.muted }}>{pts} pts · Send gifts to grow your relationship</p>
                      </div>
                    </div>
                    {!next ? (
                      <p style={{ fontSize: 11, color: "#ffd700", marginTop: 6 }}>★ Maximum level reached</p>
                    ) : (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.muted, marginBottom: 3 }}>
                          <span>{lvl.name}</span><span>{next.name} ({next.min - pts} pts away)</span>
                        </div>
                        <div style={{ background: T.dim, borderRadius: 4, height: 4, overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: lvl.color, borderRadius: 4 }} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              }))}
              <p style={{ fontSize: 11, color: T.muted, marginBottom: 10, letterSpacing: "0.08em" }}>GIFTS — Buy and give from your inventory. Each gift earns relationship points with its target.</p>
              {SHOP_ITEMS.gifts.map((item: any) => {
                const savedStock = (() => { try { return JSON.parse(localStorage.getItem("umbra_stock") || "{}"); } catch { return {}; } })();
                const remaining = savedStock[item.id] !== undefined ? savedStock[item.id] : item.stock;
                const inInventory = inventory.filter((i: any) => i.itemId === item.id);
                const targetName = item.giftTarget === "cyrus_whitmore" ? "Cyrus" : "Trent";
                const targetColor = item.giftTarget === "cyrus_whitmore" ? "#ff6f91" : T.primary;
                return (
                  <div key={item.id} style={{ ...card, padding: 14, marginBottom: 10, borderLeft: `2px solid ${targetColor}` }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ width: 46, height: 46, borderRadius: 10, background: T.tag, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{item.icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <p style={{ fontSize: 13, fontWeight: 600, color: T.text, margin: 0 }}>{item.name}</p>
                          <span style={{ fontSize: 9, color: targetColor, border: `1px solid ${targetColor}`, borderRadius: 8, padding: "1px 6px", letterSpacing: "0.05em" }}>FOR {targetName.toUpperCase()}</span>
                        </div>
                        <p style={{ fontSize: 12, color: T.muted, fontStyle: "italic", marginBottom: 6, lineHeight: 1.4 }}>{item.desc}</p>
                        <p style={{ fontSize: 11, color: targetColor, marginBottom: 8 }}>+{item.relPoints} relationship pts · ₦{item.price.toLocaleString()}</p>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as any }}>
                          <button type="button" onClick={() => addToCart(item)} style={{ ...btn(true), padding: "6px 14px", fontSize: 11 }}>🛒 Buy (₦{item.price.toLocaleString()})</button>
                          {inInventory.length > 0 && (
                            <button type="button" onClick={() => giveGiftToAffinity(inInventory[0])} style={{ ...btn(false), padding: "6px 14px", fontSize: 11, borderColor: targetColor, color: targetColor }}>
                              🎁 Give to {targetName} ({inInventory.length} owned)
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Rating Modal */}
          {ratingModal.open && (
            <div style={{ position: "fixed" as any, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
              <div style={{ ...card, padding: 20, width: 300 }}>
                <p style={{ ...ttl(13), marginBottom: 12 }}>REVIEW: {ratingModal.itemName}</p>
                <div style={{ display: "flex", gap: 6, marginBottom: 12, justifyContent: "center" }}>
                  {[1,2,3,4,5].map(s => (
                    <button key={s} type="button" onClick={() => setRatingValue(s)} style={{ background: "none", border: "none", fontSize: 28, color: s <= ratingValue ? T.primary : T.muted }}>★</button>
                  ))}
                </div>
                <textarea value={ratingComment} onChange={e => setRatingComment(e.target.value)} placeholder="Your comment (optional)..." style={{ ...inp, height: 80, resize: "none" as any, marginBottom: 12 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="b" onClick={() => addReview(ratingModal.itemId!, ratingModal.itemName, ratingValue, ratingComment)} style={{ ...btn(true), flex: 1 }}>Submit</button>
                  <button type="button" className="b" onClick={() => setRatingModal({ open: false, itemId: null, itemName: "" })} style={{ ...btn(false), flex: 1 }}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {/* Gift Modal */}
          {giftModal.open && (
            <div style={{ position: "fixed" as any, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
              <div style={{ ...card, padding: 20, width: 300 }}>
                <p style={{ ...ttl(13), marginBottom: 4 }}>🎁 GIFT: {giftModal.itemName}</p>
                <p style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>₦{giftModal.price.toLocaleString()}</p>
                <div style={{ position: "relative" as const, marginBottom: 8 }}>
                  <input value={giftUser} onChange={e => setGiftUser(e.target.value)} placeholder="Recipient username" style={{ ...inp, width: "100%" }} />
                  {(() => {
                    const matches = userMentionMatches(giftUser);
                    if (!giftUser.trim() || matches.length === 0) return null;
                    const exact = matches.find((m: any) => (m.un || "").toLowerCase() === giftUser.toLowerCase());
                    if (exact && matches.length === 1) return null;
                    return (
                      <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, marginTop: 4, background: T.card || "#1a1409", border: `1px solid ${T.border || "#362e1e"}`, borderRadius: 6, maxHeight: 200, overflowY: "auto" as const, zIndex: 250 }}>
                        {matches.map((m: any) => (
                          <button key={m.id} type="button" onClick={() => setGiftUser(m.un)}
                            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px", background: "none", border: "none", borderBottom: `1px solid ${T.border || "#362e1e"}`, color: T.text, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                            <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>{m.pic || "🌑"}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{m.un}</div>
                              <div style={{ fontSize: 10, color: T.muted }}>{(m.tier || "merit").toUpperCase()}{(m._real || m.isReal) ? " · REAL" : ""}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
                <input value={giftMessage} onChange={e => setGiftMessage(e.target.value)} placeholder="Message (optional)" style={{ ...inp, marginBottom: 12 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="b" onClick={sendGift} style={{ ...btn(true), flex: 1 }}>Send Gift</button>
                  <button type="button" className="b" onClick={() => setGiftModal({ open: false, itemId: null, itemName: "", price: 0 })} style={{ ...btn(false), flex: 1 }}>Cancel</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // MESSAGES (DMs)
  // ═══════════════════════════════════════════════════════
  const Messages = () => {
    const threads: Record<string, any[]> = {};
    for (const m of dmMessages) {
      const otherId = m.fromId === uid ? m.toId : m.fromId;
      if (!threads[otherId]) threads[otherId] = [];
      threads[otherId].push(m);
    }

    // Check if current DM target is a professor
    const activeProfConv = dmConvId ? PROFS.find((p: any) => p.id === dmConvId) : null;
    const activeProfHistory = activeProfConv ? (profDMHistory[activeProfConv.id] || []) : [];
    // profDMInput / profDMLoading / sendProfDM are top-level state — reused here for DM tab professor chat

    // Build professor thread entries for the thread list (only booked professors)
    const profThreadEntries: [string, any[]][] = Object.entries(profDMHistory)
      .filter(([profId, history]) => history.length > 0)
      .map(([profId, history]) => {
        const p = PROFS.find((pr: any) => pr.id === profId);
        const msgs = history.map((m: any, i: number) => ({
          id: `prof_${profId}_${i}`,
          fromId: m.role === "user" ? uid : profId,
          toId: m.role === "user" ? profId : uid,
          text: m.content,
          createdAt: new Date(Date.now() - (history.length - i) * 2000).toISOString(),
          fromUsername: m.role === "user" ? (user as any)?.un : p?.name,
          fromPic: m.role === "user" ? (user as any)?.pic : p?.pic,
        }));
        return [profId, msgs];
      });

    // Merge all threads (regular + professor)
    const allThreadsMap: Record<string, any[]> = { ...threads };
    for (const [pid, msgs] of profThreadEntries) {
      if (!allThreadsMap[pid]) allThreadsMap[pid] = msgs;
    }

    const threadList = Object.entries(allThreadsMap).sort((a, b) => {
      const aLast = a[1][a[1].length - 1]?.createdAt || 0;
      const bLast = b[1][b[1].length - 1]?.createdAt || 0;
      return new Date(bLast).getTime() - new Date(aLast).getTime();
    });
    const convMsgs = dmConvId
      ? (threads[dmConvId] || []).slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      : [];
    const convUser = dmConvId ? ACCTS[dmConvId] : null;
    const convName = activeProfConv?.name
      || convUser?.un
      || (dmConvId ? threads[dmConvId]?.find((m: any) => m.fromId === dmConvId)?.fromUsername : null)
      || (dmConvId ? threads[dmConvId]?.find((m: any) => m.toId === dmConvId)?.toUsername : null)
      || dmConvId || "";

    const activeGroup = groups.find((g: any) => g.id === activeGroupId) || null;

    return (
      <div style={{ paddingBottom: 80 }}>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", gap: 10 }}>
            {(dmConvId || activeGroupId) && (
              <button type="button" onClick={(e) => { e.preventDefault(); setDmConvId(null); setActiveGroupId(null); setDmMoneyMode(false); }}
                style={{ background: "none", border: "none", color: T.muted, fontSize: 18, cursor: "pointer" }}>←</button>
            )}
            <span style={ttl()}>
              {dmConvId ? `✉ DM — ${convName}` : activeGroupId ? `💬 ${activeGroup?.name || "Group"}` : "✉ MESSAGES"}
            </span>
            {dmConvId && (
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                <button type="button" onClick={loadDms}
                  style={{ background: "none", border: "none", color: T.muted, fontSize: 12, cursor: "pointer" }}>↻</button>
                {(ACCTS[dmConvId]?.autoReply || ACCTS[dmConvId]?.personality) && (
                  <button type="button" onClick={() => setShowDmAiPanel(v => !v)}
                    style={{ background: "none", border: `1px solid ${hasUserAiKey ? T.primary : T.muted}`, borderRadius: 4, padding: "3px 8px", color: hasUserAiKey ? T.primary : T.muted, fontSize: 10, cursor: "pointer", letterSpacing: "0.05em", lineHeight: 1.4, fontFamily: "inherit" }}>
                    {hasUserAiKey ? `🔑 ${(aiModel || "Custom").split("/").pop()?.split("-").slice(0,2).join("-") || "Custom"}` : "⚡ Free AI"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div style={{ ...sec, maxWidth: 600, margin: "0 auto" }}>
          {/* Tab switcher when not in a conversation */}
          {!dmConvId && !activeGroupId && (
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {(["dms", "groups"] as const).map(tab => (
                <button key={tab} type="button" className="b" onClick={() => setMessagesTab(tab)}
                  style={{ ...btn(messagesTab === tab), flex: 1, padding: "8px", fontSize: 12 }}>
                  {tab === "dms" ? "✉ DIRECT" : "💬 GROUPS"}
                </button>
              ))}
            </div>
          )}

          {/* ── AI Config Panel (shown when user taps AI badge in NPC DM) ── */}
          {dmConvId && (ACCTS[dmConvId]?.autoReply || ACCTS[dmConvId]?.personality) && showDmAiPanel && (
            <div style={{ ...card, padding: 14, marginBottom: 10, borderColor: hasUserAiKey ? T.primary : T.muted }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <p style={{ ...lbl, marginBottom: 3 }}>AI ENGINE</p>
                  <p style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>
                    {hasUserAiKey ? "Using your API key for this conversation." : "Currently using free AI. Add your own key for faster, smarter replies. Works with any OpenAI-compatible provider."}
                  </p>
                </div>
                <button type="button" onClick={() => setShowDmAiPanel(false)}
                  style={{ background: "none", border: "none", color: T.muted, fontSize: 16, cursor: "pointer", padding: "0 0 0 10px" }}>✕</button>
              </div>
              {[
                { label: "API Endpoint", val: aiApiBase, set: setAiApiBase, placeholder: "https://api.groq.com/openai/v1", type: "url" as const },
                { label: "API Key", val: aiApiKey, set: setAiApiKey, placeholder: "gsk_... or sk-...", type: "password" as const },
                { label: "Model", val: aiModel, set: setAiModel, placeholder: "llama-3.1-8b-instant", type: "text" as const },
              ].map(({ label, val, set, placeholder, type }) => (
                <div key={label} style={{ marginBottom: 8 }}>
                  <p style={{ fontSize: 10, color: T.muted, marginBottom: 3, letterSpacing: "0.08em" }}>{label.toUpperCase()}</p>
                  <input type={type} value={val} onChange={e => set(e.target.value)} placeholder={placeholder}
                    style={{ ...inp, fontSize: 12, fontFamily: type === "password" ? "monospace" : undefined }} />
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" className="b" onClick={() => {
                  saveAiCreds({ apiBase: aiApiBase.trim(), apiKey: aiApiKey.trim(), model: aiModel.trim() });
                  setShowDmAiPanel(false);
                  toast("✅ AI key saved");
                }} style={{ ...btn(true), flex: 1, padding: "9px", fontSize: 11 }}>SAVE</button>
                {hasUserAiKey && (
                  <button type="button" className="b" onClick={() => {
                    setAiApiBase(""); setAiApiKey(""); setAiModel("");
                    saveAiCreds({ apiBase: "", apiKey: "", model: "" });
                    setShowDmAiPanel(false);
                    toast("Switched to free AI");
                  }} style={{ ...btn(false), flex: 1, padding: "9px", fontSize: 11, borderColor: T.danger, color: T.danger }}>CLEAR KEY</button>
                )}
              </div>
              <p style={{ fontSize: 10, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                Key stays on your device only — never stored on UMBRA servers. Works with Groq, OpenRouter, or any OpenAI-compatible endpoint.
              </p>
            </div>
          )}

          {/* Affinity relationship badge when in Trent/Cyrus DM */}
          {dmConvId && uid && (dmConvId === "trent_morrison" || dmConvId === "cyrus_whitmore") && (() => {
            const isTrent = dmConvId === "trent_morrison";
            const pts = isTrent ? (trentRel[uid]||0) : (cyrusRel[uid]||0);
            const tl = isTrent ? getTrentLevel(pts) : getCyrusLevel(pts);
            return (
              <div onClick={() => { setSubPage("shop"); setShopTab("gifts"); go("university"); }} style={{ ...card, padding: "8px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10, cursor: "pointer", borderLeft: `3px solid ${tl.color}` }}>
                <span style={{ fontSize: 18 }}>🎁</span>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: tl.color }}>Rel. Level {tl.level}: {tl.name}</span>
                  <span style={{ fontSize: 11, color: T.muted, marginLeft: 8 }}>{pts} pts</span>
                </div>
                <span style={{ fontSize: 10, color: T.muted }}>Send Gift →</span>
              </div>
            );
          })()}

          {/* ── DIRECT MESSAGES TAB ── */}
          {messagesTab === "dms" && !dmConvId && !activeGroupId && (
            <>
              {/* Start-new-DM search bar with @ autocomplete */}
              <div style={{ position: "relative" as const, marginBottom: 12 }}>
                <input value={newDmQuery} onChange={e => setNewDmQuery(e.target.value)} placeholder="✉ Start new DM — type @ + username…"
                  style={{ ...inp, width: "100%" }} />
                {(() => {
                  const matches = userMentionMatches(newDmQuery, [uid || ""]);
                  if (!newDmQuery.trim() || matches.length === 0) return null;
                  return (
                    <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, marginTop: 4, background: T.card || "#1a1409", border: `1px solid ${T.border || "#362e1e"}`, borderRadius: 6, maxHeight: 280, overflowY: "auto" as const, zIndex: 60 }}>
                      {matches.map((m: any) => (
                        <button key={m.id} type="button" onClick={() => { setDmConvId(m.id); setNewDmQuery(""); }}
                          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", background: "none", border: "none", borderBottom: `1px solid ${T.border || "#362e1e"}`, color: T.text, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                          <span style={{ fontSize: 20, width: 28, textAlign: "center" }}>{m.pic || "🌑"}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{m.un}</div>
                            <div style={{ fontSize: 10, color: T.muted }}>{m.handle || `@${m.un.toLowerCase().replace(/\s+/g, "_")}`} · {(m.tier || "merit").toUpperCase()}{(m._real || m.isReal) ? " · REAL" : ""}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              {threadList.length === 0 && (
                <div style={{ textAlign: "center", color: T.muted, padding: "40px 0", fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>
                  No messages yet. Search above to start a conversation.
                </div>
              )}
              {threadList.map(([otherId, threadMsgs]) => {
                const other = ACCTS[otherId];
                const profEntry = PROFS.find((p: any) => p.id === otherId);
                // Prefer an inbound message's fromUsername (always the real display name)
                // over toUsername (which could be the raw ID if the conversation was initiated before the user was in ACCTS)
                const inbound = threadMsgs.find((m: any) => m.fromId !== uid);
                const otherName = profEntry?.name
                  || inbound?.fromUsername
                  || other?.un
                  || threadMsgs.find((m: any) => m.fromId === uid)?.toUsername
                  || otherId;
                const last = threadMsgs[threadMsgs.length - 1];
                const lastTime = last?.createdAt ? new Date(last.createdAt).getTime() : 0;
                const seenTime = dmLastSeen[otherId] ? new Date(dmLastSeen[otherId]).getTime() : 0;
                const hasUnread = last?.fromId !== uid && lastTime > seenTime;
                return (
                  <button key={otherId} type="button" className="b"
                    onClick={(e) => {
                      e.preventDefault();
                      setDmConvId(otherId);
                      const now = new Date().toISOString();
                      setDmLastSeen(prev => {
                        const next = { ...prev, [otherId]: now };
                        try { localStorage.setItem("umbra_dm_seen", JSON.stringify(next)); } catch {}
                        return next;
                      });
                    }}
                    style={{ ...card, width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", marginBottom: 8, textAlign: "left", borderLeft: hasUnread ? `3px solid ${T.primary}` : undefined }}>
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      {(() => {
                        // For professors: use their emoji pic directly
                        if (profEntry) return <span style={{ fontSize: 24, border: `1px solid ${profEntry.color}44`, borderRadius: "50%", padding: 2 }}>{profEntry.pic}</span>;
                        // Resolve pic: server (authoritative) → latest DM message fromPic → ACCTS → fallback
                        const msgPic = (() => { const msgs = threads[otherId] || []; for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].fromId === otherId && msgs[i].fromPic && !msgs[i].fromPic.match(/^[\p{Emoji}]/u)) return msgs[i].fromPic; } return null; })();
                        const p = serverProfilePics[otherId] || msgPic || other?.pic || "🌑";
                        return (p.startsWith("/") || p.startsWith("http") || p.startsWith("data:")) ? <img src={p} alt="" style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover" }} /> : <span style={{ fontSize: 24 }}>{p}</span>;
                      })()}
                      {hasUnread && <span style={{ position: "absolute", top: 0, right: 0, width: 10, height: 10, borderRadius: "50%", background: T.primary, border: `2px solid ${T.bg}` }} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: hasUnread ? 800 : 700, fontSize: 14, color: profEntry ? profEntry.color : T.text }}>
                        {profEntry ? `Prof. ${profEntry.name.split(" ").slice(-1)[0]}` : (other?.un || otherName)}
                        {profEntry && <span style={{ fontSize: 9, marginLeft: 6, color: T.muted, fontFamily: "'Cinzel',serif" }}>FACULTY</span>}
                      </div>
                      <div style={{ fontSize: 12, color: hasUnread ? T.primary : T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: hasUnread ? 600 : 400 }}>{last?.text}</div>
                    </div>
                    {last?.createdAt && (
                      <div style={{ fontSize: 10, color: T.muted, flexShrink: 0 }}>
                        {(() => { const d = new Date(last.createdAt); const now = new Date(); const diff = now.getTime() - d.getTime(); if (diff < 60000) return "now"; if (diff < 3600000) return `${Math.floor(diff/60000)}m`; if (diff < 86400000) return `${Math.floor(diff/3600000)}h`; return d.toLocaleDateString(); })()}
                      </div>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {/* ── PROFESSOR DM CONVERSATION ── */}
          {dmConvId && activeProfConv && (
            <div style={{ paddingBottom: 100 }}>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 16 }}>
                {activeProfHistory.map((m: { role: string; content: string }, i: number) => (
                  <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 8 }}>
                    {m.role === "assistant" && (
                      <span style={{ fontSize: 22, flexShrink: 0 }}>{activeProfConv.pic}</span>
                    )}
                    <div style={{
                      maxWidth: "78%", padding: "10px 14px", borderRadius: 14, fontSize: 13, lineHeight: 1.65,
                      background: m.role === "user" ? T.primary : T.tag,
                      color: T.text, border: `1px solid ${m.role === "user" ? T.primary : activeProfConv.color + "55"}`,
                      fontFamily: m.role === "assistant" ? "'IM Fell English',serif" : "inherit",
                      fontStyle: m.role === "assistant" ? "italic" : "normal",
                    }}>
                      {m.role === "assistant" && (
                        <span style={{ fontSize: 9, color: activeProfConv.color, display: "block", marginBottom: 4, fontFamily: "'Cinzel',serif", letterSpacing: "0.1em" }}>{activeProfConv.name.toUpperCase()}</span>
                      )}
                      {m.content}
                    </div>
                  </div>
                ))}
                {profDMLoading && (
                  <div style={{ display: "flex", justifyContent: "flex-start", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 22 }}>{activeProfConv.pic}</span>
                    <span style={{ fontSize: 12, color: T.muted, fontStyle: "italic" }}>…composing</span>
                  </div>
                )}
              </div>
              <div style={{ position: "fixed", bottom: 64, left: 0, right: 0, maxWidth: 600, margin: "0 auto", padding: "0 12px", zIndex: 10 }}>
                <div style={{ display: "flex", gap: 8, background: T.bg, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                  <input value={profDMInput} onChange={e => setProfDMInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendProfTabDM(); } }}
                    placeholder={`Message ${activeProfConv.name}…`}
                    style={{ ...inp, flex: 1, fontSize: 13 }} />
                  <button type="button" className="b" onClick={sendProfTabDM} disabled={profDMLoading}
                    style={{ ...btn(true), padding: "10px 16px", opacity: profDMLoading ? 0.5 : 1 }}>↑</button>
                </div>
              </div>
            </div>
          )}

          {/* ── OPEN DM CONVERSATION ── */}
          {dmConvId && !activeProfConv && (
            <>
              <div style={{ marginBottom: 80 }}>
                {convMsgs.map((m) => {
                  const isMine = m.fromId === uid;
                  const isTransfer = m.text?.startsWith("[💸 TRANSFER]");
                  const senderAcct = !isMine ? ACCTS[m.fromId] : null;
                  const senderPic = (!isMine && serverProfilePics[m.fromId]) || m.fromPic || senderAcct?.pic || "🌑";
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: isMine ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 8, marginBottom: 8 }}>
                      {!isMine && (
                        <button type="button" className="b" onClick={() => viewProf(m.fromId)}
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", flexShrink: 0 }}>
                          {(senderPic.startsWith("/") || senderPic.startsWith("http") || senderPic.startsWith("data:"))
                            ? <img src={senderPic} alt="" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
                            : <span style={{ fontSize: 20 }}>{senderPic}</span>}
                        </button>
                      )}
                      <div style={{
                        maxWidth: "72%",
                        background: isTransfer ? (isMine ? "#1a3a00" : "#0a2a0a") : isMine ? T.primary : T.tag,
                        color: isMine && !isTransfer ? "#000" : T.text,
                        padding: "9px 13px",
                        borderRadius: isMine ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                        fontSize: 14,
                        fontFamily: "'IM Fell English',serif",
                        border: isTransfer ? "1px solid #44ff44" : "none",
                      }}>
                        {m.imageUrl && (
                          <img src={m.imageUrl} alt="photo" style={{ display: "block", maxWidth: "100%", maxHeight: 260, borderRadius: 8, marginBottom: m.text && m.text !== "📷 Photo" ? 6 : 0, objectFit: "cover" }} />
                        )}
                        {m.text && m.text !== "📷 Photo" && m.text}
                      </div>
                    </div>
                  );
                })}
                {/* Scroll-to-bottom sentinel — auto-scrolled to when conversation opens or new message arrives */}
                <div ref={msgBottomRef} style={{ height: 1 }} />
                {/* NPC typing indicator */}
                {dmTyping && (
                  <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 8 }}>
                    <div style={{
                      background: T.tag,
                      padding: "10px 16px",
                      borderRadius: "16px 16px 16px 4px",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}>
                      <style>{`@keyframes dmDot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`}</style>
                      {[0, 0.2, 0.4].map((delay, i) => (
                        <span key={i} style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: T.muted,
                          display: "inline-block",
                          animation: `dmDot 1.2s ease-in-out ${delay}s infinite`,
                        }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {/* Money transfer panel */}
              {dmMoneyMode && (
                <div style={{ position: "fixed", bottom: 102, left: 0, right: 0, background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px 12px 0 0", padding: "14px 16px" }}>
                  <p style={{ ...lbl, marginBottom: 8, color: "#44ff44" }}>💸 SEND MONEY</p>
                  <input type="number" value={dmMoneyAmt} onChange={e => setDmMoneyAmt(e.target.value)} placeholder="Amount (₦)" style={{ ...inp, marginBottom: 8 }} />
                  <input value={dmMoneyNote} onChange={e => setDmMoneyNote(e.target.value)} placeholder="Note (optional)" style={{ ...inp, marginBottom: 8 }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="b" onClick={sendDmMoney} style={{ ...btn(true), flex: 1, padding: "9px", background: "#44ff44", color: "#000" }}>SEND ₦{dmMoneyAmt || "0"}</button>
                    <button type="button" className="b" onClick={() => setDmMoneyMode(false)} style={{ ...btn(false), flex: 1, padding: "9px" }}>CANCEL</button>
                  </div>
                </div>
              )}
              <div style={{ position: "fixed", bottom: 62, left: 0, right: 0, background: T.bg, borderTop: `1px solid ${T.border}`, padding: "10px 14px", display: "flex", gap: 8, alignItems: "center" }}>
                <input ref={dmPicRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { sendDmPic(f); e.target.value = ""; } }} />
                <button type="button" onClick={() => dmPicRef.current?.click()} style={{ background: "none", border: `1px solid ${T.border}`, color: T.muted, borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, cursor: "pointer", flexShrink: 0 }}>📷</button>
                <button type="button" onClick={() => { setDmMoneyMode(m => !m); }} style={{ background: "none", border: `1px solid ${T.border}`, color: "#44ff44", borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, cursor: "pointer", flexShrink: 0 }}>💸</button>
                <input
                  value={dmTxt}
                  onChange={(e) => setDmTxt(e.target.value)}
                  placeholder="Write a message…"
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDm(); } }}
                  style={{ ...inp, flex: 1 }}
                />
                <button type="button" onClick={sendDm} disabled={dmSending}
                  style={{ background: T.primary, border: "none", color: "#000", fontWeight: 700, borderRadius: 8, padding: "0 14px", height: 36, fontSize: 13, cursor: "pointer", opacity: dmSending ? 0.6 : 1, flexShrink: 0 }}>
                  SEND
                </button>
              </div>
            </>
          )}

          {/* ── GROUPS TAB ── */}
          {messagesTab === "groups" && !dmConvId && !activeGroupId && (
            <>
              <button type="button" className="b" onClick={() => setShowCreateGroup(true)} style={{ ...btn(true), width: "100%", padding: "10px", marginBottom: 12 }}>+ CREATE GROUP</button>
              {showCreateGroup && (
                <div style={{ ...card, padding: 14, marginBottom: 12 }}>
                  <p style={{ ...lbl, marginBottom: 8 }}>NEW GROUP</p>
                  <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Group name" style={{ ...inp, marginBottom: 10 }} />
                  <p style={{ fontSize: 11, color: T.muted, letterSpacing: "0.08em", marginBottom: 6 }}>MEMBERS</p>
                  {/* Selected member chips */}
                  {groupMemberPicks.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 8 }}>
                      {groupMemberPicks.map((mid: string) => {
                        const m = ACCTS[mid] as any;
                        if (!m) return null;
                        return (
                          <span key={mid} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 14, background: "rgba(212,175,55,0.12)", border: `1px solid ${T.primary || "#d4af37"}`, color: T.primary || "#d4af37", fontSize: 12, fontFamily: "inherit" }}>
                            <span>{m.pic || "🌑"}</span>
                            <span>{m.un}</span>
                            <button type="button" onClick={() => setGroupMemberPicks(p => p.filter(x => x !== mid))}
                              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, padding: 0, marginLeft: 2 }}>×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Search input + dropdown */}
                  <div style={{ position: "relative" as const, marginBottom: 8 }}>
                    <input value={groupMemberQuery} onChange={e => setGroupMemberQuery(e.target.value)} placeholder="@ search by username…" style={{ ...inp, width: "100%" }} />
                    {(() => {
                      const matches = userMentionMatches(groupMemberQuery, [...groupMemberPicks, uid || ""]);
                      if (!groupMemberQuery.trim() || matches.length === 0) return null;
                      return (
                        <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, marginTop: 4, background: T.card || "#1a1409", border: `1px solid ${T.border || "#362e1e"}`, borderRadius: 6, maxHeight: 240, overflowY: "auto" as const, zIndex: 60 }}>
                          {matches.map((m: any) => (
                            <button key={m.id} type="button" onClick={() => {
                              setGroupMemberPicks(p => p.includes(m.id) ? p : [...p, m.id]);
                              setGroupMemberQuery("");
                            }}
                              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px", background: "none", border: "none", borderBottom: `1px solid ${T.border || "#362e1e"}`, color: T.text, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                              <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>{m.pic || "🌑"}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{m.un}</div>
                                <div style={{ fontSize: 10, color: T.muted }}>{(m.tier || "merit").toUpperCase()}{(m._real || m.isReal) ? " · REAL" : ""}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  <p style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>You are automatically added. Type @ + a username to find someone.</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="b" onClick={createGroup} style={{ ...btn(true), flex: 1, padding: "9px" }}>CREATE</button>
                    <button type="button" className="b" onClick={() => { setShowCreateGroup(false); setGroupMemberPicks([]); setGroupMemberQuery(""); }} style={{ ...btn(false), flex: 1, padding: "9px" }}>CANCEL</button>
                  </div>
                </div>
              )}
              {groups.length === 0 && !showCreateGroup && (
                <div style={{ textAlign: "center", color: T.muted, padding: "40px 0", fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>
                  No group conversations yet. Create one above.
                </div>
              )}
              {groups.map((g: any) => {
                const lastMsg = (g.messages || []).slice(-1)[0];
                return (
                  <button key={g.id} type="button" className="b" onClick={() => setActiveGroupId(g.id)}
                    style={{ ...card, width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", marginBottom: 8, textAlign: "left" }}>
                    <span style={{ fontSize: 28 }}>💬</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{g.name}</div>
                      <div style={{ fontSize: 11, color: T.muted }}>{g.members.length} members</div>
                      {lastMsg && <div style={{ fontSize: 12, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastMsg.un}: {lastMsg.t}</div>}
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {/* ── OPEN GROUP CONVERSATION ── */}
          {activeGroupId && activeGroup && (
            <>
              <div style={{ marginBottom: 80 }}>
                <p style={{ fontSize: 11, color: T.muted, textAlign: "center", marginBottom: 10 }}>Members: {activeGroup.members.join(", ")}</p>
                {(activeGroup.messages || []).map((m: any) => {
                  const isMine = m.uid === uid;
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: isMine ? "flex-end" : "flex-start", marginBottom: 8 }}>
                      <div style={{
                        maxWidth: "78%",
                        background: isMine ? T.primary : T.tag,
                        color: isMine ? "#000" : T.text,
                        padding: "9px 13px",
                        borderRadius: isMine ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                        fontSize: 14,
                        fontFamily: "'IM Fell English',serif",
                      }}>
                        {!isMine && <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 3, color: T.muted }}>{m.un}</div>}
                        {m.t}
                      </div>
                    </div>
                  );
                })}
                {(activeGroup.messages || []).length === 0 && (
                  <div style={{ textAlign: "center", color: T.muted, padding: "30px 0", fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>No messages yet. Say something.</div>
                )}
              </div>
              <div style={{ position: "fixed", bottom: 62, left: 0, right: 0, background: T.bg, borderTop: `1px solid ${T.border}`, padding: "10px 14px", display: "flex", gap: 8 }}>
                <input value={groupTxt} onChange={e => setGroupTxt(e.target.value)} placeholder="Message group…"
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendGroupMessage(); } }}
                  style={{ ...inp, flex: 1 }} />
                <button type="button" onClick={sendGroupMessage} style={{ background: T.primary, border: "none", color: "#000", fontWeight: 700, borderRadius: 8, padding: "0 14px", height: 36, fontSize: 13, cursor: "pointer", flexShrink: 0 }}>SEND</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // CASINO
  // ═══════════════════════════════════════════════════════
  const Casino = () => {
    const SUIT = ["♠","♥","♦","♣"];
    const CARD_VALS = [2,3,4,5,6,7,8,9,10,10,10,10,11];
    const CARD_NAMES = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
    const SLOT_SYMBOLS = ["🌹","💎","🌑","⚔️","👑","🔥","💀","🦋","⛓️","🌙"];
    const RL_RED = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

    const makeDeck = () => {
      const d: number[] = [];
      for (let s=0;s<4;s++) for (let c=0;c<13;c++) d.push(CARD_VALS[c]);
      return d.sort(() => Math.random()-0.5);
    };
    const handVal = (hand: number[]) => {
      let v = hand.reduce((a,b)=>a+b,0);
      let aces = hand.filter(c=>c===11).length;
      while (v>21&&aces>0){v-=10;aces--;}
      return v;
    };
    const cardName = (v: number) => {
      if(v===11) return "A";
      if(v===10) return ["10","J","Q","K"][Math.floor(Math.random()*4)];
      return String(v);
    };

    const doCasinoWin = (mult: number) => {
      const win = Math.floor(casinoBet * mult);
      setWalletBalance(b=>{const nb=b+win; try{const d=JSON.parse(localStorage.getItem("umbra_wallets")||"{}");d[uid]=nb;localStorage.setItem("umbra_wallets",JSON.stringify(d));}catch{}return nb;});
      setCasinoWins(w=>{const n=w+1; try{const d=JSON.parse(localStorage.getItem("umbra_casino")||"{}");if(!d[uid])d[uid]={};d[uid].wins=n;localStorage.setItem("umbra_casino",JSON.stringify(d));}catch{}return n;});
      addInfluence(mult>=5?100:10);
      if(mult>=5) unlockAchievement("casino_jackpot","Casino Jackpot",{money:0,influence:100,xp:500});
      else if(casinoWins>=9) unlockAchievement("casino_shark","Casino Shark",{money:50000,influence:200,xp:200});
      return win;
    };
    const doCasinoLoss = () => {
      setWalletBalance(b=>{const nb=Math.max(0,b-casinoBet); try{const d=JSON.parse(localStorage.getItem("umbra_wallets")||"{}");d[uid]=nb;localStorage.setItem("umbra_wallets",JSON.stringify(d));}catch{}return nb;});
      setCasinoLosses(l=>{const n=l+1; try{const d=JSON.parse(localStorage.getItem("umbra_casino")||"{}");if(!d[uid])d[uid]={};d[uid].losses=n;localStorage.setItem("umbra_casino",JSON.stringify(d));}catch{}return n;});
    };

    // BLACKJACK
    const bjStart = () => {
      const deck = makeDeck();
      const player = [deck.pop()!,deck.pop()!];
      const dealer = [deck.pop()!,deck.pop()!];
      setBjDeck(deck); setBjPlayer(player); setBjDealer(dealer); setBjPhase("playing"); setBjResult("");
      if (handVal(player)===21) { bjSettle([...player],[...dealer],deck,true); }
    };
    const bjHit = () => {
      const d=[...bjDeck]; const card=d.pop()!; const p=[...bjPlayer,card];
      setBjDeck(d); setBjPlayer(p);
      if(handVal(p)>21){setBjPhase("done");setBjResult("💀 Bust! You lose.");doCasinoLoss();}
    };
    const bjStand = () => {
      let d=[...bjDeck]; let dealer=[...bjDealer];
      while(handVal(dealer)<17){dealer.push(d.pop()!);};
      setBjDealer(dealer);setBjDeck(d);
      bjSettle(bjPlayer,dealer,d,false);
    };
    const bjSettle=(p:number[],deal:number[],d:number[],isNat:boolean)=>{
      const pv=handVal(p),dv=handVal(deal);
      if(isNat){const w=doCasinoWin(1.5);setBjResult(`🃏 Blackjack! +₦${w.toLocaleString()}`);setBjPhase("done");return;}
      if(dv>21||pv>dv){const w=doCasinoWin(1);setBjResult(`✅ You win! +₦${w.toLocaleString()}`);setBjPhase("done");}
      else if(pv===dv){setWalletBalance(b=>b);setBjResult("🤝 Push — bet returned.");setBjPhase("done");}
      else{doCasinoLoss();setBjResult(`💀 Dealer wins (${dv} vs ${pv}). You lose.`);setBjPhase("done");}
    };

    // ROULETTE
    const rlSpin = () => {
      if(rlSpinning) return;
      doCasinoLoss(); setRlSpinning(true); setRlResult(null);
      setTimeout(()=>{
        const num = Math.floor(Math.random()*37);
        setRlResult(num); setRlSpinning(false);
        const isRed=RL_RED.includes(num);
        const isOdd=num>0&&num%2!==0;
        let win=false,mult=0;
        // Bet is pre-deducted via doCasinoLoss(), so multipliers must return bet + profit:
        // even-money bets → mult=2 (get bet back + equal profit), number → mult=36 (35:1 payout + bet)
        if(rlBetType==="number"&&rlNumber===num){win=true;mult=36;}
        else if(rlBetType==="red"&&isRed){win=true;mult=2;}
        else if(rlBetType==="black"&&!isRed&&num>0){win=true;mult=2;}
        else if(rlBetType==="odd"&&isOdd){win=true;mult=2;}
        else if(rlBetType==="even"&&!isOdd&&num>0){win=true;mult=2;}
        if(win){const w=doCasinoWin(mult);toast(`🎰 ${num}! You win ₦${w.toLocaleString()}!`);}
        else{toast(`🎰 ${num}. Better luck next time.`);}
      },2000);
    };

    // SLOTS
    const slotsPin = () => {
      if(slotsSpinning) return;
      doCasinoLoss(); setSlotsSpinning(true); setSlotsResult("");
      const spin=()=>Array.from({length:3},()=>SLOT_SYMBOLS[Math.floor(Math.random()*SLOT_SYMBOLS.length)]);
      let ticks=0;
      const iv=setInterval(()=>{
        setSlotsReels(spin());
        ticks++;
        if(ticks>15){
          clearInterval(iv);
          const final=spin();
          setSlotsReels(final);
          setSlotsSpinning(false);
          if(final[0]===final[1]&&final[1]===final[2]){
            const mult=final[0]==="👑"?10:final[0]==="💎"?7:5;
            const w=doCasinoWin(mult);
            setSlotsResult(`🎉 JACKPOT! ${final[0]}${final[0]}${final[0]} × ${mult} — +₦${w.toLocaleString()}`);
          } else if(final[0]===final[1]||final[1]===final[2]||final[0]===final[2]){
            const w=doCasinoWin(1.5);setSlotsResult(`✅ Two of a kind! +₦${w.toLocaleString()}`);
          } else{setSlotsResult("💀 No match. Lost.");}
        }
      },80);
    };

    const betBtns=[100,500,1000,5000,10000];

    // ── FORBIDDEN VELVET HALL DARK THEME ──
    const C = {
      bg:     "#070005",          // near-black with purple tint
      surface:"#0f0008",          // slightly lighter cards
      border: "#3a0022",          // deep crimson border
      gold:   "#c9933a",          // tarnished gold accents
      blood:  "#8b0000",          // blood red
      blaze:  "#cc2244",          // bright crimson
      rose:   "#ff6699",          // rose highlight
      dim:    "#553344",          // muted text
      ink:    "#ccaab0",          // parchment text
      glow:   "rgba(139,0,0,0.25)",
    };
    const cHdr: React.CSSProperties = {
      background: `linear-gradient(180deg, ${C.bg} 0%, #100008 100%)`,
      borderBottom: `1px solid ${C.border}`,
      padding: "12px 16px 10px",
      position: "sticky" as const, top: 0, zIndex: 10,
    };
    const cCard = (extra?: React.CSSProperties): React.CSSProperties => ({
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: 14, marginBottom: 12,
      boxShadow: `0 0 20px ${C.glow}`, ...extra,
    });
    const cBtn = (active: boolean, danger?: boolean): React.CSSProperties => ({
      padding: "9px 14px", borderRadius: 5, cursor: "pointer", border: "none",
      background: active ? (danger ? C.blood : "#3a0022") : C.bg,
      color: active ? C.rose : C.dim,
      fontFamily: "'Cinzel',serif", fontSize: 11,
      letterSpacing: "0.08em", transition: "all 0.2s",
      boxShadow: active ? `0 0 12px ${C.glow}` : "none",
    });
    const cLabel: React.CSSProperties = {
      fontFamily: "'Cinzel',serif", fontSize: 9, color: C.dim,
      letterSpacing: "0.14em", textTransform: "uppercase" as const, marginBottom: 4,
    };
    const cVal = (accent?: string): React.CSSProperties => ({
      fontFamily: "'Cinzel',serif", fontSize: 22, fontWeight: 700,
      color: accent || C.gold,
    });
    const cInput: React.CSSProperties = {
      background: C.bg, border: `1px solid ${C.border}`,
      borderRadius: 5, color: C.ink, fontFamily: "'Cinzel',serif",
      fontSize: 13, padding: "9px 12px", width: "100%", boxSizing: "border-box" as const,
    };
    const gameBtn=(id:"blackjack"|"roulette"|"slots",label:string)=>(
      <button key={id} type="button" className="b" onClick={()=>setCasinoGame(id)}
        style={{...cBtn(casinoGame===id),flex:1,fontSize:11}}>
        {label}
      </button>
    );

    return (
      <div style={{paddingBottom:90, background: C.bg, minHeight:"100vh"}}>
        <div style={cHdr}>
          <div style={{maxWidth:600,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:15,color:C.gold,letterSpacing:"0.15em",fontWeight:700}}>
              🕯️ THE VELVET HALL
            </span>
            <span style={{fontFamily:"'IM Fell English',serif",fontSize:10,color:C.dim,fontStyle:"italic"}}>
              Noctis Underground · Est. 1887
            </span>
          </div>
        </div>
        <div style={{maxWidth:600,margin:"0 auto",padding:"14px 14px 0"}}>
          <div style={{...cCard(),textAlign:"center",padding:16,
            background:`linear-gradient(135deg, #100008, #1a000e)`,
            border:`1px solid ${C.blood}66`}}>
            <p style={cLabel}>YOUR PURSE</p>
            <p style={cVal()}>{`₦${walletBalance.toLocaleString()}`}</p>
            <p style={{fontSize:10,color:C.dim,marginTop:6,fontFamily:"'IM Fell English',serif"}}>
              {casinoWins} victories · {casinoLosses} defeats
              {casinoLosses > casinoWins ? " · The house remembers." : " · Fortune favours the bold."}
            </p>
          </div>

          <div style={{display:"flex",gap:6,marginBottom:14,
            background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:4}}>
            {gameBtn("blackjack","🃏 BLACKJACK")}
            {gameBtn("roulette","🌹 ROULETTE")}
            {gameBtn("slots","💀 SLOTS")}
          </div>

          <div style={cCard({padding:12})}>
            <p style={cLabel}>WAGER SELECTION</p>
            <div style={{display:"flex",gap:5,flexWrap:"wrap" as const,marginBottom:8}}>
              {betBtns.map(b2=>(
                <button key={b2} type="button" className="b" onClick={()=>setCasinoBet(b2)}
                  style={{
                    ...cBtn(casinoBet===b2),
                    padding:"7px 10px",fontSize:11,flex:1,minWidth:56,
                    border:`1px solid ${casinoBet===b2?C.blood:C.border}`,
                  }}>
                  ₦{b2>=1000?`${b2/1000}K`:b2}
                </button>
              ))}
            </div>
            <p style={{fontSize:10,color:C.dim,fontFamily:"'IM Fell English',serif",fontStyle:"italic"}}>
              Current wager: <span style={{color:C.gold}}>₦{casinoBet.toLocaleString()}</span>
            </p>
          </div>

          {/* BLACKJACK */}
          {casinoGame==="blackjack"&&(
            <div style={cCard()}>
              <p style={{fontFamily:"'Cinzel',serif",fontSize:12,color:C.gold,letterSpacing:"0.1em",marginBottom:12}}>🃏 BLACKJACK — 21</p>
              {bjPhase==="idle"&&(
                <div style={{textAlign:"center",padding:"24px 0"}}>
                  <p style={{color:C.ink,marginBottom:20,fontFamily:"'IM Fell English',serif",fontStyle:"italic",fontSize:13,lineHeight:1.7}}>
                    The cards know all. Reach 21 and take the house's gold, or fall to ruin beneath their weight.
                  </p>
                  <button type="button" className="b" onClick={bjStart}
                    style={{
                      background:`linear-gradient(135deg, ${C.blood}, #5a0000)`,
                      color:C.rose, border:"none", borderRadius:6,
                      padding:"13px 36px", fontFamily:"'Cinzel',serif", fontSize:13,
                      letterSpacing:"0.12em", cursor:"pointer",
                      boxShadow:`0 0 20px ${C.glow}`,
                    }}>
                    DEAL THE CARDS — ₦{casinoBet.toLocaleString()}
                  </button>
                </div>
              )}
              {bjPhase!=="idle"&&(
                <div>
                  <div style={{marginBottom:14}}>
                    <p style={{...cLabel,marginBottom:8}}>DEALER {bjPhase==="playing"?"— CARD HIDDEN":""}</p>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap" as const,alignItems:"center"}}>
                      {bjDealer.map((c,i)=>(
                        <div key={i} style={{
                          width:40,height:58,borderRadius:6,
                          background: bjPhase==="playing"&&i===1
                            ? `linear-gradient(135deg, #1a0010, #0a0005)`
                            : `linear-gradient(135deg, #f5e8d8, #ede0ca)`,
                          border:`2px solid ${bjPhase==="playing"&&i===1?C.border:"#8b6347"}`,
                          display:"flex",alignItems:"center",justifyContent:"center",
                          fontSize:15,fontWeight:700,
                          color:bjPhase==="playing"&&i===1?"#1a0010":"#2a1a0a",
                          boxShadow:`0 2px 8px rgba(0,0,0,0.5)`,
                        }}>
                          {bjPhase==="playing"&&i===1?"🂠":cardName(c)}
                        </div>
                      ))}
                      {bjPhase!=="playing"&&<span style={{marginLeft:8,fontFamily:"'Cinzel',serif",fontSize:14,color:C.rose}}>{handVal(bjDealer)}</span>}
                    </div>
                  </div>
                  <div style={{marginBottom:14}}>
                    <p style={{...cLabel,marginBottom:8}}>YOUR HAND — {handVal(bjPlayer)}</p>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap" as const}}>
                      {bjPlayer.map((c,i)=>(
                        <div key={i} style={{
                          width:40,height:58,borderRadius:6,
                          background:`linear-gradient(135deg, #f5e8d8, #ede0ca)`,
                          border:`2px solid #8b6347`,
                          display:"flex",alignItems:"center",justifyContent:"center",
                          fontSize:15,fontWeight:700,color:"#2a1a0a",
                          boxShadow:`0 2px 8px rgba(0,0,0,0.5)`,
                        }}>
                          {cardName(c)}
                        </div>
                      ))}
                    </div>
                  </div>
                  {bjPhase==="playing"&&(
                    <div style={{display:"flex",gap:8}}>
                      <button type="button" className="b" onClick={bjHit}
                        style={{...cBtn(true),flex:1,padding:"11px",border:`1px solid ${C.blood}`,fontSize:12,letterSpacing:"0.1em"}}>HIT</button>
                      <button type="button" className="b" onClick={bjStand}
                        style={{...cBtn(false),flex:1,padding:"11px",border:`1px solid ${C.border}`,fontSize:12,letterSpacing:"0.1em"}}>STAND</button>
                    </div>
                  )}
                  {bjPhase==="done"&&(
                    <div style={{textAlign:"center",marginTop:14,padding:"12px",background:"#0a0005",borderRadius:6,border:`1px solid ${C.border}`}}>
                      <p style={{fontFamily:"'Cinzel',serif",fontSize:13,color:C.gold,fontWeight:700,marginBottom:14,letterSpacing:"0.05em"}}>{bjResult}</p>
                      <button type="button" className="b" onClick={()=>{setBjPhase("idle");setBjResult("");}}
                        style={{background:`linear-gradient(135deg,${C.blood},#5a0000)`,color:C.rose,border:"none",borderRadius:6,padding:"10px 26px",fontFamily:"'Cinzel',serif",fontSize:11,letterSpacing:"0.1em",cursor:"pointer"}}>
                        DEAL AGAIN
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ROULETTE */}
          {casinoGame==="roulette"&&(
            <div style={cCard()}>
              <p style={{fontFamily:"'Cinzel',serif",fontSize:12,color:C.gold,letterSpacing:"0.1em",marginBottom:12}}>🌹 THE WHEEL OF FATE</p>
              <div style={{marginBottom:12}}>
                <p style={{...cLabel,marginBottom:8}}>SELECT YOUR OMEN</p>
                <div style={{display:"flex",gap:5,flexWrap:"wrap" as const,marginBottom:8}}>
                  {(["red","black","odd","even"] as const).map(t=>(
                    <button key={t} type="button" className="b" onClick={()=>setRlBetType(t)}
                      style={{
                        ...cBtn(rlBetType===t),
                        padding:"7px 10px",fontSize:10,flex:1,
                        border:`1px solid ${rlBetType===t?(t==="red"?C.blaze:C.border):C.border}`,
                        background:rlBetType===t?(t==="red"?"#5a0000":t==="black"?"#0a0005":"#3a0022"):C.bg,
                      }}>
                      {t==="red"?"🔴 BLOOD":t==="black"?"⚫ SHADOW":t==="odd"?"ODD":"EVEN"}
                    </button>
                  ))}
                  <button type="button" className="b" onClick={()=>setRlBetType("number")}
                    style={{...cBtn(rlBetType==="number"),padding:"7px 10px",fontSize:10,flex:1,border:`1px solid ${C.border}`}}>
                    📿 NUMBER (36×)
                  </button>
                </div>
                {rlBetType==="number"&&(
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{color:C.dim,fontSize:11,fontFamily:"'Cinzel',serif"}}>0–36:</span>
                    <input type="number" min={0} max={36} value={rlNumber}
                      onChange={e=>setRlNumber(Math.max(0,Math.min(36,parseInt(e.target.value)||0)))}
                      style={{...cInput,width:70,textAlign:"center" as const}}/>
                  </div>
                )}
              </div>
              <div style={{textAlign:"center",padding:"8px 0"}}>
                {(()=>{
                  const RL_ORDER=[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
                  const RED_SET=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
                  const N=37, cx=130, cy=130, R=118, ir=44, deg=360/N;
                  const toR=(d:number)=>d*Math.PI/180;
                  const winIdx=rlResult!==null?RL_ORDER.indexOf(rlResult):-1;
                  const stopRot=winIdx>=0?-(winIdx*deg+deg/2):0;
                  return (
                    <div style={{position:"relative",width:260,margin:"0 auto 8px"}}>
                      <svg viewBox="0 0 260 260" width="240" height="240" style={{display:"block",margin:"0 auto",filter:"drop-shadow(0 8px 28px rgba(0,0,0,.9))"}}>
                        <circle cx={cx} cy={cy} r={R+10} fill="#12100a" stroke="#d4af37" strokeWidth="3.5"/>
                        <circle cx={cx} cy={cy} r={R+4} fill="none" stroke="rgba(212,175,55,0.25)" strokeWidth="1"/>
                        <g style={{transformOrigin:`${cx}px ${cy}px`,animation:rlSpinning?"spinWheel 0.22s linear infinite":"none",transform:!rlSpinning&&rlResult!==null?`rotate(${stopRot}deg)`:"none",transition:!rlSpinning&&rlResult!==null?"transform 3.2s cubic-bezier(0.1,0.9,0.25,1)":"none"} as any}>
                          {RL_ORDER.map((num,i)=>{
                            const s=i*deg-90,e=(i+1)*deg-90;
                            const sR=toR(s),eR=toR(e);
                            const x1=cx+R*Math.cos(sR),y1=cy+R*Math.sin(sR);
                            const x2=cx+R*Math.cos(eR),y2=cy+R*Math.sin(eR);
                            const ix1=cx+ir*Math.cos(sR),iy1=cy+ir*Math.sin(sR);
                            const ix2=cx+ir*Math.cos(eR),iy2=cy+ir*Math.sin(eR);
                            const col=num===0?"#0d5c2a":RED_SET.has(num)?"#6b0f0f":"#0f0f0f";
                            const mR=toR(s+deg/2),tr=(R+ir)/2+2;
                            const tx=cx+tr*Math.cos(mR),ty=cy+tr*Math.sin(mR);
                            return (
                              <g key={num}>
                                <path d={`M${ix1} ${iy1}L${x1} ${y1}A${R} ${R} 0 0 1 ${x2} ${y2}L${ix2} ${iy2}A${ir} ${ir} 0 0 0 ${ix1} ${iy1}`} fill={col} stroke="#c9a227" strokeWidth="0.6"/>
                                <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle" fontSize="6.5" fill="rgba(255,255,255,0.9)" fontWeight="bold" transform={`rotate(${s+deg/2+90},${tx},${ty})`}>{num}</text>
                              </g>
                            );
                          })}
                          <circle cx={cx} cy={cy} r={ir-1} fill="#0a0800" stroke="#c9a227" strokeWidth="1.5"/>
                          <circle cx={cx} cy={cy} r={ir-9} fill="#0a0800" stroke="rgba(212,175,55,0.3)" strokeWidth="1"/>
                          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize="18" fill="#d4af37">♠</text>
                        </g>
                        {!rlSpinning&&rlResult!==null&&(
                          <circle cx={cx} cy={cy-R+14} r="7" fill="ivory" stroke="#d4af37" strokeWidth="1.5" style={{filter:"drop-shadow(0 2px 6px rgba(0,0,0,.8))"} as any}/>
                        )}
                        <polygon points={`${cx},${cy-R-4} ${cx-7},${cy-R+10} ${cx+7},${cy-R+10}`} fill="#d4af37"/>
                      </svg>
                      {rlResult!==null&&!rlSpinning&&(
                        <div style={{textAlign:"center",marginTop:4,marginBottom:4}}>
                          <span style={{display:"inline-block",padding:"5px 20px",borderRadius:20,background:rlResult===0?"#0d5c2a":RED_SET.has(rlResult)?"#6b0f0f":"#111",border:`2px solid ${rlResult===0?"#2aaa5a":RED_SET.has(rlResult)?"#cc3333":"#444"}`,fontSize:18,fontWeight:700,color:"#fff"}}>
                            {rlResult} {rlResult===0?"🟢":RED_SET.has(rlResult)?"🔴":"⚫"}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {rlSpinning&&<p style={{color:C.dim,fontFamily:"'IM Fell English',serif",fontStyle:"italic",marginBottom:10}}>The wheel turns... fate approaches...</p>}
                <button type="button" className="b" onClick={rlSpin} disabled={rlSpinning}
                  style={{
                    background:rlSpinning?C.surface:`linear-gradient(135deg,${C.blood},#5a0000)`,
                    color:rlSpinning?C.dim:C.rose, border:"none", borderRadius:6,
                    padding:"12px 30px", fontFamily:"'Cinzel',serif", fontSize:12,
                    letterSpacing:"0.12em", cursor:rlSpinning?"not-allowed":"pointer",
                    opacity:rlSpinning?0.6:1, boxShadow:rlSpinning?"none":`0 0 20px ${C.glow}`,
                  }}>
                  {rlSpinning?"THE WHEEL TURNS…":"CAST YOUR FATE — ₦"+casinoBet.toLocaleString()}
                </button>
              </div>
            </div>
          )}

          {/* SLOTS */}
          {casinoGame==="slots"&&(
            <div style={cCard()}>
              <p style={{fontFamily:"'Cinzel',serif",fontSize:12,color:C.gold,letterSpacing:"0.1em",marginBottom:12}}>💀 THE MACHINE OF FATE</p>
              <div style={{textAlign:"center",padding:"8px 0"}}>
                {/* Slot machine SVG frame */}
                <div style={{position:"relative",width:260,margin:"0 auto 12px",display:"inline-block"}}>
                  <svg viewBox="0 0 260 220" width="260" height="220" style={{display:"block",filter:"drop-shadow(0 8px 24px rgba(0,0,0,.9))"}}>
                    {/* Machine body */}
                    <rect x="8" y="10" width="244" height="200" rx="14" fill="#1a0a00" stroke="#d4af37" strokeWidth="2.5"/>
                    <rect x="8" y="10" width="244" height="200" rx="14" fill="url(#slotGrad)"/>
                    <defs>
                      <linearGradient id="slotGrad" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="rgba(212,175,55,0.08)"/>
                        <stop offset="100%" stopColor="rgba(0,0,0,0)"/>
                      </linearGradient>
                    </defs>
                    {/* Top banner */}
                    <rect x="8" y="10" width="244" height="44" rx="14" fill="#2a0a00"/>
                    <rect x="8" y="38" width="244" height="16" fill="#2a0a00"/>
                    <text x="130" y="37" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#d4af37" fontFamily="Georgia,serif" letterSpacing="3">♠ NOCTIS ♠</text>
                    <text x="130" y="50" textAnchor="middle" fontSize="8" fill="#8b7355" fontFamily="Georgia,serif" letterSpacing="4">FORTUNE MACHINE</text>
                    {/* Reel window outer frame */}
                    <rect x="22" y="60" width="216" height="106" rx="8" fill="#0a0500" stroke="#8b7355" strokeWidth="1.5"/>
                    {/* Reel dividers */}
                    <line x1="94" y1="60" x2="94" y2="166" stroke="#5a4a2a" strokeWidth="1.5"/>
                    <line x1="166" y1="60" x2="166" y2="166" stroke="#5a4a2a" strokeWidth="1.5"/>
                    {/* Payout line */}
                    <line x1="22" y1="113" x2="238" y2="113" stroke="#d4af37" strokeWidth="1.5" strokeDasharray="5,3" opacity="0.7"/>
                    {/* Left arrow indicator */}
                    <polygon points="28,113 36,108 36,118" fill="#d4af37" opacity="0.8"/>
                    {/* Right arrow indicator */}
                    <polygon points="232,113 224,108 224,118" fill="#d4af37" opacity="0.8"/>
                    {/* Decorative bolt corners */}
                    <circle cx="26" cy="68" r="4" fill="#5a4a1a" stroke="#8b7355" strokeWidth="1"/>
                    <circle cx="234" cy="68" r="4" fill="#5a4a1a" stroke="#8b7355" strokeWidth="1"/>
                    <circle cx="26" cy="158" r="4" fill="#5a4a1a" stroke="#8b7355" strokeWidth="1"/>
                    <circle cx="234" cy="158" r="4" fill="#5a4a1a" stroke="#8b7355" strokeWidth="1"/>
                    {/* Bottom panel */}
                    <rect x="22" y="175" width="216" height="28" rx="6" fill="#0f0a00" stroke="#3a2a0a" strokeWidth="1"/>
                    {/* Coin slot */}
                    <rect x="105" y="187" width="50" height="7" rx="3.5" fill="#050300" stroke="#5a4a2a" strokeWidth="1"/>
                    <text x="130" y="194" textAnchor="middle" fontSize="6" fill="#5a4a2a" fontFamily="Georgia,serif" letterSpacing="1">INSERT COIN</text>
                    {/* Credit display */}
                    <rect x="170" y="178" width="60" height="22" rx="4" fill="#050300" stroke="#5a4a2a" strokeWidth="1"/>
                    <text x="200" y="193" textAnchor="middle" fontSize="9" fill="#d4af37" fontFamily="monospace">₦{casinoBet.toLocaleString()}</text>
                  </svg>
                  {/* Animated reels - absolutely positioned over SVG window */}
                  <div style={{position:"absolute",top:60,left:22,width:216,height:106,display:"flex",borderRadius:8,overflow:"hidden"}}>
                    {slotsReels.map((s,i)=>(
                      <div key={i} style={{flex:1,height:"100%",display:"flex",flexDirection:"column" as const,alignItems:"center",justifyContent:"center",gap:0,
                        borderRight:i<2?"1.5px solid #5a4a2a":"none",
                        background:"#060300",
                        overflow:"hidden"}}>
                        <div style={{fontSize:20,opacity:0.35,marginBottom:2,filter:slotsSpinning?"blur(2px)":"none",transform:"translateY(-4px)"}}>{SLOT_SYMBOLS[(SLOT_SYMBOLS.indexOf(s)+1)%SLOT_SYMBOLS.length]}</div>
                        <div style={{fontSize:36,lineHeight:1,animation:slotsSpinning?`reelBlur ${0.12+i*0.04}s ease-in-out infinite`:"none"}}>{s}</div>
                        <div style={{fontSize:20,opacity:0.35,marginTop:2,filter:slotsSpinning?"blur(2px)":"none",transform:"translateY(4px)"}}>{SLOT_SYMBOLS[(SLOT_SYMBOLS.indexOf(s)+SLOT_SYMBOLS.length-1)%SLOT_SYMBOLS.length]}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {slotsResult&&<p style={{fontSize:13,color:C.gold,fontFamily:"'Cinzel',serif",fontWeight:700,marginBottom:10,letterSpacing:"0.05em"}}>{slotsResult}</p>}
                <p style={{fontSize:10,color:C.dim,fontFamily:"'IM Fell English',serif",marginBottom:12}}>
                  👑×3 = 10× · 💎×3 = 7× · Three alike = 5× · Two alike = 1.5×
                </p>
                <button type="button" className="b" onClick={slotsPin} disabled={slotsSpinning}
                  style={{
                    background:slotsSpinning?C.surface:`linear-gradient(135deg,${C.blood},#5a0000)`,
                    color:slotsSpinning?C.dim:C.rose, border:"none", borderRadius:6,
                    padding:"12px 30px", fontFamily:"'Cinzel',serif", fontSize:12,
                    letterSpacing:"0.12em", cursor:slotsSpinning?"not-allowed":"pointer",
                    opacity:slotsSpinning?0.6:1, boxShadow:slotsSpinning?"none":`0 0 20px ${C.glow}`,
                  }}>
                  {slotsSpinning?"THE REELS TURN…":"💀 INVOKE THE MACHINE — ₦"+casinoBet.toLocaleString()}
                </button>
              </div>
            </div>
          )}

          <div style={{...cCard({marginTop:8,textAlign:"center",padding:12})}}>
            <p style={{fontSize:11,color:C.dim,fontFamily:"'IM Fell English',serif",fontStyle:"italic",lineHeight:1.7}}>
              The house remembers every wager. Debt calls to those who lose themselves in the Velvet Hall.
              <br/><span style={{color:C.blood,fontSize:10}}>Enter only what you can afford to lose.</span>
            </p>
          </div>
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // FORUM
  // ═══════════════════════════════════════════════════════
  const Forum = () => {
    const activeThread = forumView ? forumPosts.find((fp: any) => fp.id === forumView) : null;

    const STUDENTS_LIST = Object.entries(ACCTS).map(([id,u]:any)=>({ id, un: u.un||u.name||String(id) }));
      const allStudentNames = STUDENTS_LIST.map((s:any)=>s.un);

      // AI-draft gossip about target using professor DM endpoint as a generic AI call
      const aiDraftGossip = async () => {
        if (!gossipTarget.trim()) { toast("Pick a target first."); return; }
        setGossipDrafting(true);
        try {
          const res = await fetch("/api/ai/prof-dm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              profName: "Anonymous Source",
              archetype: "clinical",
              personality: "A shadow account at Noctis University. You write devastating, specific, plausible gossip about real students. 2-3 sentences. First person is fine. No quotation marks. No labels. No 'I heard that'. Just the gossip itself, stated as fact.",
              dms: [],
              studentName: (user as any)?.un || "Student",
              studentTier: (user as any)?.tier || "merit",
              studentCov: (user as any)?.cov || "unknown",
              favScore: 0,
              history: [],
              message: `Write a short piece of campus gossip specifically targeting ${gossipTarget} at Noctis University. Make it feel lived-in, specific, and socially damaging — but completely plausible. It should damage their standing. 2-3 sentences maximum. No quotation marks.`,
            }),
          });
          const data = await res.json();
          if (data.reply) setGossipText(data.reply.replace(/^"+|"+$/g,'').trim());
          else setGossipText(`Heard something about ${gossipTarget} last night. Apparently this isn't the first time. The corridors remember.`);
        } catch {
          setGossipText(`${gossipTarget} was seen somewhere they definitely should not have been. Nobody's saying anything — which says everything.`);
        } finally {
          setGossipDrafting(false);
        }
      };

      // Submit gossip → posts to feed + gossip section + damages reputation + triggers NPC bullying
      const submitGossip = async () => {
        if (!gossipTarget.trim() || !gossipText.trim()) { toast("Choose a target and write the gossip."); return; }
        if (!uid) { toast("You must be signed in to spread gossip."); return; }
        setGossipPosting(true);
        try {
          // 1. Post to main social feed
          const postRes = await fetch("/api/posts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: uid,
              username: (user as any)?.un || "Anonymous",
              pic: (user as any)?.pic || "🌑",
              covenant: (user as any)?.cov || "shadows",
              tier: (user as any)?.tier || "merit",
              content: gossipText.trim(),
            }),
          });
          const postData = await postRes.json();
          const newPostId = postData?.id || postData?.post?.id;

          // 2. Add to local gossip feed
          const newG = { id: `g_${Date.now()}`, postId: newPostId || null, text: gossipText.trim(), target: gossipTarget, ts: new Date().toLocaleString(), likes: 0, postedBy: (user as any)?.un, npcComments: [] as any[] };
          const next = [newG, ...gossipPosts].slice(0, 40);
          setGossipPosts(next);
          try { localStorage.setItem("umbra_gossip", JSON.stringify(next)); } catch {}

          // 2b. Also post as a forum thread so everyone can see and NPCs can comment
          const gossipForumId = `fp_gossip_${Date.now()}`;
          const gossipThread = {
            id: gossipForumId,
            uid,
            un: (user as any)?.un || "Anonymous",
            pic: (user as any)?.pic || "🌑",
            cov: (user as any)?.cov || "shadows",
            ts: new Date().toLocaleString(),
            title: `🔥 GOSSIP: ${gossipTarget ? `@${gossipTarget} has been called out` : "Anonymous Tip"}`,
            body: gossipText.trim(),
            comments: [],
            votes: 5,
            isGossip: true,
            target: gossipTarget,
            feedPostId: newPostId,
          };
          const updatedForum = [gossipThread, ...forumPosts];
          setForumPosts(updatedForum);
          saveForumPosts(updatedForum);

          // 3. Damage target's stored influence score
          try {
            const targetEntry = STUDENTS_LIST.find((s:any) => s.un.toLowerCase() === gossipTarget.toLowerCase());
            const targetId = targetEntry?.id || gossipTarget.toLowerCase().replace(/\s+/g, "_");
            const stored = JSON.parse(localStorage.getItem("umbra_influence_all") || "{}");
            stored[targetId] = Math.max(0, (stored[targetId] ?? 200) - 40);
            localStorage.setItem("umbra_influence_all", JSON.stringify(stored));
          } catch {}

          // 4. Reward poster
          addInfluence(25);
          if (!userAchievements.includes("gossip_posted")) unlockAchievement("gossip_posted", "The Informant", { money: 0, influence: 20, xp: 100 });
          toast(`📰 Gossip posted to the feed. +25 influence. Watch what happens to ${gossipTarget}.`);

          // 5. Trigger NPC bullying after a delay — then pull comments back into gossip tab AND forum thread
          const capturedGossipForumId = gossipForumId;
          if (newPostId) {
            const delay = 8000 + Math.random() * 14000;
            const capturedGossipId = newG.id;
            const capturedTarget = gossipTarget;
            const capturedText = gossipText.trim();
            setTimeout(async () => {
              try {
                await fetch("/api/ai/npc-bully", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    postId: newPostId,
                    targetUsername: capturedTarget,
                    gossipText: capturedText,
                    posterUsername: (user as any)?.un || "Anonymous",
                  }),
                });
                // Fetch the updated post with its NPC comments
                const postRes2 = await fetch(`/api/posts`);
                if (postRes2.ok) {
                  const allPosts = await postRes2.json();
                  const feedPost = allPosts.find ? allPosts.find((p: any) => p.id === newPostId) :
                    (allPosts.posts || []).find((p: any) => p.id === newPostId);
                  if (feedPost?.comments?.length > 0) {
                    // Merge NPC comments into gossip tab entry
                    setGossipPosts(prev => prev.map((g: any) =>
                      g.id === capturedGossipId ? { ...g, npcComments: feedPost.comments } : g
                    ));
                    // Also inject NPC comments into the forum thread
                    const forumComments = feedPost.comments.map((c: any, i: number) => ({
                      id: `fc_npc_${Date.now()}_${i}`,
                      uid: c.userId || c._un || `npc_${i}`,
                      un: c._un || c.userId || "Anonymous",
                      t: c.content,
                      ts: "just now",
                      pic: c._pic || "🌑",
                    }));
                    setForumPosts(prev => {
                      const updated = prev.map((fp: any) =>
                        fp.id === capturedGossipForumId
                          ? { ...fp, comments: [...(fp.comments || []), ...forumComments], votes: (fp.votes || 5) + forumComments.length * 2 }
                          : fp
                      );
                      saveForumPosts(updated);
                      return updated;
                    });
                  }
                }
              } catch {}
            }, delay);
          }

          // 6. WORSHIP — if the POSTER has high rep, fans leave admiring comments on their post
          if (newPostId) {
            const posterRep = (() => { try { return JSON.parse(localStorage.getItem("umbra_influence")||"{}")[uid] ?? 0; } catch { return 0; } })();
            if (posterRep >= 2000) {
              const capturedPostId = newPostId;
              const capturedContent = gossipText.trim();
              const capturedAuthor = (user as any)?.un || "Anonymous";
              const capturedRep = posterRep;
              // Trigger worship comments 45–90 seconds after posting (feels organic)
              setTimeout(() => {
                fetch("/api/ai/worship-comments", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ postId: capturedPostId, postContent: capturedContent, postAuthor: capturedAuthor, authorRep: capturedRep }),
                }).catch(() => {});
              }, 45000 + Math.random() * 45000);
            }
          }

          setGossipTarget("");
          setGossipText("");
        } catch {
          toast("Failed to spread gossip. Try again.");
        } finally {
          setGossipPosting(false);
        }
      };
    return (
      <div style={{ paddingBottom: 80 }}>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", gap: 10 }}>
            {(activeThread || forumCompose) && (
              <button type="button" onClick={() => { setForumView(null); setForumCompose(false); setForumTitle(""); setForumBody(""); setForumTxt(""); }}
                style={{ background: "none", border: "none", color: T.muted, fontSize: 18, cursor: "pointer" }}>←</button>
            )}
            <span style={ttl()}>📋 {activeThread ? activeThread.title : forumCompose ? "NEW THREAD" : forumGossipTab==="gossip"?"GOSSIP FEED":"FORUM"}</span>
            {!activeThread && !forumCompose && forumGossipTab==="forum" && (
              <button type="button" className="b" onClick={() => setForumCompose(true)}
                style={{ marginLeft: "auto", ...btn(true), padding: "5px 12px", fontSize: 11 }}>+ POST</button>
            )}
            {!activeThread && !forumCompose && forumGossipTab==="gossip" && gossipLoading && (
              <span style={{ marginLeft: "auto", fontSize: 11, color: T.muted, fontStyle: "italic" }}>✦ generating…</span>
            )}
          </div>
        </div>
        {!activeThread && !forumCompose && (
          <div style={{ maxWidth: 600, margin: "0 auto", padding: "0 14px", display: "flex", gap: 6, marginBottom: 0, borderBottom: `1px solid ${T.border}` }}>
            {(["forum","gossip"] as const).map(tab=>(
              <button key={tab} type="button" className="b" onClick={()=>setForumGossipTab(tab)}
                style={{background:"none",border:"none",padding:"10px 14px",fontSize:12,cursor:"pointer",
                  color:forumGossipTab===tab?T.primary:T.muted,
                  borderBottom:forumGossipTab===tab?`2px solid ${T.primary}`:"2px solid transparent",
                  fontFamily:"'Cinzel',serif",letterSpacing:"0.08em",fontWeight:700}}>
                {tab==="forum"?"📋 FORUM":"📰 GOSSIP"}
              </button>
            ))}
          </div>
        )}
        <div style={{ ...sec, maxWidth: 600, margin: "0 auto" }}>
          {/* GOSSIP TAB */}
          {forumGossipTab==="gossip" && !activeThread && !forumCompose && (
            <div>
              {/* COMPOSE GOSSIP */}
              {uid && (
                <div style={{...card, padding:16, marginBottom:14, border:`1px solid ${T.danger}33`}}>
                  <p style={{...lbl, marginBottom:10, color:T.danger}}>🕯️ SPREAD GOSSIP</p>
                  <p style={{fontSize:11, color:T.muted, marginBottom:10, fontStyle:"italic", lineHeight:1.5}}>Post gossip to the main feed. It will publicly target the subject, damage their reputation, and draw attention from others on campus.</p>

                  {/* Target picker */}
                  <p style={{fontSize:10, color:T.muted, marginBottom:4, letterSpacing:"0.08em"}}>TARGET</p>
                  <input
                    list="gossip-targets"
                    value={gossipTarget}
                    onChange={e => setGossipTarget(e.target.value)}
                    placeholder="Who are you targeting? (type a name)"
                    style={{...inp, marginBottom:10, fontSize:12}}
                  />
                  <datalist id="gossip-targets">
                    {allStudentNames.filter((n:string)=>n!==((user as any)?.un)).map((n:string)=>(
                      <option key={n} value={n} />
                    ))}
                  </datalist>

                  {/* Gossip text */}
                  <p style={{fontSize:10, color:T.muted, marginBottom:4, letterSpacing:"0.08em"}}>WHAT ARE PEOPLE SAYING</p>
                  <textarea
                    value={gossipText}
                    onChange={e => setGossipText(e.target.value)}
                    placeholder="Write the gossip… or let AI draft it for you."
                    rows={3}
                    style={{...inp, resize:"vertical" as const, fontSize:12, fontFamily:"'IM Fell English',serif", marginBottom:10}}
                  />

                  <div style={{display:"flex", gap:8}}>
                    <button type="button" className="b"
                      onClick={aiDraftGossip}
                      disabled={gossipDrafting || !gossipTarget.trim()}
                      style={{...btn(false), flex:1, fontSize:11, opacity:(gossipDrafting||!gossipTarget.trim())?0.5:1}}>
                      {gossipDrafting ? "✦ drafting…" : "✦ AI DRAFT"}
                    </button>
                    <button type="button" className="b"
                      onClick={submitGossip}
                      disabled={gossipPosting || !gossipTarget.trim() || !gossipText.trim()}
                      style={{...btn(true), flex:2, fontSize:12, opacity:(gossipPosting||!gossipTarget.trim()||!gossipText.trim())?0.5:1, background:T.danger, color:"#fff", border:"none"}}>
                      {gossipPosting ? "posting…" : "📰 SPREAD GOSSIP"}
                    </button>
                  </div>
                  <p style={{fontSize:10, color:T.muted, marginTop:8, opacity:0.7}}>Posts to the main feed under your name. NPC accounts may pile on. -40 reputation to target.</p>
                </div>
              )}

              {/* GOSSIP FEED */}
              <p style={{fontSize:11,color:T.muted,marginBottom:10,fontStyle:"italic"}}>Active whispers from across Noctis. Anonymous. Unverified. Absolutely true.</p>
              {gossipLoading&&(
                <div style={{...card,padding:24,textAlign:"center"}}>
                  <p style={{fontSize:24,marginBottom:8,animation:"pulse 1.5s ease-in-out infinite"}}>🕯️</p>
                  <p style={{color:T.muted,fontFamily:"'IM Fell English',serif",fontStyle:"italic"}}>The network whispers... gathering intelligence from the shadows.</p>
                </div>
              )}
              {!gossipLoading&&gossipPosts.length===0&&(
                <div style={{...card,padding:24,textAlign:"center"}}>
                  <p style={{fontSize:24,marginBottom:8}}>🤫</p>
                  <p style={{color:T.muted,fontFamily:"'IM Fell English',serif",fontStyle:"italic"}}>The corridors are quiet. Be the first to break the silence.</p>
                </div>
              )}
              {gossipPosts.map((g:any)=>(
                <div key={g.id} style={{...card,padding:14,marginBottom:10, borderLeft: g.target ? `3px solid ${T.danger}` : `1px solid ${T.border}`}}>
                  {g.target && (
                    <div style={{display:"flex", gap:6, alignItems:"center", marginBottom:6}}>
                      <span style={{...bdg(T.danger), fontSize:10}}>TARGET: {g.target.toUpperCase()}</span>
                      {g.postedBy && <span style={{fontSize:10, color:T.muted}}>by {g.postedBy}</span>}
                    </div>
                  )}
                  <p style={{fontSize:13,color:T.text,fontFamily:"'IM Fell English',serif",lineHeight:1.7,marginBottom:8}}>{g.text}</p>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom: g.npcComments?.length > 0 ? 8 : 0}}>
                    <span style={{fontSize:10,color:T.muted,fontStyle:"italic"}}>{g.target ? "Posted to feed" : "Anonymous source"} · {g.ts}</span>
                    <button type="button" className="b" onClick={()=>{const ng=gossipPosts.map((x:any)=>x.id===g.id?{...x,likes:(x.likes||0)+1}:x);setGossipPosts(ng);try{localStorage.setItem("umbra_gossip",JSON.stringify(ng));}catch{}}}
                      style={{...btn(false),padding:"4px 10px",fontSize:11}}>
                      👀 {g.likes||0}
                    </button>
                  </div>
                  {g.npcComments?.length > 0 && (
                    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 4 }}>
                      <p style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em", marginBottom: 6, fontFamily: "'Cinzel',serif" }}>NPC REACTIONS</p>
                      {g.npcComments.map((c: any, ci: number) => (
                        <div key={ci} style={{ display: "flex", gap: 8, marginBottom: 6, padding: "6px 8px", background: "rgba(255,255,255,0.02)", borderRadius: 6, border: `1px solid ${T.border}` }}>
                          <span style={{ fontSize: 16, flexShrink: 0 }}>{c._pic || "🌑"}</span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 10, color: T.accent, fontFamily: "'Cinzel',serif" }}>{c._un || c.userId || "Unknown"}</span>
                            <p style={{ fontSize: 12, color: T.text, marginTop: 2, fontFamily: "'IM Fell English',serif", lineHeight: 1.5 }}>{c.content}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* FORUM TAB */}
          {(forumGossipTab==="forum" || activeThread || forumCompose) && (
          forumCompose ? (
            <div style={{ ...card, padding: 14 }}>
              <p style={{ ...lbl, marginBottom: 8 }}>NEW DISCUSSION THREAD</p>
              <input value={forumTitle} onChange={e => setForumTitle(e.target.value)} placeholder="Thread title…" style={{ ...inp, marginBottom: 8 }} />
              <textarea value={forumBody} onChange={e => setForumBody(e.target.value)} placeholder="What's on your mind?" rows={5}
                style={{ ...inp, resize: "vertical" as const, fontFamily: "'IM Fell English',serif" }} />
              <button type="button" className="b" onClick={postForum} style={{ ...btn(true), width: "100%", padding: "10px", marginTop: 10 }}>POST THREAD</button>
            </div>
          ) : activeThread ? (
            <div>
              <div style={{ ...card, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 22 }}>{activeThread.pic || "🌑"}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{activeThread.un}</div>
                    <div style={{ fontSize: 11, color: T.muted }}>{activeThread.ts}</div>
                  </div>
                </div>
                <p style={{ fontSize: 15, color: T.text, fontFamily: "'IM Fell English',serif", lineHeight: 1.6, marginBottom: 12 }}>{activeThread.body}</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="b" onClick={() => voteForum(activeThread.id, 1)} style={{ ...btn(false), padding: "5px 12px", fontSize: 12 }}>▲ {activeThread.votes}</button>
                  <button type="button" className="b" onClick={() => voteForum(activeThread.id, -1)} style={{ ...btn(false), padding: "5px 12px", fontSize: 12 }}>▼</button>
                </div>
              </div>
              <p style={{ ...lbl, marginBottom: 8 }}>REPLIES ({activeThread.comments?.length || 0})</p>
              {(activeThread.comments || []).map((c: any) => (
                <div key={c.id} style={{ ...card, padding: "10px 14px", marginBottom: 8, borderLeft: `2px solid ${T.primary}44` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.primary }}>{c.un}</span>
                    <span style={{ fontSize: 11, color: T.muted }}>{c.ts}</span>
                  </div>
                  <p style={{ fontSize: 13, color: T.text, fontFamily: "'IM Fell English',serif", margin: 0 }}>{c.t}</p>
                </div>
              ))}
              {(activeThread.comments || []).length === 0 && (
                <div style={{ textAlign: "center", color: T.muted, padding: "20px 0", fontFamily: "'IM Fell English',serif", fontStyle: "italic" }}>No replies yet.</div>
              )}
              <div style={{ position: "fixed", bottom: 62, left: 0, right: 0, background: T.bg, borderTop: `1px solid ${T.border}`, padding: "10px 14px", display: "flex", gap: 8 }}>
                <input value={forumTxt} onChange={e => setForumTxt(e.target.value)} placeholder="Add a reply…"
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); replyForum(activeThread.id); } }}
                  style={{ ...inp, flex: 1 }} />
                <button type="button" onClick={() => replyForum(activeThread.id)} style={{ background: T.primary, border: "none", color: "#000", fontWeight: 700, borderRadius: 8, padding: "0 14px", height: 36, fontSize: 13, cursor: "pointer", flexShrink: 0 }}>REPLY</button>
              </div>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 11, color: T.muted, marginBottom: 12, fontStyle: "italic" }}>Anonymous-ish discussions. Everything echoes here.</p>
              {forumPosts.sort((a: any, b: any) => b.votes - a.votes).map((fp: any) => (
                <button key={fp.id} type="button" className="b" onClick={() => setForumView(fp.id)}
                  style={{ ...card, width: "100%", textAlign: "left", padding: "14px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4, fontFamily: "'Cinzel',serif" }}>{fp.title}</div>
                      <div style={{ fontSize: 12, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>{fp.body}</div>
                    </div>
                    <div style={{ flexShrink: 0, textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: T.primary }}>▲ {fp.votes}</div>
                      <div style={{ fontSize: 11, color: T.muted }}>{fp.comments?.length || 0} replies</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: T.muted }}>{fp.un} · {fp.ts}</div>
                </button>
              ))}
            </>
          )
          )}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════
  const Settings = () => (
    <div>
      <div style={hdr}>
        <div style={{ maxWidth: 600, margin: "0 auto" }}>
          <span style={ttl()}>⚙️ SETTINGS</span>
        </div>
      </div>
      <div style={sec}>
        {user.isAdmin && (
          <div style={{ ...card, padding: 14, marginBottom: 12, border: "1px solid #cc44ff44" }}>
            <p style={{ ...lbl, color: "#cc44ff", marginBottom: 8 }}>⚡ ADMIN — ADD FUNDS</p>
            <input style={{ ...inp, marginBottom: 6 }} placeholder="Username or user ID" value={adminFundTarget} onChange={e => setAdminFundTarget(e.target.value)} />
            <input type="number" style={{ ...inp, marginBottom: 8 }} placeholder="Amount (₦)" value={adminFundAmt} onChange={e => setAdminFundAmt(e.target.value)} />
            <button type="button" className="b" onClick={adminAddFunds} style={{ ...btn(true), width: "100%", padding: "10px" }}>ADD FUNDS</button>
          </div>
        )}
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <p style={{ ...lbl, marginBottom: 10 }}>INTERFACE THEME</p>
          {user.canTheme ? (
            Object.entries(TH)
              .filter(([k, t]) => !t.locked && (!(t as any).exclusive || (t as any).exclusive === uid))
              .map(([k, t]) => (
                <button
                  key={k}
                  type="button"
                  className="b"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setThemeId(k);
                    saveSession(uid, k);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    background: k === themeId ? `${T.primary}14` : T.tag,
                    border: `1px solid ${k === themeId ? T.primary : T.border}`,
                    borderRadius: 6,
                    marginBottom: 5,
                    color: T.text,
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      background: t.primary,
                      flexShrink: 0,
                    }}
                  />
                  {t.name}
                  {k === themeId && (
                    <span
                      style={{
                        marginLeft: "auto",
                        color: T.primary,
                        fontSize: 11,
                      }}
                    >
                      ✓
                    </span>
                  )}
                </button>
              ))
          ) : (
            <p style={{ fontSize: 13, color: T.danger, fontStyle: "italic" }}>
              🔒 Theme is controlled.
            </p>
          )}
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <p style={{ ...lbl, marginBottom: 6 }}>PROFILE FRAME</p>
          <p style={{ fontSize: 11, color: T.muted, marginBottom: 12 }}>Add an animated ring around your profile picture.</p>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
            {framedAvatar(user.pic, 52, profileFrame)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {FRAMES.map(f => (
              <button
                key={f.id}
                type="button"
                className="b"
                onClick={() => saveFrame(f.id)}
                style={{
                  background: profileFrame === f.id ? `${T.primary}22` : T.tag,
                  border: `1.5px solid ${profileFrame === f.id ? T.primary : T.border}`,
                  borderRadius: 8,
                  padding: "8px 4px 6px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 3,
                  color: T.text,
                  cursor: "pointer",
                }}
              >
                  <div style={{ width: 24, height: 24, borderRadius: "50%", background: f.id === "none" ? "transparent" : `${f.accent}44`, border: `2px solid ${profileFrame === f.id ? T.primary : f.accent}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: f.id === "none" ? 10 : 14 }}>
                  {f.id === "none" ? <span style={{ color: T.muted }}>✕</span> : f.icon}
                </div>
                <span style={{ fontSize: 9, color: profileFrame === f.id ? T.primary : T.muted, fontFamily: "sans-serif", letterSpacing: 0.5 }}>{f.label.toUpperCase()}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <p style={{ ...lbl, margin: 0 }}>ACCOUNT</p>
            {!editProfile && (
              <button type="button" className="b" onClick={() => { setEditUn(user.un || ""); setEditBio(user.bio || ""); setEditHandle((user.handle || "").replace(/^@/, "")); setEditPw(""); setEditProfile(true); }} style={{ ...btn(false), padding: "4px 12px", fontSize: 11 }}>EDIT PROFILE</button>
            )}
          </div>
          {editProfile ? (
            <div>
              <p style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>Changes save to your device and sync to other tabs.</p>
              {[
                { label: "Display Name", val: editUn, set: setEditUn, placeholder: user.un },
                { label: "Handle (no @)", val: editHandle, set: setEditHandle, placeholder: (user.handle || "").replace(/^@/, "") },
                { label: "Bio", val: editBio, set: setEditBio, placeholder: user.bio || "Your bio..." },
                { label: "New Password", val: editPw, set: setEditPw, placeholder: "Leave blank to keep current", type: "password" },
              ].map(({ label, val, set, placeholder, type }) => (
                <div key={label} style={{ marginBottom: 8 }}>
                  <p style={{ fontSize: 11, color: T.muted, marginBottom: 3 }}>{label}</p>
                  <input type={type || "text"} value={val} onChange={e => set(e.target.value)} placeholder={placeholder} style={{ ...inp }} />
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="b" onClick={saveProfile} disabled={editSaving} style={{ ...btn(true), flex: 1, padding: "9px" }}>{editSaving ? "SAVING…" : "SAVE"}</button>
                <button type="button" className="b" onClick={() => setEditProfile(false)} style={{ ...btn(false), flex: 1, padding: "9px" }}>CANCEL</button>
              </div>
            </div>
          ) : (
            <>
              {[
                ["Username", user.un],
                ["Handle", user.handle],
                ["Tier", user.tier?.toUpperCase()],
                ["Covenant", COV[user.cov]?.name || "None"],
                ["Wealth", user.wealth || "—"],
              ].map(([l, v]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 12, color: T.muted }}>{l}</span>
                  <span style={{ fontSize: 13, color: T.text }}>{v}</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 10 }}>
          <p style={{ ...lbl, marginBottom: 10 }}>YOUR ACCESS</p>
          {[
            [
              "Acquisition Portal",
              isApex ? "Full" : isAsc ? "Preview Only" : "No Access",
            ],
            ["Relief Registry", isApex ? "Full" : "No Access"],
            ["Prof. Confidential Notes", isApex ? "Visible" : "Hidden"],
            ["Apex-Only Posts", isApex ? "Visible" : "Hidden"],
            ["Post & Interact", user.canPost ? "Yes" : "No"],
          ].map(([l, v]) => (
            <div
              key={l}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "5px 0",
                borderBottom: `1px solid ${T.border}`,
              }}
            >
              <span style={{ fontSize: 12, color: T.muted }}>{l}</span>
              <span
                style={{
                  fontSize: 12,
                  color:
                    v === "Full" || v === "Yes" || v === "Visible"
                      ? T.primary
                      : v.includes("Preview")
                      ? T.accent
                      : T.danger,
                }}
              >
                {v}
              </span>
            </div>
          ))}
        </div>
        {/* ── AI ENGINE ──────────────────────────────────────────── */}
        <div style={{ ...card, padding: 14, marginBottom: 10, borderColor: hasUserAiKey ? T.primary : T.border }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 16 }}>{hasUserAiKey ? "🔑" : "⚡"}</span>
            <p style={{ ...lbl, margin: 0 }}>AI ENGINE</p>
            {hasUserAiKey && <span style={{ marginLeft: "auto", fontSize: 10, color: T.primary, border: `1px solid ${T.primary}`, borderRadius: 10, padding: "2px 8px" }}>ACTIVE</span>}
          </div>
          <p style={{ fontSize: 11, color: T.muted, marginBottom: 10, lineHeight: 1.6 }}>
            {hasUserAiKey
              ? `Using ${(aiModel || "custom").split("/").pop()?.split("-").slice(0,3).join("-") || "your model"} for NPC & professor conversations.`
              : "Add your own API key so NPCs and professors reply using real AI. Works with any OpenAI-compatible provider."}
          </p>
          {/* Provider presets */}
          <p style={{ fontSize: 10, color: T.muted, marginBottom: 6, letterSpacing: "0.08em" }}>QUICK PRESETS</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 10 }}>
            {[
              { name: "Groq (Free)", base: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant", hint: "Fast & free tier" },
              { name: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.1-8b-instruct:free", hint: "100+ models, free tier" },
              { name: "NanoGPT", base: "https://nano-gpt.com/api/v1", model: "gpt-4o-mini", hint: "GPT/Claude/Gemini pay-per-use" },
              { name: "Chutes AI", base: "https://llm.chutes.ai/v1", model: "deepseek-ai/DeepSeek-V3-0324", hint: "DeepSeek & more" },
              { name: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-chat", hint: "Cheap & fast" },
              { name: "Together AI", base: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", hint: "Many open models" },
              { name: "Mistral", base: "https://api.mistral.ai/v1", model: "mistral-small-latest", hint: "Free tier" },
              { name: "Anthropic", base: "https://api.anthropic.com/v1", model: "claude-3-5-haiku-latest", hint: "Claude (native API)" },
              { name: "Gemini", base: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-1.5-flash", hint: "Google (native API)" },
              { name: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4o-mini", hint: "Official OpenAI" },
              { name: "Ollama (local)", base: "http://localhost:11434/v1", model: "llama3.1", hint: "Self-hosted, run locally" },
              { name: "Custom", base: "", model: "", hint: "Any OpenAI-compatible endpoint" },
            ].map(p => (
              <button key={p.name} type="button" className="b" onClick={() => {
                if (p.base) { setAiApiBase(p.base); setAiModel(p.model); setAiTestResult(null); }
              }} style={{ ...card, padding: "8px 10px", textAlign: "left", fontSize: 11, color: aiApiBase === p.base && p.base ? T.primary : T.text, borderColor: aiApiBase === p.base && p.base ? T.primary : T.border }}>
                <div style={{ fontWeight: 700 }}>{p.name}</div>
                <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>{p.hint}</div>
              </button>
            ))}
          </div>
          {[
            { label: "API ENDPOINT", val: aiApiBase, set: setAiApiBase, placeholder: "https://api.groq.com/openai/v1", type: "url" as const },
            { label: "API KEY", val: aiApiKey, set: setAiApiKey, placeholder: "gsk_... / sk-... / sk-ant-...", type: "password" as const },
            { label: "MODEL", val: aiModel, set: setAiModel, placeholder: "llama-3.1-8b-instant", type: "text" as const },
          ].map(({ label, val, set, placeholder, type }) => (
            <div key={label} style={{ marginBottom: 8 }}>
              <p style={{ fontSize: 10, color: T.muted, marginBottom: 3, letterSpacing: "0.08em" }}>{label}</p>
              <input type={type} value={val} onChange={e => { set(e.target.value); setAiTestResult(null); }} placeholder={placeholder}
                style={{ ...inp, fontSize: 12, fontFamily: type === "password" ? "monospace" : undefined }} />
            </div>
          ))}
          {/* Test result display */}
          {aiTestResult && (
            <div style={{
              marginTop: 8, padding: "8px 10px", borderRadius: 6, fontSize: 11, lineHeight: 1.5,
              background: aiTestResult.ok ? "rgba(60,140,60,0.15)" : "rgba(180,40,40,0.15)",
              border: `1px solid ${aiTestResult.ok ? "#3c8c3c" : "#7a2020"}`,
              color: aiTestResult.ok ? "#7ac47a" : "#e87878",
              fontFamily: "monospace", wordBreak: "break-word"
            }}>
              {aiTestResult.ok ? "✅ " : "❌ "}{aiTestResult.msg}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" as const }}>
            <button type="button" className="b" onClick={() => {
              saveAiCreds({ apiBase: aiApiBase.trim(), apiKey: aiApiKey.trim(), model: aiModel.trim() });
              toast("✅ AI key saved — NPCs will now use your engine");
            }} style={{ ...btn(true), flex: "1 1 120px", padding: "10px", fontSize: 11 }}>SAVE AI KEY</button>
            <button type="button" className="b" disabled={aiTesting || !aiApiBase.trim() || !aiApiKey.trim() || !aiModel.trim()} onClick={async () => {
              setAiTesting(true);
              setAiTestResult(null);
              try {
                const result = await testLLMConnection({ apiBase: aiApiBase.trim(), apiKey: aiApiKey.trim(), model: aiModel.trim() });
                if (result.ok) {
                  setAiTestResult({ ok: true, msg: `Connected (${result.provider}). Reply: "${result.reply.slice(0, 80)}"` });
                } else {
                  setAiTestResult({ ok: false, msg: `${result.provider}: ${result.error}` });
                }
              } catch (err: any) {
                setAiTestResult({ ok: false, msg: err?.message || String(err) });
              } finally {
                setAiTesting(false);
              }
            }} style={{ ...btn(false), flex: "1 1 120px", padding: "10px", fontSize: 11, opacity: aiTesting ? 0.6 : 1, cursor: aiTesting ? "wait" : "pointer" }}>{aiTesting ? "TESTING…" : "🧪 TEST CONNECTION"}</button>
            {hasUserAiKey && (
              <button type="button" className="b" onClick={() => {
                setAiApiBase(""); setAiApiKey(""); setAiModel(""); setAiTestResult(null);
                saveAiCreds({ apiBase: "", apiKey: "", model: "" });
                toast("Switched to free AI");
              }} style={{ ...btn(false), padding: "10px 14px", fontSize: 11, borderColor: T.muted, color: T.muted }}>CLEAR</button>
            )}
          </div>
          <p style={{ fontSize: 10, color: T.muted, marginTop: 8, lineHeight: 1.6 }}>
            Key stays on your device only — never sent to UMBRA servers. NPCs, professors, and auto-comments all use this engine.
          </p>
        </div>

        <button
          type="button"
          className="b"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            logout();
          }}
          style={{
            ...btn(false),
            width: "100%",
            padding: "13px",
            color: T.danger,
            border: `1px solid ${T.danger}`,
            marginBottom: 10,
          }}
        >
          LEAVE UMBRA
        </button>
        <p
          style={{
            textAlign: "center",
            fontSize: 10,
            color: T.border,
            letterSpacing: "0.08em",
            marginTop: 8,
          }}
        >
          Noctis University · Est. 1847 · Omertà Protocol Active
        </p>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════
  // WALLET
  // ═══════════════════════════════════════════════════════
  const Wallet = () => {
    const wTab = walletPageTab;
    const setWTab = setWalletPageTab;
    const allTx = purchases.slice().reverse();
    const sends = allTx.filter((p: any) => p.type === "send");
    const received = allTx.filter((p: any) => p.type === "receive");
    const bought = allTx.filter((p: any) => p.type === "purchase" || p.type === "portal" || p.type === "gift" || p.type === "bid_hold");
    return (
      <div>
        <div style={hdr}>
          <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={ttl()}>💎 NOCTIS WALLET</span>
            <div style={{ background: T.card, padding: "5px 14px", borderRadius: 20, border: `1px solid ${T.primary}` }}>
              <span style={{ fontSize: 11, color: T.muted }}>₦</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: T.primary, marginLeft: 3 }}>{walletBalance.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, background: T.bg }}>
          {([["overview","💎 Overview"],["send","📤 Send"],["history","📋 History"]] as [string,string][]).map(([id, label]) => (
            <button key={id} type="button" className="b" onClick={() => setWTab(id as any)} style={{ flex: 1, padding: "12px 0", background: "none", border: "none", borderBottom: wTab === id ? `2px solid ${T.primary}` : "2px solid transparent", color: wTab === id ? T.primary : T.muted, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", fontFamily: "'Cinzel',serif" }}>
              {label}
            </button>
          ))}
        </div>

        <div style={sec}>

          {/* OVERVIEW TAB */}
          {wTab === "overview" && (
            <>
              {/* Balance card */}
              <div style={{ ...card, padding: 20, marginBottom: 14, textAlign: "center", border: `1px solid ${T.primary}44`, background: `linear-gradient(135deg,${T.card},${T.dim})` }}>
                <p style={{ fontSize: 11, color: T.muted, letterSpacing: "0.15em", marginBottom: 8, fontFamily: "'Cinzel',serif" }}>YOUR BALANCE</p>
                <p style={{ fontSize: 36, fontWeight: 700, color: T.primary, fontFamily: "'Cinzel',serif", letterSpacing: "0.05em" }}>₦{walletBalance.toLocaleString()}</p>
                <p style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>Noctis University Currency</p>
              </div>

              {/* Quick stats */}
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                {[
                  { label: "SENT", value: sends.length, icon: "📤" },
                  { label: "RECEIVED", value: received.length, icon: "📥" },
                  { label: "PURCHASES", value: bought.length, icon: "🛍️" },
                ].map(s => (
                  <div key={s.label} style={{ ...card, flex: 1, padding: "10px 8px", textAlign: "center" }}>
                    <p style={{ fontSize: 18, marginBottom: 4 }}>{s.icon}</p>
                    <p style={{ fontSize: 16, fontWeight: 700, color: T.primary }}>{s.value}</p>
                    <p style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em" }}>{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button type="button" className="b" onClick={() => setWTab("send")} style={{ ...btn(true), flex: 1, padding: "12px" }}>📤 SEND MONEY</button>
                <button type="button" className="b" onClick={() => { setSubPage("shop"); go("university"); }} style={{ ...btn(false), flex: 1, padding: "12px", border: `1px solid ${T.primary}` }}>🛍️ MARKET</button>
              </div>

              {/* Recent transactions */}
              {allTx.length > 0 && (
                <div style={{ ...card, padding: 14 }}>
                  <p style={{ ...lbl, marginBottom: 10 }}>RECENT ACTIVITY</p>
                  {allTx.slice(0, 5).map((tx: any, i: number) => {
                    const isSend = tx.type === "send" || (tx.reason && tx.reason.startsWith("Transfer to"));
                    const isCredit = tx.type === "receive" || tx.type === "earn";
                    const amt = tx.amount ?? tx.price ?? 0;
                    const color = isCredit ? "#44cc44" : T.danger;
                    const sign = isCredit ? "+" : "-";
                    return (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: i < 4 ? `1px solid ${T.border}` : "none" }}>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 12, color: T.text, lineHeight: 1.4 }}>{tx.reason || tx.name || "Transaction"}</p>
                          <p style={{ fontSize: 10, color: T.muted }}>{tx.date ? new Date(tx.date).toLocaleDateString() : ""}</p>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 700, color, marginLeft: 10, flexShrink: 0 }}>{sign}₦{amt.toLocaleString()}</span>
                      </div>
                    );
                  })}
                  {allTx.length > 5 && (
                    <button type="button" className="b" onClick={() => setWTab("history")} style={{ ...btn(false), width: "100%", marginTop: 8, fontSize: 11 }}>View All ({allTx.length})</button>
                  )}
                </div>
              )}
              {allTx.length === 0 && (
                <div style={{ ...card, padding: 32, textAlign: "center" }}>
                  <p style={{ fontSize: 32, marginBottom: 8 }}>💎</p>
                  <p style={{ color: T.muted, fontSize: 13 }}>No transactions yet. Attend classes to earn Noctis currency.</p>
                </div>
              )}
            </>
          )}

          {/* SEND TAB */}
          {wTab === "send" && (
            <div style={{ ...card, padding: 18 }}>
              <p style={{ ...lbl, marginBottom: 14 }}>💸 SEND MONEY</p>
              <p style={{ fontSize: 11, color: T.muted, marginBottom: 12 }}>
                Available: <span style={{ color: T.primary, fontWeight: 700 }}>₦{walletBalance.toLocaleString()}</span>
              </p>
              <p style={{ fontSize: 11, color: T.muted, letterSpacing: "0.08em", marginBottom: 4 }}>RECIPIENT</p>
              <div style={{ position: "relative" as const, marginBottom: 12 }}>
                <input
                  style={{ ...inp, width: "100%" }}
                  placeholder="@handle, display name, or user ID"
                  value={walletSendTo}
                  onChange={e => setWalletSendTo(e.target.value)}
                />
                {(() => {
                  const matches = userMentionMatches(walletSendTo);
                  if (!walletSendTo.trim() || matches.length === 0) return null;
                  // Hide dropdown once the user has typed an exact match (so the picker doesn't linger)
                  const exact = matches.find((m: any) =>
                    (m.un || "").toLowerCase() === walletSendTo.toLowerCase() ||
                    (m.handle || "").toLowerCase().replace(/^@/, "") === walletSendTo.toLowerCase().replace(/^@/, "")
                  );
                  if (exact && matches.length === 1) return null;
                  return (
                    <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, marginTop: 4, background: T.card || "#1a1409", border: `1px solid ${T.border || "#362e1e"}`, borderRadius: 6, maxHeight: 240, overflowY: "auto" as const, zIndex: 50 }}>
                      {matches.map((m: any) => (
                        <button key={m.id} type="button" onClick={() => setWalletSendTo(m.un)}
                          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px", background: "none", border: "none", borderBottom: `1px solid ${T.border || "#362e1e"}`, color: T.text, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                          <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>{m.pic || "🌑"}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{m.un}</div>
                            <div style={{ fontSize: 10, color: T.muted, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{m.handle || `@${m.un.toLowerCase().replace(/\s+/g, "_")}`} · {(m.tier || "").toUpperCase() || "MERIT"}{(m._real || m.isReal) ? " · REAL" : ""}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <p style={{ fontSize: 11, color: T.muted, letterSpacing: "0.08em", marginBottom: 4 }}>AMOUNT (₦)</p>
              <input
                type="number"
                style={{ ...inp, marginBottom: 12 }}
                placeholder="Enter amount"
                value={walletSendAmt}
                onChange={e => setWalletSendAmt(e.target.value)}
              />
              <p style={{ fontSize: 11, color: T.muted, letterSpacing: "0.08em", marginBottom: 4 }}>NOTE (optional)</p>
              <input
                style={{ ...inp, marginBottom: 16 }}
                placeholder="What's this for?"
                value={walletSendNote}
                onChange={e => setWalletSendNote(e.target.value)}
              />
              <button type="button" className="b" onClick={walletSend} style={{ ...btn(true), width: "100%", padding: "13px", fontSize: 13 }}>
                💸 SEND ₦{walletSendAmt ? parseInt(walletSendAmt).toLocaleString() : "0"}
              </button>
              <p style={{ fontSize: 10, color: T.muted, textAlign: "center", marginTop: 10 }}>Transfers are immediate and irreversible.</p>
            </div>
          )}

          {/* HISTORY TAB */}
          {wTab === "history" && (
            <div>
              {allTx.length === 0 ? (
                <div style={{ ...card, padding: 32, textAlign: "center" }}>
                  <p style={{ fontSize: 32, marginBottom: 8 }}>📋</p>
                  <p style={{ color: T.muted, fontSize: 13 }}>No transactions recorded yet.</p>
                </div>
              ) : (
                allTx.map((tx: any, i: number) => {
                  const isCredit = tx.type === "receive" || tx.type === "earn";
                  const amt = tx.amount ?? tx.price ?? 0;
                  const color = isCredit ? "#44cc44" : T.danger;
                  const sign = isCredit ? "+" : "-";
                  return (
                    <div key={i} style={{ ...card, padding: 12, marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>{tx.reason || tx.name || "Transaction"}</p>
                          {tx.date && <p style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{new Date(tx.date).toLocaleString()}</p>}
                          {tx.type && <span style={{ fontSize: 9, color: T.border, letterSpacing: "0.1em", textTransform: "uppercase" as any }}>{tx.type}</span>}
                        </div>
                        <span style={{ fontSize: 15, fontWeight: 700, color, marginLeft: 12, flexShrink: 0 }}>{sign}₦{amt.toLocaleString()}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // PET STATUS OVERLAY
  // ═══════════════════════════════════════════════════════
  const PetStatusScreen = () => {
    const myInf = (() => { try { return JSON.parse(localStorage.getItem("umbra_influence")||"{}")[uid] ?? 0; } catch { return 0; } })();
    const isRepPet = myInf < 100;
    const isFinPet = walletBalance < 1000 && walletBalance >= 0;
    const timeLeft = myActiveAuction
      ? Math.max(0, new Date(myActiveAuction.endsAt).getTime() - Date.now())
      : 0;
    const hoursLeft = Math.floor(timeLeft / 3600000);
    const minsLeft = Math.floor((timeLeft % 3600000) / 60000);

    const overlayStyle: React.CSSProperties = {
      position: "fixed", inset: 0, zIndex: 9999,
      background: "linear-gradient(135deg, #0a0006 0%, #1a0010 50%, #0d000a 100%)",
      display: "flex", flexDirection: "column", overflowY: "auto",
    };
    const headStyle: React.CSSProperties = {
      textAlign: "center", padding: "40px 20px 20px",
      borderBottom: "1px solid #8b000044",
    };
    const bodyStyle: React.CSSProperties = { padding: "20px 20px 100px", maxWidth: 500, margin: "0 auto", width: "100%" };
    const redGlow: React.CSSProperties = { color: "#ff1a4a", fontFamily: "'Cinzel',serif", fontWeight: 700 };
    const dimText: React.CSSProperties = { color: "#cc8899", fontSize: 12, fontFamily: "'IM Fell English',serif", lineHeight: 1.7 };
    const statCard: React.CSSProperties = {
      background: "#1a000d", border: "1px solid #8b000066",
      borderRadius: 6, padding: "12px 16px", marginBottom: 10,
    };
    const recBtn = (active: boolean): React.CSSProperties => ({
      width: "100%", padding: "12px 16px", marginBottom: 8,
      background: active ? "#2a0015" : "#150008",
      border: `1px solid ${active ? "#cc0044" : "#44001a"}`,
      color: active ? "#ff6699" : "#883355", borderRadius: 6,
      fontFamily: "'Cinzel',serif", fontSize: 12, cursor: "pointer",
      textAlign: "left", letterSpacing: "0.05em",
    });

    return (
      <div style={overlayStyle}>
        <div style={headStyle}>
          <div style={{ fontSize: 52, marginBottom: 8 }}>🔴</div>
          <p style={{ ...redGlow, fontSize: 18, letterSpacing: "0.15em" }}>INSTITUTIONALLY FLAGGED</p>
          <p style={{ ...dimText, marginTop: 8, fontSize: 13 }}>
            Noctis University Academic Registry has flagged your account for{" "}
            <span style={{ color: "#ff4466" }}>
              {isRepPet && isFinPet ? "financial and social deficiency" : isRepPet ? "social standing deficiency" : "financial deficiency"}
            </span>.
          </p>
        </div>
        <div style={bodyStyle}>
          {/* Status breakdown */}
          <div style={statCard}>
            <p style={{ ...redGlow, fontSize: 11, marginBottom: 10, letterSpacing: "0.1em" }}>CURRENT STATUS</p>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={dimText}>Wallet Balance</span>
              <span style={{ fontFamily: "'Cinzel',serif", fontSize: 12, color: isFinPet ? "#ff4466" : "#44ff88" }}>
                ₦{walletBalance.toLocaleString()} {isFinPet ? "⚠️" : "✓"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={dimText}>Social Influence</span>
              <span style={{ fontFamily: "'Cinzel',serif", fontSize: 12, color: isRepPet ? "#ff4466" : "#44ff88" }}>
                {myInf} pts {isRepPet ? "⚠️" : "✓"}
              </span>
            </div>
          </div>

          {/* Auction status */}
          {myActiveAuction && (
            <div style={{ ...statCard, borderColor: "#cc004488", background: "#200010" }}>
              <p style={{ ...redGlow, fontSize: 11, letterSpacing: "0.1em", marginBottom: 8 }}>⛓️ LIVE AUCTION STATUS</p>
              <p style={dimText}>You have been listed in the Noctis University Auction House. Another student may acquire custodianship of your social status.</p>
              <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between" }}>
                <span style={dimText}>Current Bid:</span>
                <span style={{ fontFamily: "'Cinzel',serif", color: "#ff6699", fontSize: 12 }}>
                  {myActiveAuction.currentBid > 0 ? `₦${myActiveAuction.currentBid.toLocaleString()}` : "No bids yet"}
                </span>
              </div>
              {myActiveAuction.highestBidderName && (
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={dimText}>Leading bidder:</span>
                  <span style={{ fontFamily: "'Cinzel',serif", color: "#cc8899", fontSize: 11 }}>{myActiveAuction.highestBidderName}</span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={dimText}>Time remaining:</span>
                <span style={{ fontFamily: "'Cinzel',serif", color: "#ff4466", fontSize: 12 }}>
                  {hoursLeft}h {minsLeft}m
                </span>
              </div>
            </div>
          )}

          {/* Recovery requirements */}
          <div style={{ ...statCard, background: "#120008", marginTop: 16 }}>
            <p style={{ ...redGlow, fontSize: 11, letterSpacing: "0.1em", marginBottom: 8 }}>REQUIREMENTS TO RECOVER</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <span style={{ color: isFinPet ? "#ff4466" : "#44ff88", fontSize: 14 }}>{isFinPet ? "✗" : "✓"}</span>
              <span style={dimText}>Wallet must reach ₦1,000 (currently ₦{walletBalance.toLocaleString()})</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span style={{ color: isRepPet ? "#ff4466" : "#44ff88", fontSize: 14 }}>{isRepPet ? "✗" : "✓"}</span>
              <span style={dimText}>Influence must reach 100 pts (currently {myInf} pts)</span>
            </div>
          </div>

          <p style={{ ...dimText, textAlign: "center", marginBottom: 14, marginTop: 18, fontSize: 11, color: "#883355" }}>
            RECOVERY PATHS
          </p>

          <button type="button" style={recBtn(true)} onClick={() => { setIsPetStatus(false); setNav("casino"); }}>
            🎰 THE VELVET HALL — Gamble your way back to solvency
            <br /><span style={{ fontSize: 10, opacity: 0.7 }}>High risk · High reward · Instant results</span>
          </button>

          <button type="button" style={recBtn(false)} onClick={() => { setIsPetStatus(false); setNav("feed"); }}>
            📜 THE COMMONS — Post, engage, regain social standing
            <br /><span style={{ fontSize: 10, opacity: 0.7 }}>Earn influence through engagement and visibility</span>
          </button>

          <button type="button" style={recBtn(false)} onClick={() => { setIsPetStatus(false); setNav("university"); }}>
            🏛️ THE HALL OF RECORDS — Submit coursework, earn favour
            <br /><span style={{ fontSize: 10, opacity: 0.7 }}>Academic merit grants influence and stipends</span>
          </button>

          <button type="button" style={recBtn(false)} onClick={() => { setIsPetStatus(false); setNav("auction"); }}>
            ⛓️ VIEW YOUR AUCTION LISTING — See who is bidding on you
            <br /><span style={{ fontSize: 10, opacity: 0.7 }}>If someone wins, your standing transfers to their account</span>
          </button>

          <button type="button" style={{ ...recBtn(false), marginTop: 8, color: "#554433", borderColor: "#33221144" }}
            onClick={() => setIsPetStatus(false)}>
            ← Return without recovering (flagged status persists)
          </button>
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // BANKRUPTCY OVERLAY
  // ═══════════════════════════════════════════════════════
  const BankruptcyScreen = () => {
    const npcWhispers = [
      `"${(user as any)?.un || "They"} finally showed their true hand. I always suspected the money was borrowed confidence."`,
      `"The Noctis markets are merciless. Even the brilliant ones fall when they play above their station."`,
      `"Leveraged too deep in the casino. Shocking — but not, if you knew where to look."`,
      `"The Covenant Emergency Fund exists for a reason. Whether they use it says everything."`,
      `"Saw this coming. You can't run with the Apex crowd on a Merit budget."`,
    ];
    const whisper = npcWhispers[bankruptcyCount % npcWhispers.length];
    const recoveryOptions = [
      {
        key: "loan" as const,
        icon: "🏦",
        label: "Emergency Loan",
        sub: "Noctis Financial Services advances ₦8,000 against your future earnings.",
        detail: "You will owe ₦12,000. The institution does not forget debts.",
        gain: "+₦8,000",
        cost: "₦12,000 debt",
        costColor: "#ff4444",
      },
      {
        key: "reputation" as const,
        icon: "💔",
        label: "Pawn Your Reputation",
        sub: "Sell a portion of your social standing for immediate liquidity.",
        detail: "Receive ₦4,000. Lose 25 Influence. Word will travel.",
        gain: "+₦4,000",
        cost: "−25 Influence",
        costColor: "#ff8800",
      },
      {
        key: "labour" as const,
        icon: "⛏️",
        label: "Desperate Labour",
        sub: "Unreported work through the university's shadow economy.",
        detail: "Receive ₦2,500. The kind of work you do not list on applications.",
        gain: "+₦2,500",
        cost: "Nothing listed",
        costColor: "#888",
      },
      {
        key: "covenant" as const,
        icon: "🕯️",
        label: "Covenant Emergency Relief",
        sub: "Request emergency funds from your covenant's discretionary reserves.",
        detail: "₦1,500 disbursed. The favour is remembered even when unspoken.",
        gain: "+₦1,500",
        cost: "A favour owed",
        costColor: "#888",
      },
    ];
    return (
      <div style={{
        position:"fixed",inset:0,zIndex:99999,
        background:"rgba(0,0,0,0.97)",
        display:"flex",flexDirection:"column" as const,alignItems:"center",justifyContent:"center",
        padding:"20px",overflowY:"auto" as const,
      }}>
        <div style={{maxWidth:480,width:"100%"}}>
          {/* Header */}
          <div style={{textAlign:"center" as const,marginBottom:24}}>
            <div style={{fontSize:64,lineHeight:1,marginBottom:12}}>💀</div>
            <h1 style={{
              fontFamily:"'Cinzel',serif",fontSize:26,
              color:"#cc0000",letterSpacing:6,margin:"0 0 6px",textTransform:"uppercase" as const,
            }}>Financial Ruin</h1>
            <p style={{
              fontFamily:"'Cinzel',serif",fontSize:10,
              color:"#444",letterSpacing:4,margin:0,
            }}>NOCTIS UNIVERSITY — OFFICE OF FINANCIAL DISCIPLINE</p>
          </div>

          {/* Institution notice */}
          <div style={{
            background:"#080808",border:"1px solid #cc0000",
            borderRadius:8,padding:"16px 18px",marginBottom:16,
          }}>
            <p style={{
              fontFamily:"'IM Fell English',serif",color:"#bbb",
              fontSize:13,lineHeight:1.75,margin:0,
            }}>
              Your account balance has reached <strong style={{color:"#cc0000"}}>₦0</strong>.
              The Office of Financial Discipline has been notified. Your covenant record has been flagged.
              Fifty influence points have been deducted. The institution observes your fall with
              clinical interest, as it does all things.
            </p>
          </div>

          {/* Times bankrupt */}
          {bankruptcyCount > 0 && (
            <p style={{
              fontFamily:"'Cinzel',serif",fontSize:10,color:"#333",
              textAlign:"center" as const,letterSpacing:3,marginBottom:16,
            }}>
              FINANCIAL COLLAPSE #{bankruptcyCount} — RECORD UPDATED
            </p>
          )}

          {/* NPC whisper */}
          <div style={{
            background:"#0a0a0a",borderRadius:6,padding:"12px 16px",marginBottom:20,
            borderLeft:"2px solid #333",
          }}>
            <p style={{
              fontFamily:"'IM Fell English',serif",fontStyle:"italic",
              color:"#555",fontSize:12,margin:0,lineHeight:1.6,
            }}>{whisper}</p>
            <p style={{fontSize:10,color:"#333",margin:"6px 0 0",letterSpacing:1}}>— CAMPUS WHISPER NETWORK</p>
          </div>

          {/* Recovery options */}
          <p style={{
            fontFamily:"'Cinzel',serif",fontSize:10,color:"#555",
            letterSpacing:4,marginBottom:12,textAlign:"center" as const,
          }}>CHOOSE YOUR RECOVERY PATH</p>

          {recoveryOptions.map(opt=>(
            <button key={opt.key} type="button" className="b"
              onClick={()=>recoverFromBankruptcy(opt.key)}
              style={{
                display:"block",width:"100%",marginBottom:10,
                background:"#0d0d0d",border:"1px solid #222",borderRadius:8,
                padding:"14px 16px",cursor:"pointer",textAlign:"left" as const,
                color:"#ccc",transition:"border-color 0.2s",
              }}
              onMouseEnter={e=>(e.currentTarget.style.borderColor="#555")}
              onMouseLeave={e=>(e.currentTarget.style.borderColor="#222")}
            >
              <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
                <span style={{fontSize:22,flexShrink:0,marginTop:2}}>{opt.icon}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <p style={{
                      margin:0,fontFamily:"'Cinzel',serif",
                      fontSize:13,color:"#e0e0e0",fontWeight:700,
                    }}>{opt.label}</p>
                    <span style={{
                      fontSize:12,fontWeight:700,color:"#4caf50",flexShrink:0,marginLeft:8,
                    }}>{opt.gain}</span>
                  </div>
                  <p style={{
                    margin:"0 0 4px",fontFamily:"'IM Fell English',serif",
                    fontSize:12,color:"#888",lineHeight:1.5,
                  }}>{opt.sub}</p>
                  <p style={{
                    margin:0,fontSize:10,color:"#555",fontStyle:"italic",
                  }}>{opt.detail}</p>
                </div>
              </div>
              <div style={{
                marginTop:10,paddingTop:8,borderTop:"1px solid #1a1a1a",
                display:"flex",justifyContent:"flex-end",
              }}>
                <span style={{fontSize:10,color:opt.costColor,letterSpacing:1}}>{opt.cost}</span>
              </div>
            </button>
          ))}

          {/* Debt status */}
          {debtOwed > 0 && (
            <div style={{
              marginTop:16,padding:"10px 14px",background:"#0a0005",
              border:"1px solid #440022",borderRadius:6,
            }}>
              <p style={{
                margin:0,fontFamily:"'Cinzel',serif",fontSize:11,
                color:"#880044",letterSpacing:2,
              }}>OUTSTANDING DEBT: ₦{debtOwed.toLocaleString()}</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════
  // ROOT RENDER
  // ═══════════════════════════════════════════════════════
  return (
    <div
      className={themeId === "lolita" ? "lolita-theme" : themeId === "goth_bw" ? "goth-theme" : themeId === "dark_amethyst" ? "amethyst-theme" : themeId === "pastel_rose" ? "pastel-theme" : themeId === "vii_aether" ? "vii-theme" : ""}
      style={{
        minHeight: "100vh",
        background: T.bg,
        color: T.text,
        fontFamily: (T as any).font || "'Cormorant Garamond',Georgia,serif",
        position: "relative",
      }}
      onClick={() => setMenuPost(null)}
    >
      {notif && (
        <div
          className="fi"
          style={{
            position: "fixed",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            background: T.hdr,
            border: `1px solid ${T.primary}`,
            borderRadius: 20,
            padding: "7px 18px",
            fontSize: 13,
            color: T.primary,
            zIndex: 1000,
            letterSpacing: "0.05em",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {notif}
        </div>
      )}

      {/* ── Pet Loan Modal ────────────────────────────────── */}
      {loanModal.open && (() => {
        const loanPet = loanModal.petId ? (ACCTS[loanModal.petId] as any) : null;
        const eligibleUsers = Object.values(ACCTS).filter((u: any) =>
          u.id !== uid && u.id !== loanModal.petId && !u.isAdmin && !u.isFaculty && !u.isPet && !u.isRelief && u.un
        ) as any[];
        const filteredUsers = loanModal.search.trim()
          ? eligibleUsers.filter(u => (u.un || "").toLowerCase().includes(loanModal.search.toLowerCase()) || (u.id||"").toLowerCase().includes(loanModal.search.toLowerCase()))
          : eligibleUsers.slice(0, 50);
        const targetUser = loanModal.targetId ? (ACCTS[loanModal.targetId] as any) : null;
        const confirmLoan = () => {
          if (!loanModal.targetId || !loanPet) return;
          const petName = loanPet.un || loanPet.id;
          const toName = targetUser?.un || targetUser?.id || "them";
          const msgText = `📤 LOAN OFFER — ${petName}\n\nTerms: ${loanModal.terms}\n\nThis pet has been offered to you for temporary custody. Reply to confirm acceptance.`;
          if (uid && user) {
            const toUser = ACCTS[loanModal.targetId];
            fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromId: uid, fromUsername: user.un, fromPic: user.pic || "🌑", toId: loanModal.targetId, toUsername: toUser?.un || loanModal.targetId, text: msgText }) }).catch(() => {});
          }
          toast(`Loan offer sent to ${toName}`);
          setLoanModal(m => ({ ...m, open: false }));
          go("messages");
        };
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", zIndex: 500, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
            <div style={{ width: "100%", maxWidth: 540, background: T.bg, borderRadius: "16px 16px 0 0", maxHeight: "88vh", display: "flex", flexDirection: "column" as any }}>
              {/* Header */}
              <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <p style={{ fontFamily: "'Cinzel',serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em", color: T.text }}>📤 LOAN A PET</p>
                  {loanPet && <p style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{loanPet.displayName || loanPet.name}</p>}
                </div>
                <button type="button" onClick={() => setLoanModal(m => ({ ...m, open: false }))} style={{ background: "none", border: "none", color: T.muted, fontSize: 20, cursor: "pointer" }}>×</button>
              </div>
              <div style={{ flex: 1, overflowY: "auto" as any, padding: "16px 20px" }}>
                {/* Terms */}
                <p style={{ fontSize: 11, color: T.muted, fontFamily: "'Cinzel',serif", letterSpacing: "0.08em", marginBottom: 6 }}>LOAN TERMS</p>
                <textarea
                  value={loanModal.terms}
                  onChange={e => setLoanModal(m => ({ ...m, terms: e.target.value }))}
                  style={{ width: "100%", minHeight: 70, background: T.dim, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 12, padding: "10px 12px", resize: "none" as any, fontFamily: "'IM Fell English',serif", boxSizing: "border-box" as any }}
                />
                {/* Selected target */}
                {targetUser && (
                  <div style={{ background: T.dim, border: `1px solid ${T.primary}`, borderRadius: 10, padding: "10px 14px", marginTop: 12, marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 22 }}>{targetUser.pic || "👤"}</span>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{targetUser.un}</p>
                      <p style={{ fontSize: 11, color: T.muted }}>@{targetUser.id}</p>
                    </div>
                    <button type="button" onClick={() => setLoanModal(m => ({ ...m, targetId: null }))} style={{ background: "none", border: "none", color: T.muted, fontSize: 16, cursor: "pointer" }}>×</button>
                  </div>
                )}
                {/* User search */}
                {!targetUser && (
                  <>
                    <p style={{ fontSize: 11, color: T.muted, fontFamily: "'Cinzel',serif", letterSpacing: "0.08em", marginTop: 12, marginBottom: 6 }}>SELECT RECIPIENT</p>
                    <input
                      placeholder="Search students..."
                      value={loanModal.search}
                      onChange={e => setLoanModal(m => ({ ...m, search: e.target.value }))}
                      style={{ width: "100%", background: T.dim, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 12, padding: "9px 12px", boxSizing: "border-box" as any, marginBottom: 8 }}
                    />
                    <div style={{ maxHeight: 200, overflowY: "auto" as any, display: "flex", flexDirection: "column" as any, gap: 4 }}>
                      {filteredUsers.map((u: any) => (
                        <button key={u.id} type="button" onClick={() => setLoanModal(m => ({ ...m, targetId: u.id }))}
                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: T.dim, border: `1px solid ${T.border}`, borderRadius: 8, cursor: "pointer", textAlign: "left" as any }}>
                          {(() => { const p = u.pic || "👤"; return (p.startsWith("/") || p.startsWith("http") || p.startsWith("data:")) ? <img src={p} alt="" style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} /> : <span style={{ fontSize: 20 }}>{p}</span>; })()}
                          <div>
                            <p style={{ fontSize: 12, fontWeight: 700, color: T.text, margin: 0 }}>{u.un}</p>
                            <p style={{ fontSize: 10, color: T.muted, margin: 0 }}>@{u.id}</p>
                            {u.tier && <p style={{ fontSize: 9, color: T.border, margin: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>{u.tier}</p>}
                          </div>
                        </button>
                      ))}
                      {filteredUsers.length === 0 && <p style={{ fontSize: 12, color: T.muted, textAlign: "center" as any, padding: "20px 0" }}>No students found.</p>}
                    </div>
                  </>
                )}
              </div>
              {/* Confirm */}
              <div style={{ padding: "12px 20px 24px", borderTop: `1px solid ${T.border}` }}>
                <button type="button" disabled={!loanModal.targetId} onClick={confirmLoan}
                  style={{ ...btn(true), width: "100%", padding: "13px", fontSize: 13, opacity: loanModal.targetId ? 1 : 0.4 }}>
                  📤 SEND LOAN OFFER VIA DM
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {isBankrupt && BankruptcyScreen()}
      {isPetStatus && !isBankrupt && PetStatusScreen()}

      {(user?.isPet || user?.isRelief) ? PetPortal() : (<>
      {nav === "feed" && Feed()}
      {nav === "explore" && Explore()}
      {nav === "forum" && Forum()}
      {nav === "university" && University()}
      {nav === "casino" && Casino()}
      {nav === "auction" && Auction()}
      {nav === "bag" && InventoryBag()}
      {nav === "profile" && Profile()}
      {nav === "settings" && Settings()}
      {nav === "wallet" && Wallet()}
      {nav === "messages" && Messages()}

      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: T.hdr,
          borderTop: `1px solid ${T.border}`,
          display: "flex",
          justifyContent: "space-around",
          alignItems: "center",
          padding: "6px 0 10px",
          zIndex: 100,
        }}
      >
        {[
          { id: "feed", icon: "🏛️", lab: "QUAD" },
          { id: "explore", icon: "🔭", lab: "EXPLORE" },
          { id: "forum", icon: "📋", lab: "FORUM" },
          { id: "university", icon: "📜", lab: "NOCTIS" },
          { id: "casino", icon: "🎰", lab: "CASINO" },
          { id: "wallet", icon: "💎", lab: "WALLET" },
          { id: "profile", icon: "👤", lab: "PROFILE" },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              go(item.id);
              if (item.id === "profile") setProfId(null);
            }}
            style={navBtn(nav === item.id)}
          >
            <div style={{ position: "relative" }}>
              <span>{item.icon}</span>
              {item.dot && (
                <span
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -3,
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#ff3b3b",
                    animation: "pulse 2s infinite",
                  }}
                />
              )}
            </div>
            <span style={navLbl(nav === item.id)}>{item.lab}</span>
          </button>
        ))}
      </div>
      </>)}
    </div>
  );
}