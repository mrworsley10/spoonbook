// Spoonbook "ai" function: lets signed-in members of a cookbook ask Claude for structured JSON
// (reading a recipe from text or a photo, sorting the shopping list, estimating calories).
// It stays switched off until you add a secret called ANTHROPIC_API_KEY in Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// New Supabase projects may only have the new-style keys, so fall back to the publishable one.
function anonKey(): string {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacy) return legacy;
  try { const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}"); return keys.default ?? Object.values(keys)[0] ?? ""; } catch { return ""; }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5" } as const;
const MAX_PROMPT = 60_000;
const MAX_IMAGES = 4;

function parseJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const a = Math.min(...["{", "["].map((c) => t.indexOf(c)).filter((i) => i >= 0));
  const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (isFinite(a) && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("no_json");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (req.method === "GET") return json({ enabled: !!key });
  if (!key) return json({ error: "not_configured" }, 501);

  // Only signed-in people may spend the household's Claude credit.
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, anonKey(), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401);
  const { count } = await supa.from("members").select("*", { count: "exact", head: true }).eq("user_id", user.id);
  if (!count) return json({ error: "no_cookbook" }, 403);

  let body: { prompt?: string; images?: { type: string; data: string }[]; tier?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const prompt = String(body.prompt ?? "");
  if (!prompt || prompt.length > MAX_PROMPT) return json({ error: "bad_request" }, 400);
  const images = (body.images ?? []).slice(0, MAX_IMAGES).filter((i) => /^image\/(jpeg|png|webp|gif)$/.test(i.type));

  const content = [
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.type, data: i.data } })),
    { type: "text", text: prompt + "\n\nYour reply will be read by a program: reply with only the JSON, no other text." },
  ];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: body.tier === "quick" ? MODELS.quick : MODELS.default,
      max_tokens: 4000,
      messages: [{ role: "user", content }],
    }),
  });
  if (r.status === 429) return json({ error: "rate_limited" }, 429);
  if (!r.ok) return json({ error: "upstream_error", detail: (await r.text()).slice(0, 300) }, 502);
  const out = await r.json();
  const text = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  try { return json({ result: parseJson(text) }); } catch { return json({ error: "invalid_json", text: text.slice(0, 2000) }, 422); }
});
