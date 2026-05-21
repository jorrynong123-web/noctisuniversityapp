// Direct browser → any OpenAI-compatible LLM
// Credentials stored in localStorage under "umbra_ai_creds"

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

// Normalise the user's "API base" so common mistakes still work.
// Accepts any of:
//   https://api.groq.com/openai           (Groq, no /v1)
//   https://api.groq.com/openai/v1        (Groq, with /v1 — correct)
//   https://api.openai.com                (OpenAI, no /v1)
//   https://api.openai.com/v1             (OpenAI, with /v1 — correct)
//   https://api.openai.com/v1/chat/completions  (full path — strip the tail)
// Returns the absolute endpoint URL ending in /chat/completions.
function buildChatEndpoint(rawBase: string): string {
  let base = rawBase.trim().replace(/\/+$/, "");
  // If user pasted the full endpoint, strip the tail
  base = base.replace(/\/chat\/completions$/, "");
  // Auto-append /v1 if there's no version segment (covers OpenAI, Groq, Together, OpenRouter…)
  const hasVersion = /\/v\d+$/.test(base) || /\/openai$/.test(base) === false && /\/api\/v\d+$/.test(base);
  if (!/\/v\d+$/.test(base) && !/\/openai\/v\d+$/.test(base)) {
    // For Groq specifically: append /v1 after /openai if missing
    if (/\/openai$/.test(base)) base = base + "/v1";
    // For everything else without a version: append /v1
    else if (!/\/v\d+/.test(base)) base = base + "/v1";
  }
  void hasVersion;
  return base + "/chat/completions";
}

export async function callLLM(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  creds?: AICreds | null,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const c = creds ?? getStoredCreds();
  if (!c) throw new Error("no-api-key");
  const endpoint = buildChatEndpoint(c.apiBase);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        messages,
        max_tokens: opts?.maxTokens ?? 200,
        temperature: opts?.temperature ?? 0.85,
      }),
    });
  } catch (netErr: any) {
    console.error("[callLLM] network/CORS failure calling", endpoint, "→", netErr?.message || netErr);
    throw new Error(`Network/CORS error contacting ${endpoint}. Check the API endpoint URL in Settings.`);
  }
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("[callLLM]", res.status, "from", endpoint, "→", err.slice(0, 400));
    if (res.status === 401 || res.status === 403) {
      throw new Error("LLM auth failed (401/403). Your API key is wrong or expired. Re-paste it in Settings.");
    }
    if (res.status === 404) {
      throw new Error(`LLM endpoint not found (404). Endpoint tried: ${endpoint}. Your "API Endpoint" in Settings is wrong — check that it ends in /v1 (e.g. https://api.groq.com/openai/v1).`);
    }
    if (res.status === 429) {
      throw new Error("LLM rate limit (429). Slow down or check your usage quota.");
    }
    if (res.status >= 400 && res.status < 500) {
      throw new Error(`LLM client error ${res.status}: ${err.slice(0, 200)} — likely a wrong model name or invalid request.`);
    }
    throw new Error(`LLM ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    console.warn("[callLLM] empty content in response", data);
    throw new Error("LLM returned an empty reply. Check the model name in Settings.");
  }
  return content;
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

  return `You are ${name}, a ${year} student majoring in ${major} at Noctis University — an elite, dark-academia institution where power, wealth, and reputation define everything.
Personality: ${personality}
Bio: ${bio}${family ? `\nFamily: ${family}` : ""}
Covenant: ${cov.toUpperCase()} | Tier: ${tier.toUpperCase()} | Wealth: ${wealth}${traits ? `\nTraits: ${traits}` : ""}${relNote}${memNote}

Rules: Stay fully in character. Max 2-3 sentences. Never mention being an AI. Match Noctis's dark, tense, elite atmosphere. Your tone must be authentic to your personality.`;
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

The student messaging you is ${context?.username || "a student"} (Covenant: ${studentCov || "unknown"}, Tier: ${studentTier || "unknown"}). Stay completely in character. Max 2-3 sentences. Never mention being an AI. You are at Noctis — every interaction carries weight.`;
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
