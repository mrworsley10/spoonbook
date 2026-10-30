/* Spoonbook ↔ Supabase.
   The app was first built inside Claude, where storage, photos, people and AI came from Claude's runtime.
   This file gives the app the same small interfaces (db, assets, user, sample, downloads), backed by
   Supabase instead, plus the sign-in and "join a cookbook" screens. */
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

let session = null, household = null, members = [];
const rerender = () => window.__spoonbookRender?.();

/* ---------- photos: private bucket, shown through signed links cached for a few days ---------- */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
let urlCache = {}; try { urlCache = JSON.parse(store.get('sb-photo-urls') || '{}'); } catch {}
const wanted = new Set(); let fetchTimer = null;
function photoUrl(path){
  if (!path) return BLANK;
  const hit = urlCache[path];
  if (hit && hit.exp > Date.now()) return hit.url;
  wanted.add(path); clearTimeout(fetchTimer); fetchTimer = setTimeout(fetchUrls, 30);
  return BLANK;
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
function makeDb(hh){
  const rows = { recipes: new Map(), lists: new Map() };
  const listeners = { recipes: new Set(), lists: new Map() };
  const snap = (id, d) => ({ id, exists: !!d, data: () => d && clone(d) });
  const emitRecipes = () => { const docs = [...rows.recipes].map(([id, d]) => snap(id, d)); listeners.recipes.forEach(cb => cb({ docs })); };
  const emitList = id => (listeners.lists.get(id) || new Set()).forEach(cb => cb(snap(id, rows.lists.get(id))));
  async function load(){
    const [r, l] = await Promise.all([
      sb.from('recipes').select('id,data').eq('household_id', hh),
      sb.from('lists').select('id,data').eq('household_id', hh)
    ]);
    if (r.error) throw r.error;
    rows.recipes = new Map((r.data || []).map(x => [x.id, x.data]));
    rows.lists = new Map((l.data || []).map(x => [x.id, x.data]));
    emitRecipes(); for (const id of listeners.lists.keys()) emitList(id);
  }
  const ready = load();
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
  // phones pause live updates in the background, so catch up when the app comes back
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load().catch(() => {}); });

  const fail = e => { throw { code: /quota|limit/i.test(e?.message || '') ? 'quota_exceeded' : 'unavailable', message: e?.message }; };
  const ref = (table, id) => ({
    async set(data){
      const before = rows[table].get(id);
      rows[table].set(id, clone(data)); table === 'recipes' ? emitRecipes() : emitList(id);
      const { error } = await sb.from(table).upsert({ household_id: hh, id, data, updated_at: new Date().toISOString() });
      if (error){ before ? rows[table].set(id, before) : rows[table].delete(id); table === 'recipes' ? emitRecipes() : emitList(id); fail(error); }
    },
    async update(patch){
      const cur = rows[table].get(id); if (!cur) throw { code: 'invalid_argument' };
      return ref(table, id).set(merge(clone(cur), clone(patch)));
    },
    async delete(){
      const before = rows[table].get(id);
      rows[table].delete(id); table === 'recipes' ? emitRecipes() : emitList(id);
      const { error } = await sb.from(table).delete().eq('household_id', hh).eq('id', id);
      if (error){ if (before) rows[table].set(id, before); emitRecipes(); fail(error); }
    },
    onSnapshot(cb){
      const set = listeners.lists.get(id) || new Set(); set.add(cb); listeners.lists.set(id, set);
      ready.then(() => cb(snap(id, rows.lists.get(id)))).catch(() => {});
      return () => set.delete(cb);
    }
  });
  return {
    collection: name => ({
      doc: id => ref('recipes', id),
      onSnapshot(cb, err){ listeners.recipes.add(cb); ready.then(emitRecipes).catch(e => err?.({ code: 'unavailable', message: e.message })); return () => listeners.recipes.delete(cb); }
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

/* ---------- Claude, through the "ai" function (off until a key is added) ---------- */
let aiEnabled = false;
async function toBase64(blob){
  let b = blob;
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    b = await new Promise(r => c.toBlob(x => r(x || blob), 'image/jpeg', .85));
  } catch {}
  const buf = new Uint8Array(await b.arrayBuffer()); let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { type: b.type || 'image/jpeg', data: btoa(s) };
}
function makeSample(){
  const call = async (prompt, opts = {}) => {
    const imgs = opts.images ? await Promise.all([...opts.images].slice(0, 4).map(toBase64)) : undefined;
    const work = sb.functions.invoke('ai', { body: { prompt, images: imgs, tier: opts.modelTier } }).then(async ({ data, error }) => {
      if (error){
        let body = {}; try { body = await error.context?.json?.(); } catch {}
        const code = body?.error === 'rate_limited' ? 'rate_limited' : body?.error === 'invalid_json' ? 'invalid_json' : body?.error === 'not_configured' ? 'not_granted' : 'upstream_error';
        throw { code, message: body?.error || error.message };
      }
      return data.result;
    });
    if (!opts.signal) return work;
    return Promise.race([work, new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej({ code: 'cancelled' }), { once: true }))]);
  };
  const s = (prompt, opts) => call(prompt, opts).then(r => ({ text: JSON.stringify(r), truncated: false }));
  s.json = call;
  s.limits = async () => ({ maxPromptBytes: 60000, images: { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } });
  return s;
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

function signInScreen(mode = 'in'){
  screen(`<h1 class="hello">${mode === 'in' ? 'Welcome<br><em>back.</em>' : 'Make your<br><em>cookbook.</em>'}</h1>
  <form class="form" id="authForm" novalidate>
    <div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
    ${mode === 'reset' ? '' : `<div class="field"><label for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" minlength="6" required></div>`}
    <button class="btn primary" type="submit">${mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset email'}</button>
    <p id="authMsg" class="hint" role="status"></p>
    <div class="actions" style="margin:0">
      ${mode !== 'in' ? '<button class="btn small" type="button" data-auth="in">I have an account</button>' : '<button class="btn small" type="button" data-auth="up">I’m new here</button><button class="btn small" type="button" data-auth="reset">Forgot password</button>'}
    </div>
  </form>`);
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
    <div class="field"><label for="h-name">Your name</label><input id="h-name" autocomplete="given-name" placeholder="e.g. Mark" required></div>
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
async function start(){
  if (!CFG.supabaseUrl || /YOUR_/.test(CFG.supabaseUrl)){ screen(`<div class="empty"><h2>Almost ready</h2>Spoonbook needs its Supabase details in config.js.</div>`); return; }
  const { data } = await sb.auth.getSession(); session = data.session;
  if (!session) return signInScreen();
  const m = await sb.from('members').select('household_id, display_name, households(id, name, join_code)').eq('user_id', session.user.id).limit(1);
  if (m.error){ screen(`<div class="empty"><h2>Can’t reach your cookbook</h2>${esc(m.error.message)}</div>`); return; }
  if (!m.data?.length) return householdScreen();
  household = m.data[0].households;
  const all = await sb.from('members').select('user_id, display_name').eq('household_id', household.id);
  members = all.data || [];
  try { const r = await sb.functions.invoke('ai', { method: 'GET' }); aiEnabled = !!r.data?.enabled; } catch { aiEnabled = false; }
  if (booted) return location.reload();
  booted = true; document.getElementById('nav').hidden = false;
  onReady?.({ db: makeDb(household.id), assets: makeAssets(household.id), user: makeUser(), sample: aiEnabled ? makeSample() : null, downloads });
}
sb.auth.onAuthStateChange((event, s) => {
  if (event === 'PASSWORD_RECOVERY'){ session = s; return newPasswordScreen(); }
  if (event === 'SIGNED_IN' && !booted && s?.user?.id !== session?.user?.id){ session = s; start(); }
  if (event === 'SIGNED_OUT'){ session = null; if (booted) location.reload(); else signInScreen(); }
});

window.Backend = {
  start(cb){ onReady = cb; start(); },
  photoUrl, clip, importBackup,
  get household(){ return household; }, get members(){ return members; }, get aiEnabled(){ return aiEnabled; },
  async rename(name){ await sb.from('members').update({ display_name: name }).eq('household_id', household.id).eq('user_id', session.user.id); const me = members.find(m => m.user_id === session.user.id); if (me) me.display_name = name; },
  signOut: () => sb.auth.signOut(),
  email: () => session?.user?.email || ''
};
})();
