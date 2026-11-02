// Spoonbook "photos" function: finds free stock photos of a dish on Pexels, and copies the one you pick into
// your cookbook's photo folder. No AI: it's an ordinary search.
//
// Secret (Supabase → Edge Functions → Secrets, never in the repo):
//   PEXELS_API_KEY   from pexels.com/api (free)
// Pexels asks apps to show "Photos provided by Pexels" and to credit the photographer; Spoonbook does both.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

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

type Photo = { id: number; alt?: string; photographer?: string; photographer_url?: string; url?: string; src?: Record<string, string> };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, anonKey(), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401);
  const key = Deno.env.get("PEXELS_API_KEY");
  if (!key) return json({ error: "not_set_up" }, 503);

  let body: { action?: string; q?: string; id?: number; household?: string; page?: number };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  // search: a page of photos for the words given
  if (body.action === "search") {
    const q = String(body.q ?? "").trim().slice(0, 80);
    if (!q) return json({ photos: [] });
    const page = Math.min(Math.max(1, Number(body.page) || 1), 10);
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q + " food")}&per_page=12&page=${page}&orientation=landscape`, { headers: { Authorization: key } });
    if (r.status === 429) return json({ error: "busy" }, 429);
    if (!r.ok) return json({ error: "search_failed" }, 502);
    const data = await r.json() as { photos?: Photo[] };
    return json({ photos: (data.photos ?? []).map((p) => ({ id: p.id, thumb: p.src?.medium, alt: p.alt ?? "", by: p.photographer ?? "", byUrl: p.photographer_url ?? "", url: p.url ?? "" })) });
  }

  // use: copy the chosen photo into the cookbook, so it keeps working whatever happens on Pexels
  if (body.action === "use") {
    const hh = String(body.household ?? "");
    const { data: isMember } = await supa.rpc("is_member", { hh });
    if (!isMember) return json({ error: "no_cookbook" }, 403);
    const r = await fetch(`https://api.pexels.com/v1/photos/${Number(body.id)}`, { headers: { Authorization: key } });
    if (!r.ok) return json({ error: "not_found" }, 404);
    const p = await r.json() as Photo;
    const src = p.src?.large2x ?? p.src?.large ?? p.src?.original;
    if (!src) return json({ error: "not_found" }, 404);
    const ir = await fetch(src);
    const type = (ir.headers.get("content-type") ?? "image/jpeg").split(";")[0];
    if (!ir.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "download_failed" }, 502);
    const bytes = new Uint8Array(await ir.arrayBuffer());
    if (bytes.length > 8_000_000) return json({ error: "too_large" }, 413);
    const path = `${hh}/${crypto.randomUUID()}.${type.split("/")[1].replace("jpeg", "jpg")}`;
    const { error } = await supa.storage.from("photos").upload(path, bytes, { contentType: type });
    if (error) return json({ error: "upload_failed" }, 500);
    return json({ path, credit: { by: p.photographer ?? "", byUrl: p.photographer_url ?? "", url: p.url ?? "", site: "Pexels" } });
  }
  return json({ error: "bad_request" }, 400);
});
