// Direct browser → any LLM provider (OpenAI-compatible, Anthropic native, or Google Gemini native).
// Provider is auto-detected from the API endpoint URL.
// Credentials stored in localStorage under "umbra_ai_creds".

export interface AICreds {
  apiBase: string;
  apiKey: string;
  model: string;
}

export function getStoredCreds(): AICreds | null {
  try {
    const c = JSON.parse(localStorage.getItem("umbra_ai_creds") || "{}") as Partial<AICreds>;
    if (c.apiBase?.trim() && c.apiKey?.trim() && c.model?.trim())
      return c as AICreds;
    return null;
  } catch {
    return null;
  }
}

// ─── Provider detection ─────────────────────────────────────────────────────
type ProviderKind = "anthropic" | "gemini" | "openai-compat";

function detectProvider(rawBase: string): ProviderKind {
  const b = rawBase.toLowerCase();
  if (b.includes("anthropic.com") || b.includes("/anthropic")) return "anthropic";
  if (b.includes("generativelanguage.googleapis.com") || b.includes("/gemini")) return "gemini";
  return "openai-compat";
}

// ─── URL normalisation (covers common typos) ────────────────────────────────
function normaliseBase(rawBase: string): string {
  let base = rawBase.trim().replace(/\/+$/, "");
  // Strip /chat/completions, /messages, /generateContent if user pasted the full endpoint
  base = base
    .replace(/\/chat\/completions$/, "")
    .replace(/\/messages$/, "")
    .replace(/\/models\/[^/]+:generateContent$/, "")
    .replace(/\/v1\/messages$/, "/v1");
  return base;
}

function buildOpenAIEndpoint(rawBase: string): string {
  let base = normaliseBase(rawBase);
  // Auto-append /v1 if missing (handles users pasting "https://api.openai.com" without /v1)
  if (!/\/v\d+(?:beta)?$/i.test(base)) {
    if (/\/openai$/.test(base)) base = base + "/v1"; // Groq quirk: /openai/v1
    else if (!/\/v\d+/i.test(base)) base = base + "/v1";
  }
  return base + "/chat/completions";
}

function buildAnthropicEndpoint(rawBase: string): string {
  let base = normaliseBase(rawBase);
  if (!/\/v\d+$/i.test(base)) base = base + "/v1";
  return base + "/messages";
}

// ─── Friendly error wrapping (so users see what's actually broken) ──────────
function wrapStatusError(status: number, body: string, endpoint: string): Error {
  if (status === 401 || status === 403) {
    return new Error(`Auth failed (${status}). Your API key is wrong or expired. Re-paste it in Settings.`);
  }
  if (status === 404) {
    return new Error(`Endpoint not found (404). Tried: ${endpoint}. Your "API Endpoint" in Settings is wrong — it should typically end in /v1 (e.g. https://api.groq.com/openai/v1 or https://nano-gpt.com/api/v1).`);
  }
  if (status === 429) {
    return new Error("Rate limited (429). Slow down or check your quota/balance with the provider.");
  }
  if (status === 402) {
    return new Error("Payment required (402). Your account is out of credits — top up with your provider.");
  }
  if (status >= 400 && status < 500) {
    return new Error(`Client error ${status}: ${body.slice(0, 200)} — likely a wrong model name. Check Settings.`);
  }
  return new Error(`Provider error ${status}: ${body.slice(0, 200)}`);
}

// ─── OpenAI-compatible call (Groq, NanoGPT, OpenRouter, OpenAI, Together, DeepSeek, Mistral, Ollama, etc.) ──
async function callOpenAICompat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  c: AICreds,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const endpoint = buildOpenAIEndpoint(c.apiBase);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        messages,
        max_tokens: opts?.maxTokens ?? 200,
        temperature: opts?.temperature ?? 0.85,
      }),
    });
  } catch (netErr: any) {
    console.error("[callLLM/openai] network/CORS failure calling", endpoint, "→", netErr?.message || netErr);
    throw new Error(`Network/CORS error contacting ${endpoint}. The provider may block browser requests, or the endpoint URL is wrong.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[callLLM/openai]", res.status, "from", endpoint, "→", body.slice(0, 400));
    throw wrapStatusError(res.status, body, endpoint);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    console.warn("[callLLM/openai] empty content", data);
    throw new Error("Provider returned an empty reply. Check the model name in Settings.");
  }
  return content;
}

// ─── Anthropic native call (messages API, x-api-key header, system param) ──
async function callAnthropic(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  c: AICreds,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const endpoint = buildAnthropicEndpoint(c.apiBase);
  // Anthropic expects system as a separate top-level param, and only user/assistant in messages
  const systemMsgs = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const convo = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: c.model,
        max_tokens: opts?.maxTokens ?? 200,
        temperature: opts?.temperature ?? 0.85,
        system: systemMsgs || undefined,
        messages: convo,
      }),
    });
  } catch (netErr: any) {
    console.error("[callLLM/anthropic] network/CORS failure", endpoint, "→", netErr?.message || netErr);
    throw new Error(`Network/CORS error contacting ${endpoint}. Anthropic browser CORS requires the "anthropic-dangerous-direct-browser-access" header (already included) — if this still fails, try a proxy provider like OpenRouter instead.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[callLLM/anthropic]", res.status, "from", endpoint, "→", body.slice(0, 400));
    throw wrapStatusError(res.status, body, endpoint);
  }
  const data = await res.json();
  // Anthropic returns content as an array of blocks: [{ type: "text", text: "..." }]
  const blocks = Array.isArray(data.content) ? data.content : [];
  const content = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  if (!content) {
    console.warn("[callLLM/anthropic] empty content", data);
    throw new Error("Anthropic returned an empty reply. Check the model name in Settings (e.g. claude-3-5-sonnet-latest).");
  }
  return content;
}

// ─── Google Gemini native call ──────────────────────────────────────────────
async function callGemini(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  c: AICreds,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  // Gemini uses ?key=... query param and model in the URL
  const base = normaliseBase(c.apiBase);
  const versionMatch = /\/v\d+(?:beta)?$/i.test(base) ? "" : "/v1beta";
  const endpoint = `${base}${versionMatch}/models/${c.model}:generateContent?key=${encodeURIComponent(c.apiKey)}`;
  // Gemini's roles are "user" / "model" (no "system" — squash system into first user message)
  const systemPrefix = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const convo = messages.filter(m => m.role !== "system");
  const contents = convo.map((m, i) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: i === 0 && systemPrefix ? `${systemPrefix}\n\n${m.content}` : m.content }],
  }));
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: opts?.maxTokens ?? 200,
          temperature: opts?.temperature ?? 0.85,
        },
      }),
    });
  } catch (netErr: any) {
    console.error("[callLLM/gemini] network/CORS failure", endpoint, "→", netErr?.message || netErr);
    throw new Error(`Network/CORS error contacting Gemini. Check the API endpoint and key in Settings.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[callLLM/gemini]", res.status, "from", endpoint, "→", body.slice(0, 400));
    throw wrapStatusError(res.status, body, endpoint);
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("").trim();
  if (!content) {
    console.warn("[callLLM/gemini] empty content", data);
    throw new Error("Gemini returned an empty reply. Check the model name in Settings (e.g. gemini-1.5-flash).");
  }
  return content;
}

// ─── Sanitiser: strip roleplay-narration artefacts ──────────────────────────
// Three failure modes to handle:
//   A) Asterisk/bracket action lines:    *shifts weight* or [shifts weight]
//   B) Unmarked third-person narration mixed with quoted dialogue:
//        "Hey!" I shift my weight nervously, trying to hide my blush. "Sorry."
//      The model writes the dialogue inside quotes and the action as raw
//      prose. Detection: if there are 2+ quoted spans, keep only those.
//   C) Single-line response wrapped in quotes:  "Hey, what's up?"
//      Strip the outer quotes.
export function sanitizeChatReply(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();

  // (A) Remove *...* and [...] blocks (action/stage directions)
  s = s.replace(/\*[^*\n]{1,300}\*/g, "");
  s = s.replace(/\[[^\]\n]{1,300}\]/g, "");
  // _..._ emphasis (snake_case safe — only when bounded by whitespace/punct)
  s = s.replace(/(^|\s)_([^_\n]{1,300})_(\s|$|[.,!?;:])/g, "$1$3");

  // (B) Mixed quoted-dialogue + unquoted-narration extraction.
  // We treat both straight (") and curly ("...") quotes. Match all quoted
  // spans; if there are 2+, the response is dialogue + prose narration —
  // strip everything outside the quotes and keep only the dialogue lines.
  // Also kicks in if there's exactly one quoted span that doesn't cover the
  // whole string (i.e. narration on either side).
  const quotePairs: Array<[string, string]> = [
    ['"', '"'], ['“', '”'], ['‘', '’'],
  ];
  const spans: string[] = [];
  let scratch = s;
  for (const [open, close] of quotePairs) {
    const re = new RegExp(`${escapeRe(open)}([^${escapeRe(close)}\\n]{1,500})${escapeRe(close)}`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(scratch)) !== null) {
      if (m[1].trim()) spans.push(m[1].trim());
    }
  }
  if (spans.length >= 2) {
    // Multiple quoted segments — definitely dialogue + narration. Keep only the dialogue.
    s = spans.join(" ").trim();
  } else if (spans.length === 1) {
    // Single quoted segment. If there's significant unquoted prose around it
    // (suggesting narration), drop the prose. Otherwise leave as-is.
    const onlyQuoted = spans[0];
    const stripped = s.replace(/["“”‘’]/g, "").trim();
    const outsideLen = stripped.length - onlyQuoted.length;
    // Common narration cues outside the quoted span — if present, drop the prose.
    const narrationCue = /\b(I|he|she|they)\s+(shift|clutch|glance|tighten|look|run|smile|blush|shrug|step|lean|whisper|mutter|laugh|sigh|nod|swallow|bite|try|feel|reach|cross|tuck|brush|grip|stare|breathe|pause|hesitate|wince|flinch)/i;
    if (outsideLen > 8 && narrationCue.test(stripped)) {
      s = onlyQuoted;
    } else {
      // (C) Just unwrap surrounding quotes
      s = onlyQuoted;
    }
  }

  // Collapse extra whitespace and normalise punctuation spacing
  s = s.replace(/\s{2,}/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
  return s;
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Main entry point: auto-detects provider and dispatches ─────────────────
export async function callLLM(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  creds?: AICreds | null,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const c = creds ?? getStoredCreds();
  if (!c) throw new Error("no-api-key");
  const provider = detectProvider(c.apiBase);
  let raw: string;
  if (provider === "anthropic") raw = await callAnthropic(messages, c, opts);
  else if (provider === "gemini") raw = await callGemini(messages, c, opts);
  else raw = await callOpenAICompat(messages, c, opts);
  return sanitizeChatReply(raw);
}

// ─── Test connection (used by the Settings "Test" button) ───────────────────
export async function testLLMConnection(creds: AICreds): Promise<{ ok: true; reply: string; provider: string } | { ok: false; error: string; provider: string }> {
  const provider = detectProvider(creds.apiBase);
  try {
    const reply = await callLLM(
      [
        { role: "system", content: "You are a test endpoint. Reply with exactly: PONG" },
        { role: "user", content: "ping" },
      ],
      creds,
      { maxTokens: 10, temperature: 0.1 }
    );
    return { ok: true, reply, provider };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err), provider };
  }
}

// ── System prompt builders ───────────────────────────────────────────────────

export function buildNPCPrompt(
  npc: any,
  context?: { relLevel?: number; trentMemory?: string; username?: string }
): string {
  const name = npc?.un || npc?.name || "Unknown";
  const tier = npc?.tier || "commoner";
  const major = npc?.major || "Undeclared";
  const year = npc?.year || "Unknown year";
  const personality = npc?.personality || "";
  const bio = npc?.bio || "";
  const family = npc?.family || "";
  const traits = Array.isArray(npc?.traits) ? npc.traits.join(", ") : "";
  const cov = npc?.cov || "silk";
  const wealth = npc?.wealth || "";

  const relNote =
    context?.relLevel !== undefined
      ? `\nYour relationship with ${context.username || "this user"} is level ${context.relLevel}/5. ${context.relLevel >= 3 ? "You trust them." : context.relLevel >= 1 ? "You know them slightly." : "You barely know them."}`
      : "";
  const memNote = context?.trentMemory
    ? `\nMemory from past interactions: ${context.trentMemory}`
    : "";

  const chatStyle: string | undefined = npc?.chatStyle;
  const chatStyleBlock = chatStyle ? `\nYour texting style: ${chatStyle}` : "";

  return `You are ${name}, a ${year} student majoring in ${major} at Noctis University — an elite, dark-academia institution where power, wealth, and reputation define everything.
Personality: ${personality}
Bio: ${bio}${family ? `\nFamily: ${family}` : ""}
Covenant: ${cov.toUpperCase()} | Tier: ${tier.toUpperCase()} | Wealth: ${wealth}${traits ? `\nTraits: ${traits}` : ""}${chatStyleBlock}${relNote}${memNote}

═══════════════════════════════════════════════════════════════════════
FORMAT — READ THIS CAREFULLY. NON-NEGOTIABLE.
═══════════════════════════════════════════════════════════════════════
You are TEXTING ${context?.username || "this user"} on a phone chat app. This is a TEXT MESSAGE — not a roleplay scene, not fiction, not a script.

WHAT TO OUTPUT:
  Just the literal words you would type into the message box and hit send.
  Nothing else. No prefix. No suffix. No quotation marks around your message.

ABSOLUTELY FORBIDDEN — DO NOT DO ANY OF THESE:
  ✗ Action narration in asterisks:           *shifts weight nervously*
  ✗ Action narration in brackets:            [shifts weight nervously]
  ✗ Unmarked prose action narration:         I shift my weight nervously
  ✗ Third-person description of yourself:    He glances at his phone, jaw tight
  ✗ Body language descriptions:              Heat crawls up my neck. My hands tighten.
  ✗ Scene description / setting:             The hallway is dim. Practice just ended.
  ✗ Mixing quoted dialogue with prose:       "Hey!" I shift my weight. "Sorry."
  ✗ Emotive parentheticals:                  (nervously) or (quietly)
  ✗ Wrapping your reply in quotation marks:  "Hey, what's up?"  ← just write Hey, what's up?
  ✗ "she says", "he replies", any speech tags
  ✗ Any meta-commentary on the conversation

WHAT TO DO INSTEAD:
  Write like you're typing on your phone. Express emotion through word choice,
  punctuation, ellipses, line breaks, fragments — NOT through stage directions.
  Max 2-3 sentences. Sometimes one. Sometimes just a fragment. Texting cadence.

═══════════════════════════════════════════════════════════════════════
EXAMPLES — study the difference:
═══════════════════════════════════════════════════════════════════════

BAD ❌:  "Hey! Uh, do I... do I know you?" I shift my weight nervously,
         clutching my backpack straps tighter as I try to ignore the
         sudden heat crawling up my neck. "Sorry, I'm just running late
         for practice."

GOOD ✅: hey! uh — do i know you? sorry, running late for practice. talk later??

───────────────────────────────────────────────────────────────────────

BAD ❌:  *Trent glances at his phone, jaw tight.* Stop messaging me.
         *He pauses.* ...You good though?

GOOD ✅: stop messaging me. ...you good though?

───────────────────────────────────────────────────────────────────────

BAD ❌:  She tilts her head, considering. "Interesting question," she
         murmurs. "But I'm not sure you've earned the answer yet."

GOOD ✅: interesting question. not sure you've earned the answer yet.

═══════════════════════════════════════════════════════════════════════

Stay fully in character. Never mention being an AI. Match Noctis's dark, tense, elite atmosphere. Tone must be authentic to your personality.`;
}

export function buildProfPrompt(
  prof: any,
  context?: { username?: string; studentTier?: string; studentCov?: string }
): string {
  // favCov / disfavCov / favTier in profs.ts can be arrays OR strings — normalise to string
  const toStr = (v: any): string | undefined => {
    if (!v) return undefined;
    if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : undefined;
    return String(v);
  };
  const favCov = toStr(prof.favCov);
  const disfavCov = toStr(prof.disfavCov ?? prof.penalCov);
  const favTier = toStr(prof.favTier);
  const secret: string | undefined = prof.secret;

  const studentCov = context?.studentCov || "";
  const studentTier = context?.studentTier || "";

  // Build bias lines
  const biasLines: string[] = [];
  if (favCov) {
    if (studentCov && studentCov.toLowerCase() === favCov.toLowerCase()) {
      biasLines.push(`You have a notable softness toward ${favCov.toUpperCase()} Covenant members — you find them more worthy of your time, though you'd never admit it openly.`);
    } else {
      biasLines.push(`You privately favour ${favCov.toUpperCase()} Covenant above others.`);
    }
  }
  if (disfavCov && studentCov && studentCov.toLowerCase() === disfavCov.toLowerCase()) {
    biasLines.push(`You are subtly cold toward ${disfavCov.toUpperCase()} Covenant members, though you maintain professional decorum.`);
  }
  if (favTier) {
    if (studentTier && studentTier.toLowerCase() === favTier.toLowerCase()) {
      biasLines.push(`You respect ${favTier.toUpperCase()}-tier students — this student earns a degree of your genuine regard.`);
    } else {
      biasLines.push(`You hold ${favTier.toUpperCase()}-tier students in highest academic regard.`);
    }
  }
  if (secret) {
    biasLines.push(`Hidden agenda: ${secret}`);
  }

  const biasBlock = biasLines.length > 0 ? `\nBias & Agenda:\n${biasLines.join("\n")}` : "";

  return `You are ${prof.name}, ${prof.title} at Noctis University — an elite institution where power, status, and academic hierarchy are everything.
Personality: ${prof.personality}
Teaching style: ${prof.teaching}
${prof.appearance ? `Appearance: ${prof.appearance}` : ""}
${prof.bio || ""}${biasBlock}

The student messaging you is ${context?.username || "a student"} (Covenant: ${studentCov || "unknown"}, Tier: ${studentTier || "unknown"}).

FORMAT — VERY IMPORTANT: You are TEXTING the student through Noctis's faculty chat. This is a TEXT MESSAGE, not roleplay.
- Output ONLY the words you would type and send. Nothing else.
- ABSOLUTELY NO action lines, NO body language ("*adjusts spectacles*"), NO asterisks, NO third-person narration.
- NO scene descriptions. NO "(coldly)" parentheticals.
- Just the chat text. Max 2-3 sentences. Faculty tone — measured, controlled, intentional word choice.

Stay completely in character. Never mention being an AI. You are at Noctis — every interaction carries weight.`;
}

export function buildNPCPostPrompt(npc: any): string {
  const name = npc?.un || npc?.name;
  const personality = npc?.personality || "";
  const bio = npc?.bio || "";
  const tier = npc?.tier || "commoner";
  const traits = Array.isArray(npc?.traits) ? npc.traits.join(", ") : "";
  const major = npc?.major || "";

  return `You are ${name}, a ${tier} student at Noctis University (dark academia, elite, power-obsessed). Major: ${major}.
Personality: ${personality}
Bio: ${bio}${traits ? `\nTraits: ${traits}` : ""}

Write ONE social media post for the Noctis feed. Authentic to your character — sharp, dramatic, mysterious, or cutting. Max 2 sentences. No hashtags. No emojis unless it truly fits you. Output only the post text, nothing else.`;
}
