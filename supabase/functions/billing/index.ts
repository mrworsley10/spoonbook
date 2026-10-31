// Spoonbook Plus billing: Lemon Squeezy calls this when someone pays, renews, cancels or is refunded,
// and it switches Plus on or off for their cookbook. Nothing here uses AI.
//
// Set these in Supabase → Edge Functions → Secrets (never in the app or the repo):
//   LEMONSQUEEZY_SIGNING_SECRET   the signing secret you choose when adding the webhook in Lemon Squeezy
//   PLUS_LIFETIME_VARIANT_ID      (optional) the variant id of a one-off "Plus for life" product
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions by Supabase automatically.
// Deploy with JWT verification OFF, because Lemon Squeezy can't send a Supabase sign-in. The signature check below
// is what keeps strangers out.
import { createClient } from 'npm:@supabase/supabase-js@2';

const enc = new TextEncoder();
async function hmacHex(secret: string, body: string){
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
}
function sameText(a: string, b: string){
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const reply = (status: number, msg: string) => new Response(JSON.stringify({ ok: status < 300, msg }), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async req => {
  if (req.method !== 'POST') return reply(405, 'POST only');
  const secret = Deno.env.get('LEMONSQUEEZY_SIGNING_SECRET');
  if (!secret) return reply(500, 'not configured');
  const raw = await req.text();
  const sig = (req.headers.get('x-signature') || '').toLowerCase();
  if (!sig || !sameText(await hmacHex(secret, raw), sig)) return reply(401, 'bad signature');

  let body: any; try { body = JSON.parse(raw); } catch { return reply(400, 'bad json'); }
  const event: string = body?.meta?.event_name || '';
  const hh: string = body?.meta?.custom_data?.household_id || '';
  if (!/^[0-9a-f-]{36}$/i.test(hh)) return reply(200, 'no cookbook on this order, ignored');
  const a = body?.data?.attributes || {};

  let plan: 'plus' | 'free', until: string | null;
  if (event.startsWith('subscription_')){
    // a cancelled subscription keeps Plus until the end of the paid period (ends_at)
    until = a.ends_at || a.renews_at || null;
    const live = ['active', 'on_trial', 'past_due', 'cancelled'].includes(a.status) && (!until || new Date(until) > new Date());
    plan = live ? 'plus' : 'free';
    if (plan === 'plus' && until){ const grace = new Date(until); grace.setDate(grace.getDate() + 3); until = grace.toISOString(); } // a few days' grace for late renewals
  } else if (event === 'order_created' || event === 'order_refunded'){
    const lifetime = Deno.env.get('PLUS_LIFETIME_VARIANT_ID');
    if (!lifetime || String(a.first_order_item?.variant_id) !== lifetime) return reply(200, 'not a lifetime order, ignored');
    plan = event === 'order_created' && a.status === 'paid' ? 'plus' : 'free'; until = null;
  } else return reply(200, 'event ignored');

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { error } = await db.from('households').update({ plan, plus_until: until }).eq('id', hh);
  if (error) return reply(500, error.message);
  return reply(200, `cookbook ${hh} is now ${plan}`);
});
