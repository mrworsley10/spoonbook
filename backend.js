/* Spoonbook ↔ Supabase.
   The app was first built inside Claude, where storage, photos and people came from Claude's runtime.
   This file gives the app the same small interfaces (db, assets, user, downloads), backed by
   Supabase instead, plus the sign-in and "join a cookbook" screens. Nothing here uses AI. */
(() => {
const CFG = window.SPOONBOOK_CONFIG || {};
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o ?? {}));
function merge(a, b){ for (const k in b){ const v = b[k]; if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v); else a[k] = v; } return a; }
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
const store = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch {} } };

let session = null, household = null, members = [], plan = null;
const rerender = () => window.__spoonbookRender?.();

/* ---------- working with no signal ----------
   The last good copy of the cookbook is kept on the phone, so Spoonbook opens and works with no signal.
   Changes made while offline wait in an outbox and are sent as soon as the connection comes back. */
let offline = false, pending = 0;
const isNetErr = e => !navigator.onLine || /fetch|network|load failed|timed? ?out|aborted/i.test(String(e?.message || e || ''));
const isAuthErr = e => /jwt|auth|401/i.test(String(e?.message || e?.code || ''));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
const cacheKey = uid => 'sb-offline-' + uid;
function readCache(uid){ try { return JSON.parse(store.get(cacheKey(uid)) || 'null'); } catch { return null; } }
function setOffline(v){ if (offline !== v){ offline = v; rerender(); } }
function storedSession(){
  try { const k = Object.keys(localStorage).find(k => /^sb-.*-auth-token$/.test(k)); const s = k && JSON.parse(localStorage.getItem(k)); return s?.user?.id ? s : null; } catch { return null; }
}
addEventListener('offline', () => setOffline(true));

/* ---------- photos: private bucket, shown through signed links cached for a few days ---------- */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
let urlCache = {}; try { urlCache = JSON.parse(store.get('sb-photo-urls') || '{}'); } catch {}
const wanted = new Set(); let fetchTimer = null;
function photoUrl(path){
  if (!path) return BLANK;
  const hit = urlCache[path];
  if (hit && hit.exp > Date.now()) return hit.url;
  if (navigator.onLine){ wanted.add(path); clearTimeout(fetchTimer); fetchTimer = setTimeout(fetchUrls, 30); }
  // an old link still works offline: the phone keeps each photo it has shown, whatever the link says
  return hit ? hit.url : BLANK;
}
async function fetchUrls(){
  const paths = [...wanted]; wanted.clear(); if (!paths.length) return;
  for (let i = 0; i < paths.length; i += 100){
    const { data, error } = await sb.storage.from('photos').createSignedUrls(paths.slice(i, i + 100), 7 * 86400);
    if (error) continue;
    for (const d of data || []) if (d.signedUrl) urlCache[d.path] = { url: d.signedUrl, exp: Date.now() + 6 * 86400000 };
  }
  store.set('sb-photo-urls', JSON.stringify(urlCache));
  rerender();
}

/* ---------- db: the same doc/collection calls the app already makes ---------- */
function makeDb(hh, uid, cached){
  const rows = { recipes: new Map(Object.entries(cached?.recipes || {})), lists: new Map(Object.entries(cached?.lists || {})) };
  const listeners = { recipes: new Set(), lists: new Map() };
  const snap = (id, d) => ({ id, exists: !!d, data: () => d && clone(d) });
  let saveTimer = null;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set(cacheKey(uid), JSON.stringify({ household, members, recipes: Object.fromEntries(rows.recipes), lists: Object.fromEntries(rows.lists), at: Date.now() })), 500); };
  const emitRecipes = () => { const docs = [...rows.recipes].map(([id, d]) => snap(id, d)); listeners.recipes.forEach(cb => cb({ docs })); persist(); };
  const emitList = id => { (listeners.lists.get(id) || new Set()).forEach(cb => cb(snap(id, rows.lists.get(id)))); persist(); };
  const emit = (table, id) => table === 'recipes' ? emitRecipes() : emitList(id);

  // the outbox: changes waiting for a connection, oldest first, one entry per row (the latest wins)
  const OUT = 'sb-outbox-' + hh;
  let outbox = []; try { outbox = JSON.parse(store.get(OUT) || '[]'); } catch {}
  const saveOut = () => { store.set(OUT, JSON.stringify(outbox)); if (pending !== outbox.length){ pending = outbox.length; rerender(); } };
  pending = outbox.length;
  function queue(job){ const i = outbox.findIndex(j => j.table === job.table && j.id === job.id); if (i >= 0) outbox[i] = job; else outbox.push(job); saveOut(); setOffline(true); }
  let flushing = null;
  function flush(){
    if (!outbox.length) return Promise.resolve();
    return flushing = flushing || (async () => {
      try {
        await sb.auth.getSession(); // refreshes the sign-in first if it ran out while offline
        while (outbox.length){
          const j = outbox[0];
          const { error } = j.op === 'delete'
            ? await sb.from(j.table).delete().eq('household_id', hh).eq('id', j.id)
            : await sb.from(j.table).upsert({ household_id: hh, id: j.id, data: j.data, updated_at: new Date(j.at).toISOString() });
          if (error && (isNetErr(error) || isAuthErr(error))) throw error;
          if (error) console.warn('Spoonbook: a saved change was refused', error.message);
          outbox.shift(); saveOut();
        }
      } finally { flushing = null; }
    })();
  }
  async function load(){
    await flush();
    const [r, l] = await Promise.all([
      sb.from('recipes').select('id,data').eq('household_id', hh),
      sb.from('lists').select('id,data').eq('household_id', hh)
    ]);
    if (r.error) throw r.error;
    if (l.error) throw l.error;
    rows.recipes = new Map((r.data || []).map(x => [x.id, x.data]));
    rows.lists = new Map((l.data || []).map(x => [x.id, x.data]));
    // anything still waiting to send stays as it is on this phone
    for (const j of outbox){ if (j.op === 'delete') rows[j.table].delete(j.id); else rows[j.table].set(j.id, clone(j.data)); }
    setOffline(false);
    emitRecipes(); for (const id of listeners.lists.keys()) emitList(id);
  }
  const ready = load().catch(e => { if (cached){ setOffline(true); return; } throw e; });
  sb.channel('hh-' + hh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'recipes', filter: 'household_id=eq.' + hh }, p => {
      if (p.eventType === 'DELETE') rows.recipes.delete(p.old.id); else rows.recipes.set(p.new.id, p.new.data);
      emitRecipes();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists', filter: 'household_id=eq.' + hh }, p => {
      const id = p.eventType === 'DELETE' ? p.old.id : p.new.id;
      if (p.eventType === 'DELETE') rows.lists.delete(id); else rows.lists.set(id, p.new.data);
      emitList(id);
    })
    .subscribe();
  // phones pause live updates in the background, so catch up when the app comes back or the signal returns
  const catchUp = () => load().catch(e => { if (isNetErr(e) || isAuthErr(e)) setOffline(true); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') catchUp(); });
  addEventListener('online', catchUp);
  setInterval(() => { if (outbox.length && navigator.onLine) catchUp(); }, 30000);

  const fail = e => { throw { code: /free_limit/i.test(e?.message || '') ? 'free_limit' : /quota|limit/i.test(e?.message || '') ? 'quota_exceeded' : 'unavailable', message: e?.message }; };
  const ref = (table, id) => ({
    async set(data){
      const before = rows[table].get(id);
      rows[table].set(id, clone(data)); emit(table, id);
      const job = { op: 'set', table, id, data: clone(data), at: Date.now() };
      if (outbox.length){ queue(job); flush().catch(() => {}); return; } // keep changes in order
      let error;
      try { ({ error } = await sb.from(table).upsert({ household_id: hh, id, data, updated_at: new Date().toISOString() })); } catch (e) { error = e; }
      if (error && isNetErr(error)){ queue(job); return; }
      if (error){ before ? rows[table].set(id, before) : rows[table].delete(id); emit(table, id); fail(error); }
    },
    async update(patch){
      const cur = rows[table].get(id); if (!cur) throw { code: 'invalid_argument' };
      return ref(table, id).set(merge(clone(cur), clone(patch)));
    },
    async delete(){
      const before = rows[table].get(id);
      rows[table].delete(id); emit(table, id);
      const job = { op: 'delete', table, id, at: Date.now() };
      if (outbox.length){ queue(job); flush().catch(() => {}); return; }
      let error;
      try { ({ error } = await sb.from(table).delete().eq('household_id', hh).eq('id', id)); } catch (e) { error = e; }
      if (error && isNetErr(error)){ queue(job); return; }
      if (error){ if (before) rows[table].set(id, before); emit(table, id); fail(error); }
    },
    onSnapshot(cb){
      const set = listeners.lists.get(id) || new Set(); set.add(cb); listeners.lists.set(id, set);
      if (cached) cb(snap(id, rows.lists.get(id)));
      ready.then(() => cb(snap(id, rows.lists.get(id)))).catch(() => {});
      return () => set.delete(cb);
    }
  });
  return {
    collection: name => ({
      doc: id => ref('recipes', id),
      onSnapshot(cb, err){
        listeners.recipes.add(cb);
        if (cached) cb({ docs: [...rows.recipes].map(([id, d]) => snap(id, d)) }); // open instantly from the saved copy
        ready.then(emitRecipes).catch(e => err?.({ code: 'unavailable', message: e.message }));
        return () => listeners.recipes.delete(cb);
      }
    }),
    doc: path => { const [, id] = path.split('/'); return ref('lists', id); },
    reload: load
  };
}

/* ---------- photos upload ---------- */
function makeAssets(hh){
  return {
    async upload(blob, opts){
      const type = opts?.type || blob.type || 'image/jpeg';
      const path = `${hh}/${uuid()}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`;
      const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: type });
      if (error) throw { code: /size|large/i.test(error.message) ? 'too_large' : 'upstream_error', message: error.message };
      return { id: path, url: photoUrl(path) };
    },
    async delete(path){ await sb.storage.from('photos').remove([path]); return { deleted: true }; }
  };
}

/* ---------- people ---------- */
function makeUser(){
  return {
    id: async () => session?.user?.id ?? null,
    profiles: async ids => Object.fromEntries([].concat(ids).map(id => [id, { id, name: members.find(m => m.user_id === id)?.display_name || '' }]))
  };
}

/* ---------- files to save ---------- */
const downloads = {
  async save({ filename, data }){
    const blob = data instanceof Blob ? data : new Blob([data], { type: filename.endsWith('.json') ? 'application/json' : 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return { status: 'saved' };
  }
};

/* ---------- link clipping ---------- */
async function clip(url){
  const { data, error } = await sb.functions.invoke('clip', { body: { url, household: household.id } });
  if (error){ let body = {}; try { body = await error.context?.json?.(); } catch {} throw { code: body?.error || 'upstream_error', ...body }; }
  return data.recipe;
}

/* ---------- importing the backup from the Claude version ---------- */
async function importBackup(file, progress){
  if (!window.JSZip) throw { message: 'The importer did not load. Check your connection and try again.' };
  const zip = await JSZip.loadAsync(file);
  const raw = await zip.file('backup.json')?.async('string');
  if (!raw) throw { message: 'That file isn’t a Spoonbook backup.' };
  const backup = JSON.parse(raw); const hh = household.id;
  const photos = Object.keys(zip.files).filter(n => n.startsWith('photos/') && !zip.files[n].dir);
  let done = 0; const moved = {};
  for (const name of photos){
    const id = name.slice(7).replace(/\.\w+$/, ''); const path = `${hh}/${name.slice(7)}`;
    const blob = await zip.file(name).async('blob');
    const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (!error) moved[id] = path;
    progress?.(`Photos ${++done} of ${photos.length}`);
  }
  const rows = (backup.recipes || []).map(r => {
    const { id, ...data } = r;
    if (data.photo) data.photo = moved[data.photo] || null;
    data.photos = (data.photos || []).map(p => moved[p]).filter(Boolean);
    return { household_id: hh, id, data };
  });
  for (let i = 0; i < rows.length; i += 50){
    const { error } = await sb.from('recipes').upsert(rows.slice(i, i + 50));
    if (error) throw { message: 'Couldn’t save recipes: ' + error.message };
    progress?.(`Recipes ${Math.min(i + 50, rows.length)} of ${rows.length}`);
  }
  if (backup.plan?.days && Object.keys(backup.plan.days).length) await sb.from('lists').upsert({ household_id: hh, id: 'plan', data: backup.plan });
  return { recipes: rows.length, photos: Object.keys(moved).length };
}

/* ---------- sign-in and cookbook screens ---------- */
const app = () => document.getElementById('app');
function screen(html){ app().innerHTML = `<div class="top"><p class="brand">Spoonbook</p></div>${html}`; document.getElementById('nav').hidden = true; }
function msg(t, bad){ const m = document.getElementById('authMsg'); if (m){ m.textContent = t; m.style.color = bad ? 'var(--danger)' : 'var(--muted)'; } }

// Google's own "G" mark, as Google asks sign-in buttons to show it
const GOOGLE_G = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
function signInScreen(mode = 'in'){
  let gone = false; try { gone = sessionStorage.getItem('sb-account-deleted') === '1'; sessionStorage.removeItem('sb-account-deleted'); } catch {}
  screen((gone ? `<p class="offline" role="status">Your account has been deleted. Thanks for using Spoonbook.</p>` : '') + `<h1 class="hello">${mode === 'in' ? 'Welcome<br><em>back.</em>' : 'Make your<br><em>cookbook.</em>'}</h1>
  ${CFG.googleSignIn && mode !== 'reset' ? `<button class="btn gbtn" type="button" id="googleBtn">${GOOGLE_G}<span>Continue with Google</span></button>
    <p class="or"><span>or use your email</span></p>` : ''}
  <form class="form" id="authForm" novalidate>
    <div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
    ${mode === 'reset' ? '' : `<div class="field"><label for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" minlength="6" required></div>`}
    <button class="btn primary" type="submit">${mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset email'}</button>
    <p id="authMsg" class="hint" role="status"></p>
    <div class="actions" style="margin:0">
      ${mode !== 'in' ? '<button class="btn small" type="button" data-auth="in">I have an account</button>' : '<button class="btn small" type="button" data-auth="up">I’m new here</button><button class="btn small" type="button" data-auth="reset">Forgot password</button>'}
    </div>
    <p class="hint" style="font-size:12px">By using Spoonbook you agree to the <a href="terms.html" target="_blank" rel="noopener">terms</a>. See how your data is looked after in the <a href="privacy.html" target="_blank" rel="noopener">privacy policy</a>.</p>
  </form>`);
  const oauthErr = new URLSearchParams(location.search + '&' + location.hash.slice(1)).get('error_description');
  if (oauthErr){ msg(/cancel|denied/i.test(oauthErr) ? 'Google sign-in was cancelled.' : 'Google sign-in didn’t work: ' + oauthErr, true); history.replaceState(null, '', location.pathname); }
  const g = document.getElementById('googleBtn');
  if (g) g.onclick = async () => {
    g.disabled = true; msg('Opening Google…');
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } });
    if (error){ g.disabled = false; msg(/not enabled|unsupported/i.test(error.message) ? 'Google sign-in isn’t set up yet. Use your email for now.' : error.message, true); }
  };
  app().querySelectorAll('[data-auth]').forEach(b => b.onclick = () => signInScreen(b.dataset.auth));
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    const email = document.getElementById('a-email').value.trim(), pass = document.getElementById('a-pass')?.value;
    if (!email) return msg('Enter your email address.', true);
    msg('One moment…');
    if (mode === 'reset'){
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      return msg(error ? error.message : 'Check your email for a link to set a new password.', !!error);
    }
    if (!pass || pass.length < 6) return msg('Passwords need at least 6 characters.', true);
    const { data, error } = mode === 'in'
      ? await sb.auth.signInWithPassword({ email, password: pass })
      : await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return msg(error.message === 'Invalid login credentials' ? 'That email and password don’t match.' : error.message, true);
    if (mode === 'up' && !data.session) return msg('Nearly there: check your email and tap the link to confirm, then sign in here.');
  };
}

function newPasswordScreen(){
  screen(`<h1 class="hello">New<br><em>password.</em></h1>
  <form class="form" id="pwForm"><div class="field"><label for="a-new">New password</label><input id="a-new" type="password" autocomplete="new-password" minlength="6" required></div>
  <button class="btn primary" type="submit">Save password</button><p id="authMsg" class="hint" role="status"></p></form>`);
  document.getElementById('pwForm').onsubmit = async e => {
    e.preventDefault(); const p = document.getElementById('a-new').value;
    if (p.length < 6) return msg('Passwords need at least 6 characters.', true);
    const { error } = await sb.auth.updateUser({ password: p });
    if (error) return msg(error.message, true);
    history.replaceState(null, '', location.pathname); start();
  };
}

function householdScreen(){
  screen(`<h1 class="hello">Set up your<br><em>cookbook.</em></h1>
  <form class="form" id="hhForm" novalidate>
    <div class="field"><label for="h-name">Your name</label><input id="h-name" autocomplete="given-name" placeholder="e.g. Mark" value="${esc(((session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || '').split(' ')[0]))}" required></div>
    <div class="field"><label for="h-code">Joining someone? Enter their code</label><input id="h-code" autocomplete="off" placeholder="6-letter code (leave blank to start a new one)" style="text-transform:uppercase"></div>
    <button class="btn primary" type="submit">Continue</button>
    <p id="authMsg" class="hint" role="status"></p>
    <button class="btn small" type="button" id="h-out">Sign out</button>
  </form>`);
  document.getElementById('h-out').onclick = () => sb.auth.signOut();
  document.getElementById('hhForm').onsubmit = async e => {
    e.preventDefault();
    const name = document.getElementById('h-name').value.trim(), code = document.getElementById('h-code').value.trim();
    if (!name) return msg('Add your name so the other cook knows who did what.', true);
    msg('One moment…');
    const { error } = code ? await sb.rpc('join_household', { code, my_name: name }) : await sb.rpc('create_household', { cookbook_name: 'Our cookbook', my_name: name });
    if (error) return msg(/code/i.test(error.message) ? 'No cookbook has that code. Check it and try again.' : error.message, true);
    start();
  };
}

/* ---------- start-up ---------- */
let booted = false, onReady = null;
let starting = null;
function start(){ return starting = starting || run().finally(() => { starting = null; }); }
async function run(){
  const stuck = setTimeout(() => {
    if (booted) return;
    screen(`<div class="empty"><h2>Still opening…</h2>This is taking longer than usual. Check your internet connection.<div class="actions" style="justify-content:center;margin-top:16px"><button class="btn small" id="retryBtn">Try again</button><button class="btn small" id="resetBtn">Sign out and start again</button></div></div>`);
    document.getElementById('retryBtn').onclick = () => location.reload();
    document.getElementById('resetBtn').onclick = () => { try { Object.keys(localStorage).filter(k => /^sb-.*-auth-token/.test(k)).forEach(k => localStorage.removeItem(k)); } catch {} location.reload(); };
  }, 12000);
  try { await runInner(); } finally { clearTimeout(stuck); }
}
async function runInner(){
  if (!CFG.supabaseUrl || /YOUR_/.test(CFG.supabaseUrl)){ screen(`<div class="empty"><h2>Almost ready</h2>Spoonbook needs its Supabase details in config.js.</div>`); return; }
  let got; try { got = await sb.auth.getSession(); } catch (e) { got = { data: {}, error: e }; }
  session = got.data?.session || null;
  if (!session){
    // no signal and the sign-in needs renewing: carry on with the saved cookbook and renew once back online
    const saved = storedSession();
    if (saved && (got.error || !navigator.onLine) && readCache(saved.user.id)) session = saved;
  }
  if (!session) return signInScreen();
  const cached = readCache(session.user.id);
  const ask = sb.from('members').select('household_id, display_name, households(id, name, join_code)').eq('user_id', session.user.id).limit(1);
  let m; try { m = await (cached ? withTimeout(ask, 5000) : ask); } catch (e) { m = { error: e }; }
  if (m.error && cached?.household && isNetErr(m.error)){
    household = cached.household; members = cached.members || []; offline = true;
    return boot(cached);
  }
  if (m.error){ screen(`<div class="empty"><h2>Can’t reach your cookbook</h2>${esc(m.error.message)}</div>`); return; }
  if (!m.data?.length) return householdScreen();
  household = m.data[0].households;
  const all = await sb.from('members').select('user_id, display_name').eq('household_id', household.id);
  members = all.data || (cached?.members || []);
  boot(cached?.household?.id === household.id ? cached : null);
  loadPlan();
}
function boot(cached){
  if (booted) return;
  booted = true; document.getElementById('nav').hidden = false;
  onReady?.({ db: makeDb(household.id, session.user.id, cached), assets: makeAssets(household.id), user: makeUser(), downloads });
}
/* ---------- Spoonbook Plus: only matters once the paywall is switched on in app_settings ---------- */
async function loadPlan(){
  try {
    const [s, h] = await Promise.all([
      sb.from('app_settings').select('paywall_enabled, free_recipe_limit').eq('id', 1).maybeSingle(),
      sb.from('households').select('plan, plus_until').eq('id', household.id).maybeSingle()
    ]);
    if (s.error || !s.data) return;
    const until = h.data?.plus_until ? new Date(h.data.plus_until) : null;
    plan = { enabled: !!s.data.paywall_enabled, limit: s.data.free_recipe_limit || 50, plus: h.data?.plan === 'plus' && (!until || until > new Date()), until };
    rerender();
  } catch {}
}
// Supabase locks up if its own functions are called from inside this event, so anything that needs
// Supabase is queued with setTimeout to run just after the event has finished.
sb.auth.onAuthStateChange((event, s) => {
  if (event === 'PASSWORD_RECOVERY'){ session = s; setTimeout(newPasswordScreen, 0); return; }
  if (event === 'SIGNED_IN' && !booted && s?.user?.id !== session?.user?.id){ session = s; setTimeout(start, 0); }
  if (event === 'SIGNED_OUT'){ session = null; try { Object.keys(localStorage).filter(k => /^sb-(offline|outbox)-/.test(k)).forEach(k => localStorage.removeItem(k)); } catch {} if (booted) location.reload(); else setTimeout(signInScreen, 0); }
});

window.Backend = {
  start(cb){ onReady = cb; start(); },
  photoUrl, clip, importBackup,
  get household(){ return household; }, get members(){ return members; },
  get offline(){ return offline; }, get pending(){ return pending; }, get plan(){ return plan; }, refreshPlan: loadPlan,
  checkoutUrl(){
    if (!CFG.checkoutUrl) return '';
    const u = new URL(CFG.checkoutUrl);
    u.searchParams.set('checkout[custom][household_id]', household.id);
    if (session?.user?.email) u.searchParams.set('checkout[email]', session.user.email);
    return u.href;
  },
  async rename(name){ await sb.from('members').update({ display_name: name }).eq('household_id', household.id).eq('user_id', session.user.id); const me = members.find(m => m.user_id === session.user.id); if (me) me.display_name = name; },
  signOut: () => sb.auth.signOut(),
  // Deletes this person's account. If nobody else shares the cookbook, its recipes, lists and photos go too;
  // otherwise the cookbook stays with the others.
  async deleteAccount(progress){
    const all = await sb.from('members').select('user_id').eq('household_id', household.id);
    if (all.error) throw all.error;
    const alone = (all.data || []).every(m => m.user_id === session.user.id);
    if (alone){
      progress?.('Deleting photos…');
      for (let round = 0; round < 50; round++){
        const { data, error } = await sb.storage.from('photos').list(household.id, { limit: 1000 });
        if (error || !data?.length) break;
        const { error: e2 } = await sb.storage.from('photos').remove(data.map(f => `${household.id}/${f.name}`));
        if (e2 || data.length < 1000) break;
      }
    }
    progress?.('Deleting your account…');
    const { error } = await sb.rpc('delete_my_account');
    if (error) throw error;
    try { Object.keys(localStorage).filter(k => /^sb-/.test(k)).forEach(k => localStorage.removeItem(k)); sessionStorage.setItem('sb-account-deleted', '1'); } catch {}
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    location.reload();
  },
  email: () => session?.user?.email || ''
};
})();
