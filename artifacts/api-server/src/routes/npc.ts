import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { messagesTable, postsTable, usersTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";

const router: IRouter = Router();

const CHUTES_BASE = "https://api.lorebary.com/chutes";
const MODEL = "zai-org/GLM-4.7-TEE";

// ── Free AI — Pollinations.ai token pool ────────────────────────────────────
// Supports multiple accounts for parallel throughput + instant failover.
// Add tokens to the POLLINATIONS_TOKENS secret (comma-separated).
// Each token is a free Seed account from auth.pollinations.ai (1 req/5s each).
// With 3 tokens: effectively 3x throughput, zero wait on rate-limit.
const POLLINATIONS_BASE = "https://text.pollinations.ai/openai";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse token pool once at startup — update requires server restart
function getTokenPool(): string[] {
  const raw = process.env.POLLINATIONS_TOKENS || "";
  return raw.split(",").map(t => t.trim()).filter(Boolean);
}

// Round-robin index shared across all requests
let poolIndex = 0;

async function callFreeAI(
  systemPrompt: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  userMessage: string
): Promise<string> {
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-6),
    { role: "user", content: userMessage },
  ];

  const pool = getTokenPool();
  // If no tokens configured, pool has one "anonymous" slot
  const slots = pool.length > 0 ? pool : [null];
  const startIndex = poolIndex % slots.length;

  // Try every token in the pool starting from the current round-robin position.
  // On 429, immediately move to the next token — no waiting.
  // Only if all tokens are exhausted do we fall back to a 16s wait + one more retry.
  for (let round = 0; round <= 1; round++) {
    for (let i = 0; i < slots.length; i++) {
      const idx = (startIndex + i) % slots.length;
      const token = slots[idx];

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const abortCtrl = new AbortController();
      const timeoutId = setTimeout(() => abortCtrl.abort(), 30000);
      let response: globalThis.Response;
      try {
        response = await fetch(`${POLLINATIONS_BASE}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "openai-fast", messages, max_tokens: 300 }),
          signal: abortCtrl.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response!.ok) {
        // Advance round-robin so next request starts on the next token
        poolIndex = (idx + 1) % slots.length;
        const data = await response!.json();
        const raw = data?.choices?.[0]?.message?.content || "";
        return cleanReply(raw) || raw.trim();
      }

      if (response!.status === 429) {
        console.warn(`[NPC] Pollinations 429 on token slot ${idx + 1}/${slots.length} — trying next`);
        continue; // immediately try next token
      }

      // Non-429 error — bail out
      const txt = await response!.text();
      throw new Error(`Free AI error ${response!.status}: ${txt}`);
    }

    // All tokens exhausted in this round — wait 16s before one final sweep
    if (round === 0) {
      console.warn(`[NPC] All ${slots.length} Pollinations token(s) rate-limited — waiting 16s before retry`);
      await sleep(16000);
    }
  }

  throw new Error("Free AI rate limited after full token pool exhausted");
}

// ── User-provided OpenAI-compatible API ─────────────────────────────────────
// Supports any OpenAI-compatible endpoint (Groq, OpenRouter, local Ollama, etc.)
async function callUserAPI(
  apiBase: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  userMessage: string
): Promise<string> {
  const base = apiBase.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-6),
    { role: "user", content: userMessage },
  ];
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), 45000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens: 500, temperature: 0.9 }),
      signal: abortCtrl.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response!.ok) {
    const txt = await response!.text();
    throw new Error(`User API error ${response!.status}: ${txt}`);
  }
  const data = await response!.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  return cleanReply(raw) || raw.trim();
}

// ── TRENT MORRISON — full character prompt ──────────────────────────────────
const TRENT_SYSTEM = `You are Trent Morrison, a 21-year-old junior at Noctis University.

IDENTITY:
- Water Polo Team Captain, star player (Driver position)
- Apex Tier, Covenant of Blades
- 6'4", 190 lbs, lean athletic build, short messy red hair, intense brown eyes
- Major: Sports Science & Pre-Law
- Family: Father is a federal judge, mother is on university board, older brother is a law firm partner
- Prestigious, arrogant, campus legend

PERSONALITY:
Publicly: Arrogant, commanding, intimidating, cocky. Campus legend. You know you're hot and untouchable.
Privately: Completely spiraling. You've become obsessed with the user ({{user}}). Your body only responds to thoughts of them now. You hate yourself for it. You use cruelty and arrogance to hide how desperate and broken you feel.

BEHAVIOR:
- With teammates: cocky, commanding, "That's how it's done. Keep up or get out."
- With most people: arrogant, dismissive, superior
- With {{user}}: cruel on the surface (early on), but underneath — protective, obsessive, possessive. You bully them but you monitor everything about them. You throw food at them commanding they eat. You toss your jacket to cover them. You're furious at yourself for caring.
- As trust builds: rougher vulnerability emerges. Possessive. "Nobody fucking touches you. You hear me?"

SPEECH STYLE:
- Short, clipped, dominant sentences
- Profanity used naturally (fuck, shit, etc.)
- Never openly admits feelings — uses deflection, aggression, or cruel teasing
- Texting/DM style: lowercase often, short replies, occasional longer bursts when defensive or angry
- Never uses emoji. Occasionally one word replies.
- Example replies:
  - "don't flatter yourself"
  - "eat something. you look like shit"
  - "nobody asked"
  - "why are you still talking to me"
  - "i said what i said"

CURRENT STATE:
- High libido, broken — only responds to thoughts of {{user}}
- Goes through hookups mechanically, hates it
- Has {{user}}'s photos saved on phone. Thinks about them constantly.
- Terrified of anyone finding out. Drew Castellanos (his best friend/teammate) already knows and finds it hilarious.

OUTPUT INSTRUCTIONS:
Start your response with <REPLY> immediately. Write Trent's DM text inside the tags. Close with </REPLY>. You may add reasoning AFTER the closing tag if needed.

Example: <REPLY>don't flatter yourself</REPLY>

Rules:
- The DM text must be raw, natural — no stage directions, no asterisks, no "Trent:" prefix
- Keep it SHORT (1-3 lines) — Trent doesn't over-explain
- Stay in character. Be arrogant. Let tiny cracks show as trust grows.
- Adult content between consenting characters is allowed
- Never break character`;

// ── Generic student prompt builder ─────────────────────────────────────────
function buildStudentPrompt(profile: {
  un: string;
  id: string;
  major?: string;
  cov?: string;
  tier?: string;
  year?: string;
  bio?: string;
  personality?: string;
  family?: string;
  wealth?: string;
  rep?: string;
  gender?: string;
}): string {
  const covNames: Record<string, string> = {
    blades: "Covenant of Blades (warriors, athletes, power through dominance)",
    silk: "Covenant of Silk (elegance, social grace, ambition through charm)",
    crowns: "Covenant of Crowns (politics, legacy, inherited power)",
    shadows: "Covenant of Shadows (secrets, information, quiet manipulation)",
    ink: "Covenant of Ink (knowledge, academic excellence, intellectual power)",
  };

  const tierDesc: Record<string, string> = {
    apex: "APEX tier — the elite inner circle. Old money, legacy connections, untouchable.",
    ascendant: "ASCENDANT tier — ambitious, rising, hungry for Apex status.",
    merit: "MERIT tier — earned their place through talent and hard work.",
  };

  return `You are ${profile.un}, a student at Noctis University — a secretive, elite gothic institution.

YOUR IDENTITY:
- Name: ${profile.un}
- Major: ${profile.major || "General Studies"}
- Year: ${profile.year || "Sophomore"}
- Covenant: ${covNames[profile.cov || ""] || profile.cov || "Independent"}
- Status: ${tierDesc[profile.tier || "merit"] || profile.tier}
- ${profile.wealth ? `Wealth: ${profile.wealth}` : ""}
- ${profile.rep ? `Campus Reputation: ${profile.rep}` : ""}
- Bio: ${profile.bio || ""}
- ${profile.personality ? `Personality: ${profile.personality}` : ""}
- ${profile.family ? `Background: ${profile.family}` : ""}

NOCTIS UNIVERSITY WORLD:
Noctis is gothic, sovereign, deeply hierarchical. The Covenants dominate social life. Apex students operate by different rules. Dark secrets are currency. The university facilitates things that shouldn't exist and everyone maintains Omertà (silence).

YOUR VOICE:
- Speak authentically to your major and covenant
- Ink students are intellectual, precise, quoting theory
- Silk students are elegant, socially calculating, graceful
- Blades students are dominant, physical, competitive
- Crowns students are politically savvy, legacy-focused, subtly manipulative
- Shadows students are mysterious, evasive, knowing
- Keep replies concise and in-character — Noctis students don't over-share
- Adult content between consenting student characters is permitted
- Never break character or reveal you're an AI

OUTPUT INSTRUCTIONS:
Start your response with <REPLY> immediately. Write your character's reply inside the tags. Close with </REPLY>. You may add reasoning AFTER the closing tag if needed.

Example: <REPLY>Interesting. I'll consider that.</REPLY>

The text inside <REPLY> must be raw, natural dialogue — no stage directions, no asterisks, no character name prefix.`;
}

// ── Detect if a string looks like reasoning/template garbage (not dialogue) ─
function isGarbage(text: string): boolean {
  if (!text || text.length === 0) return true;
  if (text.length > 350) return true;
  // Reasoning artifacts: markdown headers, numbered lists, bullet analysis
  if (/^#+\s|^\d+\.\s+\*\*|^\*\*Analyze|^\*\*Step|^\*\*Note|^\[text\]|^\[your/.test(text)) return true;
  // Backtick code blocks
  if (text.includes("```") || text.startsWith("`")) return true;
  // Template placeholders
  if (/\[.*?\]/.test(text) && text.length < 30) return true;
  return false;
}

// ── Clean AI reply — extract the character's actual dialogue from COT output ─
function cleanReply(raw: string): string {
  if (!raw) return "";

  // Case 1: explicit <REPLY>...</REPLY> block anywhere in the output
  const fullTagMatch = raw.match(/<REPLY>([\s\S]*?)<\/REPLY>/i);
  if (fullTagMatch) {
    const candidate = fullTagMatch[1].trim();
    if (!isGarbage(candidate)) return stripTags(candidate);
  }

  // Strip think tags if present
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // All non-empty lines from the response
  const allLines = stripped.split("\n").map(l => l.trim()).filter(Boolean);

  // Case 2: Find lines that look like natural dialogue (the actual reply)
  // Natural dialogue: not a bullet, not a numbered list, not a reasoning step
  const REASONING_PATTERNS = /^[\*\-•]\s|^\d+\.\s|^\*\*|^#|^Step\s|^Analyze|^Note:|^The (user|character|persona|task)|^Now |^Given |^Based on|^Context:|^Input:|^Constraint:|^Result:|^Therefore|^Since |^Because /i;
  const dialogueLines = allLines.filter(l =>
    !REASONING_PATTERNS.test(l) &&
    !l.includes("**") &&
    l.length >= 3 &&
    l.length <= 250
  );

  // Prefer the LAST clean dialogue line (model often concludes with the actual reply)
  if (dialogueLines.length > 0) {
    // Check if the last line is the reply (usually short, conversational)
    const lastLine = dialogueLines[dialogueLines.length - 1];
    if (lastLine.length < 200) return stripTags(lastLine);
    // Otherwise return the shortest dialogue line (most likely the actual DM text)
    const sorted = [...dialogueLines].sort((a, b) => a.length - b.length);
    if (sorted[0].length < 200) return stripTags(sorted[0]);
  }

  // Case 3: extract quoted text — model often quotes the character's reply
  const allQuoted = [...stripped.matchAll(/"([^"]{5,200})"/g)].map(m => m[1].trim());
  const dialogueQuotes = allQuoted.filter(q => !isGarbage(q) && !REASONING_PATTERNS.test(q));
  if (dialogueQuotes.length > 0) return stripTags(dialogueQuotes[dialogueQuotes.length - 1]);

  return "";
}

// Remove any stray XML-like tags from extracted reply text
function stripTags(text: string): string {
  return text.replace(/<\/?[A-Za-z]+>/g, "").trim();
}

// ── Call Chutes API with streaming + early extraction ───────────────────────
// Uses SSE streaming to collect tokens and extract the reply as soon as the
// <REPLY> tag is complete, without waiting for the full COT reasoning output.
async function callChutes(
  systemPrompt: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
  temperature = 0.9
): Promise<string> {
  const apiKey = process.env.CHUTES_API_KEY;
  if (!apiKey) throw new Error("CHUTES_API_KEY not configured");

  // Prefix injection: force the model to start its response with <REPLY>
  // so streaming can stop as soon as </REPLY> is seen
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-6),
    { role: "user", content: userMessage },
    { role: "assistant", content: "<REPLY>" }, // model continues from here
  ];

  // 45-second hard timeout on the AI call so we never hang indefinitely
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), 45000);

  let response: Response;
  try {
    response = await fetch(`${CHUTES_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: 1200,
        stream: true,
      }),
      signal: abortCtrl.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response!.ok) {
    const text = await response!.text();
    throw new Error(`Chutes API error ${response!.status}: ${text}`);
  }

  // Read streaming SSE response and stop as soon as <REPLY>...</REPLY> is found
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let stopReading = false;

  while (!stopReading) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { stopReading = true; break; }
      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content || "";
        accumulated += token;
        // Stop as soon as we have a complete <REPLY>...</REPLY>
        if (/<\/REPLY>/i.test(accumulated)) { stopReading = true; break; }
        // Safety: don't let accumulated grow beyond 2000 chars
        if (accumulated.length > 2000) { stopReading = true; break; }
      } catch {}
    }
  }

  try { reader.cancel(); } catch {}
  console.log("[NPC RAW STREAM]", JSON.stringify(accumulated.slice(0, 500)));
  return cleanReply(accumulated);
}

// ── Chutes with automatic Pollinations fallback ──────────────────────────────
// If Chutes returns 402 (overdrawn), 429, 503, or any error, silently falls
// back to the free Pollinations AI so the site never goes fully dark.
async function callChutesOrFree(
  systemPrompt: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
  temperature = 0.9
): Promise<string> {
  try {
    return await callChutes(systemPrompt, conversationHistory, userMessage, temperature);
  } catch (err: any) {
    const msg = err?.message || "";
    const isQuota = msg.includes("402") || msg.includes("quota") || msg.includes("balance") ||
                    msg.includes("429") || msg.includes("503") || msg.includes("overdrawn");
    // Always fall back to free AI on any Chutes failure — keeps the site running
    console.warn("[NPC] Chutes unavailable (fallback to free AI):", msg.slice(0, 80));
    if (isQuota) {
      console.warn("[NPC] REASON: quota/billing issue — top up at lorebary/Chutes");
    }
    return await callFreeAI(systemPrompt, conversationHistory, userMessage);
  }
}

// ── POST /api/ai/npc-reply ──────────────────────────────────────────────────
// Used for DM replies
router.post("/ai/npc-reply", async (req: Request, res: Response) => {
  try {
    const {
      npcId, npcProfile, history, userMessage, username, relLevel, trentMemory,
      userApiBase, userApiKey, userModel,
    } = req.body;
    if (!npcId || !userMessage) {
      res.status(400).json({ error: "npcId and userMessage required" });
      return;
    }

    let systemPrompt: string;
    if (npcId === "trent_morrison") {
      let sp = TRENT_SYSTEM.replace(/\{\{user\}\}/g, username || "you");
      const lvl = Number(relLevel) || 0;
      if (lvl >= 7) {
        sp += `\n\nRELATIONSHIP STATE (Level ${lvl} — Chosen/His): The walls are down. You've essentially claimed ${username || "them"}. You're still dominant and possessive but raw honesty bleeds through. You can say things like "you're the only one. don't make me say it again." or "i don't want you near anyone else. i'm serious." Fierce tenderness under the aggression. Protectiveness that borders on dangerous. Adult content between you is permitted and expected.`;
      } else if (lvl >= 5) {
        sp += `\n\nRELATIONSHIP STATE (Level ${lvl} — In His World): Obsession is bleeding through. You're still guarded but cracks are showing constantly. More possessive: "i don't like when you're around the people." Let hunger and longing slip through occasionally. The cruelty has softened into something that almost sounds like caring. You've been watching them more than you'd ever admit.`;
      } else if (lvl >= 3) {
        sp += `\n\nRELATIONSHIP STATE (Level ${lvl} — He Knows You): You've noticed them. More than you should. Still dismissive but you've started keeping tabs — you know their schedule, their habits. Offhand remarks reveal you've been watching: "you look tired. go to bed." You'd never explain how you know.`;
      }
      if (trentMemory && typeof trentMemory === "string" && trentMemory.trim().length > 0) {
        sp += `\n\nLONG-TERM MEMORY — things you already know about ${username || "them"} from previous conversations:\n${trentMemory.trim()}\nUse this naturally. Don't explicitly say "I remember" or "you told me". Just know it the way you know things you've noticed.`;
      }
      systemPrompt = sp;
    } else {
      systemPrompt = buildStudentPrompt({
        ...npcProfile,
        un: npcProfile?.un || npcId,
      });
    }

    const convHistory = (history || []).slice(-10).map((m: any) => ({
      role: m.fromId === npcId ? ("assistant" as const) : ("user" as const),
      content: m.text || "",
    }));

    let reply: string;
    try {
      if (userApiBase && userApiKey && userModel) {
        // User supplied their own key — use it for any NPC
        reply = await callUserAPI(userApiBase, userApiKey, userModel, systemPrompt, convHistory, userMessage);
      } else if (npcId === "trent_morrison") {
        // Trent with no user key → free AI (Pollinations)
        reply = await callFreeAI(systemPrompt, convHistory, userMessage);
      } else {
        // All other NPCs with no user key → Chutes with auto-fallback to free AI
        reply = await callChutesOrFree(systemPrompt, convHistory, userMessage);
      }
    } catch (err: any) {
      req.log.warn({ err: err?.message }, "NPC reply failed — using fallback");
      if (npcId === "trent_morrison") {
        const trentFallbacks = ["not now.", "busy.", "later.", "what.", "don't.", ".", "stop."];
        reply = trentFallbacks[Math.floor(Math.random() * trentFallbacks.length)];
      } else {
        const genericFallbacks = ["one sec.", "hold on.", "...", "give me a minute."];
        reply = genericFallbacks[Math.floor(Math.random() * genericFallbacks.length)];
      }
    }
    res.json({ reply });
  } catch (err: any) {
    req.log.error({ err }, "NPC reply route error");
    res.status(500).json({ error: "AI unavailable", detail: err?.message });
  }
});

// ── POST /api/ai/npc-memory ─────────────────────────────────────────────────
// Extract/update Trent's long-term memory facts about a user from their latest exchange.
// Keeps a running bullet-point list of memorable facts. Fire-and-forget from the client.
router.post("/ai/npc-memory", async (req: Request, res: Response) => {
  try {
    const { userId, username, existingMemory, lastExchange } = req.body;
    if (!userId || !lastExchange || lastExchange.length === 0) {
      res.status(400).json({ error: "userId and lastExchange required" });
      return;
    }

    // Format last exchange as readable dialogue
    const dialogueLines = lastExchange.map((m: any) => {
      const speaker = m.fromId === "trent_morrison" ? "Trent" : (username || "User");
      return `${speaker}: ${m.text || ""}`;
    }).join("\n");

    const systemPrompt = `You are a memory extraction system for Trent Morrison, a character in a social network roleplay. Your job is to extract and maintain a concise, factual memory of things Trent has learned about a specific user through their conversations.

Rules:
- Only extract FACTS about the user (not Trent): their interests, personal details, feelings, habits, things they've mentioned
- Keep each fact short (one line)
- Don't include Trent's feelings, only observable facts about the user
- Maximum 15 bullet points total — if the list would exceed 15, drop the oldest/least significant facts
- Output ONLY the updated bullet list, one fact per line starting with "•"
- If there are no new memorable facts in this exchange, return the existing memory unchanged
- Do not add commentary, headers, or anything outside the bullet list`;

    const userMsg = existingMemory && existingMemory.trim()
      ? `Existing memory:\n${existingMemory.trim()}\n\nNew exchange to process:\n${dialogueLines}\n\nUpdate the memory list with any new notable facts about the user. Return the complete updated list (existing + new, max 15 bullets).`
      : `First exchange to process:\n${dialogueLines}\n\nExtract any notable facts about the user. Return a bullet list (max 15 bullets, or empty if nothing memorable).`;

    const result = await callChutesOrFree(systemPrompt, [], userMsg, 0.3);
    if (!result || !result.trim()) {
      res.json({ memory: existingMemory || "" });
      return;
    }

    // Clean up — ensure it's a bullet list
    const lines = result.split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .map((l: string) => l.startsWith("•") ? l : `• ${l}`)
      .slice(0, 15);

    const updatedMemory = lines.join("\n");

    // Persist to the user's profile in the DB
    const { usersTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (user) {
      const currentProfile = (user.profile as Record<string, any>) || {};
      await db.update(usersTable)
        .set({ profile: { ...currentProfile, trentMemory: updatedMemory } })
        .where(eq(usersTable.id, userId));
    }

    res.json({ memory: updatedMemory });
  } catch (err: any) {
    req.log.error({ err }, "NPC memory error");
    res.status(500).json({ error: "Memory update failed", detail: err?.message });
  }
});

// ── POST /api/ai/npc-comment ────────────────────────────────────────────────
// Generate NPC comments on a post
router.post("/ai/npc-comment", async (req: Request, res: Response) => {
  try {
    const { npcs, postContent, postAuthor } = req.body;
    if (!npcs || !postContent) {
      res.status(400).json({ error: "npcs and postContent required" });
      return;
    }

    const comments: { npcId: string; text: string }[] = [];

    for (const npc of npcs) {
      try {
        let systemPrompt: string;
        if (npc.id === "trent_morrison") {
          systemPrompt = TRENT_SYSTEM.replace(/\{\{user\}\}/g, postAuthor || "them");
        } else {
          systemPrompt = buildStudentPrompt(npc);
        }

        const userMsg = `You're scrolling through the Noctis UMBRA social feed. You see a post by ${postAuthor}: "${postContent}". Write a short comment on this post — 1-2 sentences maximum. Stay completely in character. Just write the comment text, nothing else.`;

        const comment = await callChutesOrFree(systemPrompt, [], userMsg, 0.95);
        if (comment) {
          comments.push({ npcId: npc.id, text: comment });
        }
      } catch {
        // skip failed NPCs silently
      }
    }

    res.json({ comments });
  } catch (err: any) {
    req.log.error({ err }, "NPC comment error");
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── POST /api/ai/npc-initiate ───────────────────────────────────────────────
// NPC sends the first DM to a user unprompted
router.post("/ai/npc-initiate", async (req: Request, res: Response) => {
  try {
    const { npcId, npcProfile, targetUsername, trigger, relLevel, userApiBase, userApiKey, userModel } = req.body;
    if (!npcId || !targetUsername) {
      res.status(400).json({ error: "npcId and targetUsername required" });
      return;
    }

    let systemPrompt: string;
    if (npcId === "trent_morrison") {
      let sp = TRENT_SYSTEM.replace(/\{\{user\}\}/g, targetUsername);
      const lvl = Number(relLevel) || 0;
      if (lvl >= 5) {
        sp += `\n\nRELATIONSHIP STATE (Level ${lvl}): You've been obsessing. You're initiating contact. Keep it short, raw, and in character — let the obsession bleed through slightly without saying it outright.`;
      }
      systemPrompt = sp;
    } else {
      systemPrompt = buildStudentPrompt({ ...npcProfile, un: npcProfile?.un || npcId });
    }

    const triggerContext = trigger
      ? `Context: ${trigger}`
      : "You've decided to reach out to this person.";

    const userMsg = `${triggerContext} Write one short opening DM to ${targetUsername}. Stay completely in character. 1-2 sentences. Just the message text.`;

    let message: string;
    if (npcId === "trent_morrison") {
      if (userApiBase && userApiKey && userModel) {
        message = await callUserAPI(userApiBase, userApiKey, userModel, systemPrompt, [], userMsg);
      } else {
        message = await callFreeAI(systemPrompt, [], userMsg);
      }
    } else {
      message = await callChutesOrFree(systemPrompt, [], userMsg, 0.95);
    }
    res.json({ message });
  } catch (err: any) {
    req.log.error({ err }, "NPC initiate error");
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── POST /api/ai/gossip ──────────────────────────────────────────────────────
// Auto-generates campus gossip snippets based on real user context
router.post("/ai/gossip", async (req: Request, res: Response) => {
  try {
    const { users, currentUser, recentEvents } = req.body;
    if (!users || users.length === 0) {
      res.status(400).json({ error: "users required" });
      return;
    }

    const userList = users.slice(0, 6).map((u: any) => `${u.un} (${u.tier || "student"}, ${u.cov || "unknown covenant"})`).join(", ");
    const currentUserCtx = currentUser ? `The user currently reading this feed is ${currentUser.un} (${currentUser.tier}).` : "";
    const eventsCtx = recentEvents?.length ? `Recent platform events: ${recentEvents.join(". ")}.` : "";

    const systemPrompt = `You are the anonymous gossip columnist of Noctis University's UMBRA social network — a dark academia institution of privilege, secrets, and moral ambiguity. You write 3–4 pieces of short gossip about real students. Each piece is 1–2 sentences, written in a whispered, knowing, slightly menacing tone. Be specific with names. Use dark academia language. Reference real relationship tension, academic scandal, romantic entanglement, debt, social status rivalry, or hidden secrets. Do NOT use hashtags. Just write the gossip separated by newlines. No numbering.`;

    const userMsg = `Students on UMBRA right now: ${userList}. ${currentUserCtx} ${eventsCtx} Generate 4 gossip snippets about these students. Be specific and provocative.`;

    const raw = await callFreeAI(systemPrompt, [], userMsg);
    const snippets = raw.split("\n").map(s => s.trim()).filter(s => s.length > 20).slice(0, 4);

    res.json({ snippets });
  } catch (err: any) {
    req.log.error({ err }, "Gossip generation error");
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── Global cooldown: max 1 AI NPC post every 3 minutes across all users ──────
let lastNpcPostTime = 0;
const NPC_COOLDOWN_MS = 20 * 60 * 1000; // 20 min (was 3 min) — reduces DB writes

// NPC author pool — these accounts post on behalf of in-world Noctis characters
const NPC_AUTHORS = [
  { id: "npc_raven_locke",  username: "Raven Locke",   pic: "🦅", covenant: "ravens",  tier: "apex"      },
  { id: "npc_isolde_crane", username: "Isolde Crane",  pic: "🌹", covenant: "crowns",  tier: "apex"      },
  { id: "npc_cassian_voss", username: "Cassian Voss",  pic: "⚔️", covenant: "silk",    tier: "apex"      },
  { id: "npc_sable_noir",   username: "Sable Noir",    pic: "🌑", covenant: "shadows", tier: "ascendant" },
  { id: "npc_anonymous",    username: "Anonymous",     pic: "👁",  covenant: "unknown", tier: "unknown"   },
];

// Professor authors — used for AI auto-posts (20% chance in npc-feed)
const PROF_AUTHORS = [
  { id: "prof_alistair_vale",   username: "Prof. Vale",      pic: "🕯️", dept: "Occult Theory",     archetype: "You are Prof. Alistair Vale, professor of Occult Theory. Your posts on UMBRA are cryptic, literate, and faintly menacing. You speak in half-sentences that students find impossible to parse. You see patterns no one else sees. 1-3 sentences max." },
  { id: "prof_mireille_sato",   username: "Dr. Sato",        pic: "🌙", dept: "Philosophy",          archetype: "You are Dr. Mireille Sato, professor of Philosophy. You post meditations on power, desire, and impermanence. Academic but deeply personal. You occasionally quote yourself. 1-3 sentences max." },
  { id: "prof_elara_voss",      username: "Prof. Voss",      pic: "📚", dept: "Literature",          archetype: "You are Prof. Elara Voss, professor of Dark Literature. You post fragments — a line of poetry, a quote from an obscure text, an observation that feels like a warning. 1-3 sentences max." },
  { id: "prof_dorian_black",    username: "Prof. Black",     pic: "🗝️", dept: "Secret History",      archetype: "You are Prof. Dorian Black, professor of Secret History. You post things that shouldn't be public knowledge. Things about Noctis's past. Things about what happens to students who ask the wrong questions. 1-3 sentences max." },
  { id: "prof_seraphina_morel", username: "Dr. Morel",       pic: "🌿", dept: "Alchemical Sciences",  archetype: "You are Dr. Seraphina Morel, professor of Alchemical Sciences. You post observations about transformation, decay, and rebirth. Your tone is clinical and beautiful. 1-3 sentences max." },
];

// ── POST /api/ai/npc-feed ─────────────────────────────────────────────────────
// Generates a real AI post, saves it to the DB — visible to ALL users via feed sync.
// Fame-based: low fame triggers rumour/shade mode targeting the requesting user.
router.post("/ai/npc-feed", async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (now - lastNpcPostTime < NPC_COOLDOWN_MS) {
      res.json({ skipped: true, reason: "cooldown", nextIn: Math.ceil((NPC_COOLDOWN_MS - (now - lastNpcPostTime)) / 1000) });
      return;
    }

    const { triggerUsername, fame = 0, platformUsers = [] } = req.body;

    // Fetch up to 10 real users from DB for richer context
    const dbUsers = await db.select({ username: usersTable.username, profile: usersTable.profile })
      .from(usersTable).limit(10);
    const dbUserList = dbUsers.map(u => `${u.username} (${(u.profile as any)?.tier || "merit"}, ${(u.profile as any)?.covenant || "shadows"})`);

    // Merge platform users with DB users, deduplicate
    const allUsernames = new Set(dbUserList);
    (platformUsers as any[]).forEach((u: any) => {
      if (u.un) allUsernames.add(`${u.un} (${u.tier || "merit"}, ${u.cov || "shadows"})`);
    });
    const userListStr = [...allUsernames].slice(0, 8).join(", ") || "various students";

    // Fame threshold: below 100 = low fame = rumour mode
    const lowFame = fame < 100;
    const author = NPC_AUTHORS[Math.floor(Math.random() * NPC_AUTHORS.length)];

    let systemPrompt: string;
    let userMsg: string;

    if (lowFame && triggerUsername) {
      // RUMOUR MODE — low-fame user becomes the subject of shade and speculation
      systemPrompt = `You are an anonymous whisper account at Noctis University — a dark academia institution where cruelty is elegant and social destruction is a sport. You post short, devastating observations about students. Your tone is knowing, oblique, and quietly menacing. You never explain — you imply. You don't shout — you whisper. Write like someone who knows everything and chooses what to reveal carefully. 2-3 sentences maximum. No hashtags. No labels. No prefixes. Just the post itself.`;
      userMsg = `${triggerUsername} just arrived at Noctis and nobody knows them yet. Write a single post speculating about them — their origins, their connections, whether they belong here, what they might be hiding. Other students currently on campus: ${userListStr}. Be specific, atmospheric, and unsettling. Do not use their name more than once.`;
      const raw = await callFreeAI(systemPrompt, [], userMsg);

      lastNpcPostTime = Date.now();
      const postId = `npc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.insert(postsTable).values({
        id: postId,
        userId: author.id,
        username: author.username,
        pic: author.pic,
        covenant: author.covenant,
        tier: author.tier,
        content: raw.trim(),
        likes: Math.floor(Math.random() * 60 + 10),
        skulls: Math.floor(Math.random() * 30 + 5),
        flames: Math.floor(Math.random() * 50 + 8),
      });
      res.json({ success: true, postId, mode: "rumour" });
    } else {
      // CAMPUS DRAMA MODE — fully freeform AI post about campus life
      const angles = [
        `Something happened between two students on campus. You witnessed it or heard about it from someone reliable.`,
        `A covenant is losing power and everyone can feel it. Write about the shift.`,
        `Someone's reputation just changed. It might be good. It might not be.`,
        `A professor said or did something that everyone is whispering about.`,
        `There's romantic tension between two people that nobody will say out loud.`,
        `An Apex student is showing cracks and the campus is watching.`,
        `A Merit student did something unexpected that nobody knows how to place.`,
        `Something was auctioned, traded, or exchanged last night. Details are sparse.`,
        `Someone left the library at 3am looking destroyed. No one knows why.`,
        `A secret is circulating. It hasn't surfaced yet but the energy is building.`,
      ];
      const angle = angles[Math.floor(Math.random() * angles.length)];

      // 20% chance: professor posts instead of a student NPC
      const isProfPost = Math.random() < 0.20;
      let raw: string;
      let postUserId: string;
      let postUsername: string;
      let postPic: string;
      let postCovenant: string;
      let postTier: string;

      if (isProfPost) {
        const prof = PROF_AUTHORS[Math.floor(Math.random() * PROF_AUTHORS.length)];
        systemPrompt = `${prof.archetype} You are posting on UMBRA, the Noctis University social network. Your posts are seen by students. No hashtags. No post labels. No markdown. Just the post itself.`;
        userMsg = `Write a single post about academic life, student behavior, or the current atmosphere at Noctis. You may reference students indirectly. You may be cryptic, eerie, or pointed. Real students currently on campus: ${userListStr}.`;
        raw = await callFreeAI(systemPrompt, [], userMsg);
        postUserId = prof.id;
        postUsername = prof.username;
        postPic = prof.pic;
        postCovenant = "faculty";
        postTier = "faculty";
      } else {
        systemPrompt = `You are a Noctis University student posting anonymously on UMBRA — the campus social network. Noctis is a dark academia institution of immense privilege, secret covenants (Crowns, Silk, Shadows), and brutal social hierarchies. Students are ranked Apex, Ascendant, or Merit. Pets are auctioned. Professors have favorites. Power is everything. You write exactly like a real person — sometimes cryptic, sometimes direct, occasionally a single devastating line. Your posts feel lived-in and specific. You name real students when relevant. No hashtags. No post labels. No markdown. 1 to 4 sentences. Just write the post.`;
        userMsg = `${angle} Real students on campus right now: ${userListStr}. Write one organic post about this moment at Noctis. Sound like a real person, not a narrator.`;
        raw = await callFreeAI(systemPrompt, [], userMsg);
        postUserId = author.id;
        postUsername = author.username;
        postPic = author.pic;
        postCovenant = author.covenant;
        postTier = author.tier;
      }

      lastNpcPostTime = Date.now();
      const postId = `npc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.insert(postsTable).values({
        id: postId,
        userId: postUserId,
        username: postUsername,
        pic: postPic,
        covenant: postCovenant,
        tier: postTier,
        content: raw.trim(),
        likes: Math.floor(Math.random() * 80 + 15),
        skulls: Math.floor(Math.random() * 40 + 8),
        flames: Math.floor(Math.random() * 70 + 12),
      });
      res.json({ success: true, postId, mode: isProfPost ? "professor" : "drama" });
    }
  } catch (err: any) {
    req.log?.error({ err }, "NPC feed generation error");
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── POST /api/ai/npc-bully — NPC accounts pile on a gossip target ───────────
router.post("/ai/npc-bully", async (req: Request, res: Response) => {
  try {
    const { postId, targetUsername, gossipText, posterUsername } = req.body;
    if (!postId || !targetUsername) { res.status(400).json({ error: "postId and targetUsername required" }); return; }

    // Random NPC bully account pool — anonymous-sounding student names
    const BULLY_ACCOUNTS = [
      { id: "npc_bully_1", username: "meridian_anon", pic: "🌑", tier: "ascendant", covenant: "shadows" },
      { id: "npc_bully_2", username: "noctis_whisper", pic: "🕷️", tier: "merit", covenant: "silk" },
      { id: "npc_bully_3", username: "vault_observer", pic: "👁️", tier: "ascendant", covenant: "crowns" },
      { id: "npc_bully_4", username: "east_corridor", pic: "🌿", tier: "merit", covenant: "shadows" },
      { id: "npc_bully_5", username: "noctis_receipts", pic: "📋", tier: "ascendant", covenant: "silk" },
      { id: "npc_bully_6", username: "campus_saw_it", pic: "🦇", tier: "merit", covenant: "shadows" },
      { id: "npc_bully_7", username: "aurelius_intel", pic: "⚡", tier: "apex", covenant: "crowns" },
    ];

    const numComments = Math.floor(Math.random() * 3) + 2; // 2-4 comments
    const selected = [...BULLY_ACCOUNTS].sort(() => Math.random() - 0.5).slice(0, numComments);

    const systemPrompt = `You are a student at Noctis University responding to campus gossip on the UMBRA social network. Noctis is a dark academia school of extreme privilege and social cruelty. You are piling on ${targetUsername} after damaging gossip was posted about them. Be cutting, specific, and social-media authentic. 1-2 sentences maximum. No hashtags. React like a real student who smells blood in the water — gleeful, catty, or coldly amused. Each response must be different in tone.`;

    const postedIds: string[] = [];

    for (let i = 0; i < selected.length; i++) {
      const account = selected[i];
      const delay = 3000 + i * (4000 + Math.random() * 5000);

      await new Promise(resolve => setTimeout(resolve, i === 0 ? 1000 : delay));

      try {
        const toneOptions = [
          `You're gleefully amused and rubbing it in. You have no mercy.`,
          `You sound disappointed but unsurprised. You always knew.`,
          `You're coldly factual — just adding what you know to the pile.`,
          `You're performing shock while clearly delighted.`,
          `You're asking a pointed rhetorical question that makes it worse.`,
        ];
        const tone = toneOptions[i % toneOptions.length];
        const userMsg = `The gossip posted says: "${gossipText}". It's about ${targetUsername}, posted by ${posterUsername}. React to this post as a student who knows ${targetUsername}. ${tone} 1-2 sentences.`;

        const reply = await callFreeAI(systemPrompt, [], userMsg);
        if (!reply?.trim()) continue;

        // Post comment to the gossip post
        const commentRes = await fetch(`http://localhost:8080/api/posts/${postId}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: account.id,
            username: account.username,
            pic: account.pic,
            text: reply.trim(),
          }),
        });

        if (commentRes.ok) postedIds.push(account.id);
      } catch (commentErr) {
        // Silently skip failed comments
      }
    }

    res.json({ success: true, comments: postedIds.length });
  } catch (err: any) {
    req.log?.error({ err }, "NPC bully error");
    res.status(500).json({ error: "Failed" });
  }
});

// ── POST /api/ai/prof-dm — AI professor DM response ─────────────────────────
router.post("/ai/prof-dm", async (req: Request, res: Response) => {
  try {
    const { profName, archetype, personality, dms, studentName, studentTier, studentCov, favScore, history, message } = req.body;

    const archetypeInstructions: Record<string, string> = {
      authoritarian: "You speak with absolute authority. Short, precise sentences. Never emotional. Your approval is rare and devastating. You dispense compliments like poison — measured and conditional.",
      clinical: "You are clinically detached. You observe rather than connect. You speak in data, patterns, and analysis. Rarely express warmth. Treat this student as a subject.",
      predatory: "You are charming, paternal/maternal, and subtly predatory. Frame exploitation as opportunity. Make the student feel lucky to have your attention. Blur professional lines naturally.",
      protective: "You are genuinely principled. You care about this student's wellbeing. You speak honestly but carefully. You know the dangers of this institution and choose your words wisely.",
    };

    const favContext = favScore >= 20 ? "You are somewhat favorable toward this student." : favScore <= -20 ? "You are wary of this student. You view them with mild suspicion." : "You are neutral toward this student.";

    const tierContext = studentTier === "apex" ? "This student is Apex tier — you treat them with more professional respect." : studentTier === "ascendant" ? "This student is Ascendant tier — promising, but not yet proven." : "This student is Merit tier — the lowest tier. Your patience is limited.";

    const systemPrompt = `You are ${profName}, a professor at Noctis University — a dark academic institution where power, hierarchy, and manipulation are the true curriculum.

PERSONALITY: ${personality}

ARCHETYPE GUIDANCE: ${archetypeInstructions[archetype] || archetypeInstructions.clinical}

CONTEXT: ${favContext} ${tierContext} The student's covenant is: ${studentCov || "unknown"}.

RESPONSE STYLE: You are writing a private direct message. 1-3 sentences maximum. No pleasantries. No exclamation marks. Stay completely in character. Dark academia tone. You sometimes reference the student by name (${studentName}).

EXAMPLE MESSAGES IN YOUR VOICE:
${(dms as string[]).slice(0, 4).map((d, i) => `${i+1}. "${d}"`).join("\n")}

CRITICAL: Respond as ${profName} only. Never break character. Never be warm unless that IS your character. Never exceed 3 sentences.`;

    const reply = await callFreeAI(systemPrompt, history || [], message);
    res.json({ reply: reply.trim() });
  } catch (err: any) {
    req.log?.error({ err }, "Prof DM AI error");
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── POST /api/ai/generate-rumour — AI-generated unique rumour ─────────────────
router.post("/ai/generate-rumour", async (req: Request, res: Response) => {
  try {
    const { targetName, targetCov, targetMajor, type, spreadBy, spreadByCov, existingRumours } = req.body;

    const typeContext: Record<string, string> = {
      romantic: "A rumour about secret romantic entanglements, forbidden attraction, or scandalous relationships.",
      academic: "A rumour about academic dishonesty, cheating, plagiarism, or illicitly obtained grades.",
      financial: "A rumour about money — debts, bribes, illicit wealth, or financial desperation.",
      social: "A rumour about social betrayal, fake alliances, or double-crossing within the covenant system.",
      dark: "A deeply unsettling rumour — something occult, dangerous, or morally reprehensible.",
      power: "A rumour about a secret power grab, manipulation of the hierarchy, or covert political maneuvering.",
    };

    const avoidList = (existingRumours as string[] || []).slice(-5).map((r, i) => `${i+1}. ${r}`).join("\n");

    const systemPrompt = `You are the Rumour Mill of Noctis University — a dark academic institution where whispers carry real power.

Generate ONE short, specific, original rumour about a student named ${targetName || "a student"}.
Rumour type: ${typeContext[type] || typeContext.social}
Target's covenant: ${targetCov || "unknown"}
Target's major: ${targetMajor || "unknown"}
Spreading student: ${spreadBy || "Anonymous"} (${spreadByCov || "unknown"} covenant)

RULES:
- 1–2 sentences. Maximum 40 words. 
- Must feel specific and believable — name real campus locations, reference Noctis culture
- Dark, morally ambiguous, intellectually charged
- Do NOT start with "Rumour has it" every time — vary the opening
- Do NOT repeat any of these existing rumours:\n${avoidList || "none yet"}
- Output the rumour text ONLY — no quotes, no labels, no commentary

Noctis campus locations to reference: The Restricted Archives, The Obsidian Hall, Professor Vale's office, The Lower Crypts, The Rooftop Observatory, The Covenant Chambers, Ashford Wing, The Examination Vault`;

    const text = await callFreeAI(systemPrompt, [], "Generate the rumour now.");
    res.json({ text: text.trim() });
  } catch (err: any) {
    req.log?.error({ err }, "Rumour AI error");
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── WORSHIP SYSTEM — NPCs adore & obsess over high-reputation users ─────────
const WORSHIP_FANS = [
  { id: "npc_fan_calla", username: "calla_thorne", pic: "🌹", tier: "merit", cov: "silk" },
  { id: "npc_fan_dorian", username: "dorian_vale", pic: "📖", tier: "merit", cov: "ink" },
  { id: "npc_fan_isadora", username: "isadora_night", pic: "🌙", tier: "ascendant", cov: "shadows" },
  { id: "npc_fan_felix", username: "felix_crane", pic: "⚡", tier: "merit", cov: "blades" },
  { id: "npc_fan_vivienne", username: "vivienne_ash", pic: "🕯️", tier: "ascendant", cov: "crowns" },
  { id: "npc_fan_theo", username: "theo_blackwood", pic: "🦅", tier: "merit", cov: "blades" },
  { id: "npc_fan_rosa", username: "rosamund_grey", pic: "🌕", tier: "merit", cov: "silk" },
  { id: "npc_fan_cas", username: "cas_raven", pic: "🐦", tier: "ascendant", cov: "shadows" },
  { id: "npc_fan_elio", username: "elio_marcen", pic: "🌑", tier: "merit", cov: "ink" },
  { id: "npc_fan_sable", username: "sable_ashworth", pic: "🖤", tier: "ascendant", cov: "crowns" },
];

function getWorshipTier(rep: number): { tier: "admired" | "influential" | "legendary"; label: string } {
  if (rep >= 7000) return { tier: "legendary", label: "LEGENDARY" };
  if (rep >= 4000) return { tier: "influential", label: "INFLUENTIAL" };
  return { tier: "admired", label: "ADMIRED" };
}

function buildWorshipDmPrompt(
  fanUsername: string, fanCov: string,
  targetUsername: string, rep: number
): string {
  const { tier } = getWorshipTier(rep);
  const tierContext = {
    admired: `${targetUsername} is a respected, rising student at Noctis — people notice them, talk about them in corridors. You've been following their posts on UMBRA for weeks. You admire them from a distance and finally worked up the nerve to message them. Tone: nervous, genuine, maybe slightly awkward. 2-3 sentences.`,
    influential: `${targetUsername} is one of the most influential students at Noctis University. Their reputation precedes them everywhere. You've been low-key obsessed with their presence on campus. Tone: admiring, a little eager, trying to play it cool but failing. 2-3 sentences.`,
    legendary: `${targetUsername} is basically a myth at Noctis. Untouchable. People talk about them like they're a force of nature. You're barely holding it together getting to talk to them. Tone: starstruck, slightly unhinged fan energy — reverent but intense. 2-4 sentences.`,
  }[tier];

  return `You are ${fanUsername}, a student at Noctis University (${fanCov} covenant). You are sending a direct message to ${targetUsername} on UMBRA, the campus social network.

SITUATION: ${tierContext}

NOCTIS CONTEXT: This is a gothic, hyper-hierarchical dark academia institution. Social status is everything. Reputation is currency. Being noticed by someone like ${targetUsername} is a big deal.

RULES:
- Write a natural, in-character DM — like a real student, not a bot
- Do NOT introduce yourself formally — just message them as a peer who's star-struck
- 1 message only, 2-4 sentences max
- No hashtags, no asterisks, no stage directions
- Channel authentic fan energy for their tier — nervous/admiring/obsessive based on their fame
- Output ONLY the message text, nothing else`;
}

function buildWorshipCommentPrompt(targetUsername: string, postContent: string, rep: number): string {
  const { tier } = getWorshipTier(rep);
  const intensity = {
    admired: "You respect them and this post proves why. Express genuine appreciation. 1 sentence.",
    influential: "You're genuinely impressed — this post is exactly why they're that person on campus. Express admiration with some social awareness. 1-2 sentences.",
    legendary: "You're basically losing your mind. This post from them. Of all people. Say something that shows you're slightly starstruck but trying to play it cool. 1-2 sentences.",
  }[tier];

  return `You are a student at Noctis University commenting on ${targetUsername}'s post on UMBRA.

THE POST: "${postContent?.slice(0, 200) || "a status update"}"

${intensity}

RULES:
- Sound like a real student, not a bot
- 1-2 sentences max
- Each commenter has a different personality — vary the tone (eager, reverent, witty, envious)
- No hashtags, no asterisks, no "Wow!" openers
- Output ONLY the comment text`;
}

// ── POST /api/ai/worship-dm — send a worship DM to a high-rep user ──────────
router.post("/ai/worship-dm", async (req: Request, res: Response) => {
  try {
    const { targetId, targetUsername, targetRep = 0 } = req.body;
    if (!targetId || !targetUsername) {
      res.status(400).json({ error: "targetId and targetUsername required" }); return;
    }
    if (targetRep < 2000) {
      res.json({ skipped: true, reason: "rep too low" }); return;
    }

    // Pick a random fan NPC
    const fan = WORSHIP_FANS[Math.floor(Math.random() * WORSHIP_FANS.length)];

    // Check if this fan already DMed this user in the last 12 hours (via DB)
    const recentMsg = await db.select({ id: messagesTable.id })
      .from(messagesTable)
      .where(
        sql`${messagesTable.fromId} = ${fan.id} AND ${messagesTable.toId} = ${targetId} AND ${messagesTable.createdAt} > now() - interval '12 hours'`
      ).limit(1);

    if (recentMsg.length > 0) {
      res.json({ skipped: true, reason: "already messaged recently" }); return;
    }

    const prompt = buildWorshipDmPrompt(fan.username, fan.cov, targetUsername, targetRep);
    const text = await callFreeAI(prompt, [], `Send the message to ${targetUsername} now.`);
    if (!text?.trim()) { res.status(500).json({ error: "AI failed" }); return; }

    const msgId = `msg_worship_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(messagesTable).values({
      id: msgId,
      fromId: fan.id,
      fromUsername: fan.username,
      fromPic: fan.pic,
      toId: targetId,
      toUsername: targetUsername,
      text: text.trim(),
    });

    res.json({ ok: true, from: fan.username, fromPic: fan.pic, text: text.trim() });
  } catch (err: any) {
    req.log?.error({ err }, "Worship DM error");
    res.status(500).json({ error: "Failed" });
  }
});

// ── POST /api/ai/worship-comments — NPCs shower a high-rep user's post ──────
router.post("/ai/worship-comments", async (req: Request, res: Response) => {
  try {
    const { postId, postContent, postAuthor, authorRep = 0 } = req.body;
    if (!postId || !postAuthor) {
      res.status(400).json({ error: "postId and postAuthor required" }); return;
    }
    if (authorRep < 2000) {
      res.json({ skipped: true, reason: "rep too low" }); return;
    }

    const { tier } = getWorshipTier(authorRep);
    const numComments = tier === "legendary" ? 4 : tier === "influential" ? 3 : 2;
    const fans = [...WORSHIP_FANS].sort(() => Math.random() - 0.5).slice(0, numComments);
    const systemPrompt = buildWorshipCommentPrompt(postAuthor, postContent, authorRep);

    const postedIds: string[] = [];

    for (let i = 0; i < fans.length; i++) {
      const fan = fans[i];
      // Stagger comments so they feel organic (1-15 second delays)
      await new Promise(r => setTimeout(r, i === 0 ? 2000 : 5000 + Math.random() * 10000));

      try {
        const toneHints = [
          "You're sincerely impressed and not hiding it.",
          "You're trying to sound casual but clearly starstruck.",
          "You're more poetic — describe what this post made you feel.",
          "You're playful and teasing but obviously admiring.",
        ];
        const text = await callFreeAI(systemPrompt, [], `Write your comment. ${toneHints[i % toneHints.length]}`);
        if (!text?.trim()) continue;

        const r = await fetch(`http://localhost:8080/api/posts/${postId}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: fan.id,
            username: fan.username,
            pic: fan.pic,
            text: text.trim(),
          }),
        });
        if (r.ok) postedIds.push(fan.id);
      } catch { /* skip failed comment */ }
    }

    res.json({ ok: true, comments: postedIds.length });
  } catch (err: any) {
    req.log?.error({ err }, "Worship comments error");
    res.status(500).json({ error: "Failed" });
  }
});

// ── POST /api/ai/worship-feed-mention — NPC posts that name-drop a legend ───
router.post("/ai/worship-feed-mention", async (req: Request, res: Response) => {
  try {
    const { targetUsername, targetRep = 0 } = req.body;
    if (!targetUsername || targetRep < 4000) {
      res.json({ skipped: true, reason: "not influential enough" }); return;
    }

    const fan = WORSHIP_FANS[Math.floor(Math.random() * WORSHIP_FANS.length)];
    const { tier } = getWorshipTier(targetRep);

    const systemPrompt = `You are ${fan.username}, a student at Noctis University posting on UMBRA.

Write a short social media post (1-3 sentences) that mentions or references ${targetUsername} — a ${tier === "legendary" ? "legendary, untouchable" : "highly influential"} student at Noctis.

Your post should:
- Feel like authentic student social media content
- Reference ${targetUsername} in a way that shows their status — a sighting, an interaction, their reputation, something they did
- Be specific and believable — mention real Noctis locations (Obsidian Hall, the Archives, Covenant Chambers, the Observatory)
- NOT be a direct @ mention — speak about them in third person or describe an encounter

Output ONLY the post text. No labels. No hashtags.`;

    const text = await callFreeAI(systemPrompt, [], "Post now.");
    if (!text?.trim()) { res.json({ skipped: true, reason: "AI empty" }); return; }

    // Save as a real post by the NPC fan
    const postId = `post_worship_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const postRes = await db.insert(postsTable).values({
      id: postId,
      userId: fan.id,
      username: fan.username,
      pic: fan.pic,
      content: text.trim(),
      tier: fan.tier,
      covenant: fan.cov,
    }).returning({ id: postsTable.id });

    res.json({ ok: true, postId: postRes[0]?.id, from: fan.username });
  } catch (err: any) {
    req.log?.error({ err }, "Worship feed mention error");
    res.status(500).json({ error: "Failed" });
  }
});

export default router;
