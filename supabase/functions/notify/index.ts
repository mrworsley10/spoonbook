// Emails you whenever someone new joins Spoonbook (a new cookbook, or someone joining one), and when
// someone sends feedback from the app.
// It's started by a Supabase Database Webhook on the "members" table and sends the email through Resend's free plan.
// Nothing here uses AI.
//
// Secrets (Supabase → Edge Functions → Secrets, never in the repo):
//   RESEND_API_KEY   from resend.com → API Keys
//   NOTIFY_EMAIL     where to send the alerts (must be the email you signed up to Resend with,
//   MAIL_FROM        (optional) who the emails come from once your domain is verified in Resend,
//                    e.g. Spoonbook <hello@spoonbook.co.uk>. Without it, Resend's test address is used.
//                    until you verify your own domain there)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically.
// Keep "Verify JWT" ON: the webhook sends Supabase's own key, so strangers can't trigger emails.
import { createClient } from 'npm:@supabase/supabase-js@2';

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const send = (subject: string, html: string) => fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'content-type': 'application/json' },
  body: JSON.stringify({ from: Deno.env.get('MAIL_FROM') || 'Spoonbook <hello@spoonbook.co.uk>', to: [Deno.env.get('NOTIFY_EMAIL')], subject, html })
});
// feedback sent from the app (⋯ → Send feedback)
async function feedback(f: any){
  const res = await send(`💬 Spoonbook feedback from ${f.name || 'someone'}`, `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">
    <p style="white-space:pre-wrap">${esc(f.message)}</p><p style="color:#666;font-size:13px">${esc(f.name || '')} · ${esc(f.app || '')}</p></div>`);
  return new Response(res.ok ? 'sent' : 'email failed: ' + await res.text(), { status: res.ok ? 200 : 502 });
}

Deno.serve(async req => {
  let body: any; try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  if (body?.type !== 'INSERT' || !['members', 'feedback'].includes(body?.table)) return new Response('ignored');
  if (body.table === 'feedback') return feedback(body.record || {});
  const m = body.record || {};
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const [{ data: u }, { data: hh }, { data: all }, users, books] = await Promise.all([
    db.auth.admin.getUserById(m.user_id),
    db.from('households').select('name, created_by').eq('id', m.household_id).maybeSingle(),
    db.from('members').select('display_name, user_id').eq('household_id', m.household_id),
    db.from('members').select('user_id', { count: 'exact', head: true }),
    db.from('households').select('id', { count: 'exact', head: true })
  ]);
  const email = u?.user?.email || 'unknown email';
  const via = u?.user?.app_metadata?.provider === 'google' ? 'Google' : 'email and password';
  const others = (all || []).filter(x => x.user_id !== m.user_id).map(x => x.display_name || 'someone');
  const name = m.display_name || 'Someone';
  const what = others.length ? `joined ${esc(others.join(' and '))}’s cookbook` : 'started a new cookbook';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('MAIL_FROM') || 'Spoonbook <hello@spoonbook.co.uk>',
      to: [Deno.env.get('NOTIFY_EMAIL')],
      subject: `🥄 ${name} ${others.length ? 'joined a cookbook' : 'started a cookbook'} on Spoonbook`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">
        <p><b>${esc(name)}</b> ${what}.</p>
        <p style="color:#666">${esc(email)} · signed up with ${via}${hh?.name ? ` · cookbook “${esc(hh.name)}”` : ''}</p>
        <p>Spoonbook now has <b>${users.count ?? '?'}</b> people in <b>${books.count ?? '?'}</b> cookbooks.</p></div>`
    })
  });
  return new Response(res.ok ? 'sent' : 'email failed: ' + await res.text(), { status: res.ok ? 200 : 502 });
});
