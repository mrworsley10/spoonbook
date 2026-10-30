// Spoonbook "clip" function: given a recipe web page, pulls out the recipe and its main photo.
// Most recipe sites embed the recipe as structured data (schema.org Recipe), which is read here
// without any AI. The photo is copied into the household's photo folder.
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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Any = Record<string, unknown>;
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

const decode = (s: string) => s
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, " ").trim();

function findRecipe(node: unknown): Any | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const o = node as Any; const t = o["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return o;
  for (const k of ["@graph", "mainEntity", "itemListElement"]) { const r = findRecipe(o[k]); if (r) return r; }
  return null;
}
function steps(ins: unknown): string[] {
  if (!ins) return [];
  if (typeof ins === "string") return ins.split(/\n+|(?<=\.)\s{2,}/).map(decode).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(steps);
  const o = ins as Any;
  if (o.itemListElement) return steps(o.itemListElement);
  if (o.text) return [decode(String(o.text))];
  if (o.name) return [decode(String(o.name))];
  return [];
}
function minutes(iso: unknown): number | null {
  const m = String(iso ?? "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const v = (+(m[1] ?? 0)) * 1440 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
  return v || null;
}
function imageUrl(img: unknown): string | null {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return imageUrl(img[img.length > 1 ? img.length - 1 : 0]) ?? imageUrl(img[0]);
  const o = img as Any; return (o.url as string) ?? (o["@id"] as string) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, anonKey(), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401);

  let body: { url?: string; household?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  let url: URL;
  try { url = new URL(String(body.url)); if (!/^https?:$/.test(url.protocol)) throw 0; } catch { return json({ error: "bad_url" }, 400); }
  const hh = String(body.household ?? "");
  const { data: isMember } = await supa.rpc("is_member", { hh });
  if (!isMember) return json({ error: "no_cookbook" }, 403);

  let html: string;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
    if (!r.ok) return json({ error: "page_unreachable", status: r.status }, 502);
    html = (await r.text()).slice(0, 3_000_000);
  } catch { return json({ error: "page_unreachable" }, 502); }

  let recipe: Any | null = null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { recipe = findRecipe(JSON.parse(m[1].trim())); } catch { /* skip broken blocks */ }
    if (recipe) break;
  }
  if (!recipe) {
    const text = decode(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")).slice(0, 40_000);
    const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    return json({ error: "no_recipe_data", title, text }, 422);
  }

  const draft = {
    title: decode(String(recipe.name ?? "")).slice(0, 140),
    ingredients: ((recipe.recipeIngredient ?? recipe.ingredients ?? []) as unknown[]).map((x) => decode(String(x))).filter(Boolean),
    steps: steps(recipe.recipeInstructions),
    serves: (() => { const y = Array.isArray(recipe!.recipeYield) ? recipe!.recipeYield[0] : recipe!.recipeYield; return y ? decode(String(y)).replace(/^serves\s*/i, "") : ""; })(),
    totalMins: minutes(recipe.totalTime) ?? ((minutes(recipe.prepTime) ?? 0) + (minutes(recipe.cookTime) ?? 0) || null),
    source: url.toString(),
    photo: null as string | null,
  };

  // Copy the main photo into the household's folder, so it keeps working if the site changes.
  const src = imageUrl(recipe.image);
  if (src) {
    try {
      const ir = await fetch(new URL(src, url), { headers: { "User-Agent": UA } });
      const type = (ir.headers.get("content-type") ?? "").split(";")[0];
      if (ir.ok && /^image\/(jpeg|png|webp)$/.test(type)) {
        const bytes = new Uint8Array(await ir.arrayBuffer());
        if (bytes.length < 8_000_000) {
          const path = `${hh}/${crypto.randomUUID()}.${type.split("/")[1].replace("jpeg", "jpg")}`;
          const { error } = await supa.storage.from("photos").upload(path, bytes, { contentType: type });
          if (!error) draft.photo = path;
        }
      }
    } catch { /* a recipe without its photo is still useful */ }
  }
  return json({ recipe: draft });
});
