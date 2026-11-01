// Weekly backup: saves every cookbook (recipes, lists, people, shared recipes, feedback) as one compressed
// file in the private "backups" storage bucket, keeps the last 12, and emails you a copy so there's one
// outside Supabase too. Photos aren't included (they're large); they stay in the photos bucket.
// Run it from Supabase → Integrations → Cron (weekly), or by hand from the Edge Functions page.
//
// Secrets (already set for the notify function): RESEND_API_KEY, NOTIFY_EMAIL.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically. Keep "Verify JWT" ON.
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
async function all(c: any, table: string){
  const rows: any[] = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await c.from(table).select('*').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || [])); if (!data || data.length < 1000) break;
  }
  return rows;
}
async function gzip(text: string){
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

Deno.serve(async () => {
  const c = db();
  try {
    const tables = ['households', 'members', 'recipes', 'lists', 'shared_recipes', 'feedback'];
    const out: Record<string, any> = { made: new Date().toISOString(), version: 1 };
    for (const t of tables){ try { out[t] = await all(c, t); } catch (e) { if (t === 'feedback' || t === 'shared_recipes') out[t] = []; else throw e; } }
    // who's who, without passwords
    const users: any[] = [];
    for (let page = 1; page < 50; page++){
      const { data, error } = await c.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break; users.push(...data.users.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, provider: u.app_metadata?.provider })));
      if (data.users.length < 1000) break;
    }
    out.users = users;
    const day = out.made.slice(0, 10);
    const file = await gzip(JSON.stringify(out));
    const name = `spoonbook-backup-${day}.json.gz`;
    const up = await c.storage.from('backups').upload(name, file, { contentType: 'application/gzip', upsert: true });
    if (up.error) throw new Error('saving: ' + up.error.message);
    // keep the newest 12
    const { data: list } = await c.storage.from('backups').list('', { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
    const old = (list || []).filter(f => f.name.startsWith('spoonbook-backup-')).slice(12).map(f => f.name);
    if (old.length) await c.storage.from('backups').remove(old);

    const summary = `${out.households.length} cookbooks, ${out.recipes.length} recipes, ${users.length} people`;
    let emailed = 'not emailed (no RESEND_API_KEY)';
    if (Deno.env.get('RESEND_API_KEY') && file.length < 30e6){
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: Deno.env.get('MAIL_FROM') || 'Spoonbook <onboarding@resend.dev>', to: [Deno.env.get('NOTIFY_EMAIL')],
          subject: `🗄️ Spoonbook backup ${day}`,
          html: `<p style="font-family:system-ui,sans-serif">This week’s backup is attached: ${summary}. A copy is also saved in Supabase (Storage → backups). Keep this email; if anything ever goes wrong, this file can put everything back.</p>`,
          attachments: [{ filename: name, content: b64(file) }] })
      });
      emailed = res.ok ? 'emailed' : 'email failed: ' + await res.text();
    }
    return new Response(JSON.stringify({ ok: true, file: name, size: file.length, summary, emailed }), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
