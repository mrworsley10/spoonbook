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

let session = null, household = null, members = [], plan = null, cookbooks = [];
let resetting = false; // typing a reset code: that screen handles the new password itself
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
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set(cacheKey(uid), JSON.stringify({ household, members, cookbooks, recipes: Object.fromEntries(rows.recipes), lists: Object.fromEntries(rows.lists), at: Date.now() })), 500); };
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

/* ---------- free stock photos (Pexels), searched and copied by the "photos" function ---------- */
let photoFn = 'photos';
async function photoCall(body){
  let { data, error } = await sb.functions.invoke(photoFn, { body });
  // the function may have been created as "Photos" (its web address keeps the first spelling)
  if (error && error.context?.status === 404 && photoFn === 'photos'){ photoFn = 'Photos'; ({ data, error } = await sb.functions.invoke(photoFn, { body })); if (error?.context?.status === 404) photoFn = 'photos'; }
  if (error){ let b = {}; try { b = await error.context?.json?.(); } catch {} const st = error.context?.status; throw { code: b?.error || (isNetErr(error) ? 'offline' : st === 404 ? 'no_function' : st ? 'status_' + st : 'failed') }; }
  return data;
}
const findPhotos = (q, page = 1) => photoCall({ action: 'search', q, page }).then(d => Object.assign(d.photos || [], { site: d.site || 'Pexels' }));
const useStockPhoto = id => photoCall({ action: 'use', id, household: household.id });

/* ---------- sharing a recipe as a link ---------- */
const shareId = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(x => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[x % 57]).join(''); };
const appBase = () => location.origin + location.pathname.replace(/index\.html$/, '');
const sharedPhotoUrl = name => `${CFG.supabaseUrl}/storage/v1/object/public/shared/${name}`;
async function shareRecipe(r){
  const id = shareId(); let photo = null;
  if (r.photo){
    const { data: blob } = await sb.storage.from('photos').download(r.photo);
    if (blob){ const { error } = await sb.storage.from('shared').upload(`${id}.jpg`, blob, { contentType: blob.type || 'image/jpeg' }); if (!error) photo = `${id}.jpg`; }
  }
  const me = members.find(m => m.user_id === session.user.id);
  const data = { title: r.title, category: r.category || 'Mains', serves: r.serves || '', totalMins: r.totalMins || null, ingredients: r.ingredients || [], steps: r.steps || [],
    note: r.note || '', tags: r.tags || [], spice: r.spice ?? null, source: r.source || '', photo, photoCredit: photo && r.credits?.[r.photo] ? r.credits[r.photo] : null, sharedBy: me?.display_name || '', sharedAt: Date.now() };
  const { error } = await sb.from('shared_recipes').insert({ id, household_id: household.id, created_by: session.user.id, data });
  if (error) throw { code: isNetErr(error) ? 'offline' : 'failed', message: error.message };
  return { id, url: appBase() + 'r.html?id=' + id };
}
async function getShared(id){
  const { data, error } = await sb.rpc('get_shared_recipe', { share_id: id });
  if (error) throw error;
  return data ? { ...data, photoUrl: data.photo ? sharedPhotoUrl(data.photo) : null } : null;
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
function screen(html){ app().innerHTML = `<div class="top"><a class="brand" href="./">Spoonbook</a></div>${html}`; document.getElementById('nav').hidden = true; }
function msg(t, bad){ const m = document.getElementById('authMsg'); if (m){ m.textContent = t; m.style.color = bad ? 'var(--danger)' : 'var(--muted)'; } }

// Google's own "G" mark, as Google asks sign-in buttons to show it
const GOOGLE_G = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
async function googleGo(g){
  g.disabled = true; msg('Opening Google…');
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } });
  if (error){ g.disabled = false; msg(/not enabled|unsupported/i.test(error.message) ? 'Google sign-in isn’t set up yet. Use your email for now.' : error.message, true); }
}

/* the first thing someone new sees: what Spoonbook is, shown rather than described, then one big button */
const SLIDES = [
  { h: 'Cook together', p: 'Share your cookbook with family. Everyone can add recipes, and you all see the same plan and shopping list.', art: `
    <div class="mk-people"><i style="--c:#C8553D">M</i><i style="--c:#3D7EA6">D</i><i style="--c:#6A8D4E">N</i><i style="--c:#B07AA1">S</i></div>
    <div class="mk-card"><span class="mk-ph" style="--h:20">🍖</span><span><b>Nan’s Sunday roast</b><small>Added by Nan · Serves 6</small></span></div>
    <div class="mk-card"><span class="mk-ph" style="--h:340">🍰</span><span><b>Mum’s lemon drizzle</b><small>Added by Mum · ★ 5</small></span></div>
    <p class="mk-note">Dad joined the family cookbook</p>` },
  { h: 'Save from anywhere', p: 'Paste a link from any recipe website, snap a page of a cookbook, or bring over old emails. No more screenshots.', art: `
    <div class="mk-url">bbcgoodfood.com/recipes/…</div><div class="mk-arrow">↓</div>
    <div class="mk-card big"><span class="mk-ph" style="--h:10">🍝</span><span><b>Creamy tomato pasta</b><small>25 min · Serves 4 · 9 ingredients</small></span></div>` },
  { h: 'Plan and shop together', p: 'Plan the week, then one tap fills the shopping list, sorted by aisle. Tick things off and everyone sees it live.', art: `
    <div class="mk-plan"><span><b>Mon</b>Chicken traybake</span><span><b>Tue</b>Creamy tomato pasta</span></div>
    <div class="mk-list"><small>Fruit &amp; veg</small><span class="on">Peppers</span><span>Cherry tomatoes</span><small>Dairy</small><span class="on">Milk <em>ticked by Mum</em></span></div>` },
  { h: 'Cook hands-free', p: 'Big, clear steps with timers you can hear. It can read each step aloud, so you don’t touch the screen with messy hands.', art: `
    <div class="mk-cook"><small>Step 3 of 6</small><b>Simmer the sauce until thick and glossy.</b><span class="mk-timer">⏱ 08:42</span></div>` }
];
function landingScreen(gone){
  const invited = pendingJoin();
  screen((gone ? `<p class="offline" role="status">Your account has been deleted. Thanks for using Spoonbook.</p>` : '') + `
  <div class="land">
    <h1 class="hello">${invited ? 'You’ve been<br><em>invited.</em>' : 'Every family recipe.<br><em>One shared cookbook.</em>'}</h1>
    <p class="land-trust">${invited ? 'Someone wants to share their cookbook with you. Make a free account to join them.' : 'Free · No adverts · Made in the UK'}</p>
    <div class="land-show">
    <div class="slides" id="slides" tabindex="0" aria-roledescription="carousel" aria-label="What Spoonbook does">
      ${SLIDES.map((x, i) => `<section class="slide" aria-label="${i + 1} of ${SLIDES.length}: ${x.h}"><div class="mk">${x.art}</div><h2>${x.h}</h2><p>${x.p}</p></section>`).join('')}
    </div>
    <div class="dots" role="group" aria-label="Choose a slide">${SLIDES.map((x, i) => `<button type="button" data-slide="${i}" aria-label="${x.h}" aria-current="${i === 0}"></button>`).join('')}</div>
    </div>
    <button class="btn primary" type="button" id="startBtn">Get started, it’s free</button>
    ${CFG.googleSignIn ? `<button class="btn gbtn" type="button" id="googleBtn">${GOOGLE_G}<span>Continue with Google</span></button>` : ''}
    <p id="authMsg" class="hint" role="status"></p>
    <button class="linkbtn land-in" type="button" data-auth="in">I already have an account</button>
    <p class="land-links"><a href="about.html">How it works</a> · <a href="install.html">Installing</a> · <a href="about.html#questions">Questions</a></p>
    <p class="hint land-legal">By using Spoonbook you agree to the <a href="terms.html" target="_blank" rel="noopener">terms</a> and <a href="privacy.html" target="_blank" rel="noopener">privacy policy</a>.</p>
  </div>`);
  document.getElementById('startBtn').onclick = () => signInScreen('up', true);
  const g = document.getElementById('googleBtn'); if (g) g.onclick = () => googleGo(g);
  app().querySelectorAll('[data-auth]').forEach(b => b.onclick = () => signInScreen(b.dataset.auth, true));
  // the slides move on by themselves until someone touches them
  const box = document.getElementById('slides'), dots = [...app().querySelectorAll('[data-slide]')];
  let at = 0, auto = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = i => { at = (i + SLIDES.length) % SLIDES.length; box.scrollTo({ left: at * box.clientWidth, behavior: 'smooth' }); };
  box.addEventListener('scroll', () => { const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth)); dots.forEach((d, j) => d.setAttribute('aria-current', j === i)); at = i; }, { passive: true });
  ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach(ev => box.addEventListener(ev, () => { auto = false; }, { passive: true }));
  dots.forEach(d => d.onclick = () => { auto = false; show(+d.dataset.slide); });
  box.onkeydown = e => { if (e.key === 'ArrowRight') show(at + 1); if (e.key === 'ArrowLeft') show(at - 1); };
  const timer = setInterval(() => { if (!document.body.contains(box)) return clearInterval(timer); if (auto && !document.hidden) show(at + 1); }, 4500);
}

function signInScreen(mode, fromLanding){
  let gone = false; try { gone = sessionStorage.getItem('sb-account-deleted') === '1'; sessionStorage.removeItem('sb-account-deleted'); } catch {}
  // someone who's never signed in on this phone starts on the welcome screen
  const returning = !!store.get('sb-been-here');
  const back = new URLSearchParams(location.search + '&' + location.hash.slice(1));
  if (!mode && !returning && !back.get('error_description')) return landingScreen(gone);
  mode = mode || (returning ? 'in' : 'up');
  const intro = fromLanding && mode !== 'reset' ? `<button class="linkbtn" type="button" id="landBack" style="margin:-8px 0 14px">← Back</button>` : '';
  screen((gone ? `<p class="offline" role="status">Your account has been deleted. Thanks for using Spoonbook.</p>` : '') + `<h1 class="hello">${mode === 'in' ? 'Welcome<br><em>back.</em>' : mode === 'up' ? 'Make your<br><em>cookbook.</em>' : 'Forgotten your<br><em>password?</em>'}</h1>
  ${intro}
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
  const oauthErr = back.get('error_description'), errCode = back.get('error_code') || '';
  if (oauthErr){
    // a link from an email (reset, confirm) that's been used already: email scanners often open links before you do
    const emailLink = /otp|email link|expired|invalid/i.test(errCode + ' ' + oauthErr);
    msg(emailLink ? 'That email link has expired or was already used. Tap “Forgot password” to get a code instead, which always works.'
      : /cancel|denied/i.test(oauthErr) ? 'Google sign-in was cancelled.' : 'Google sign-in didn’t work: ' + oauthErr, true);
    history.replaceState(null, '', location.pathname);
  }
  const g = document.getElementById('googleBtn');
  if (g) g.onclick = () => googleGo(g);
  const lb = document.getElementById('landBack'); if (lb) lb.onclick = () => landingScreen();
  app().querySelectorAll('[data-auth]').forEach(b => b.onclick = () => signInScreen(b.dataset.auth, fromLanding));
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    const email = document.getElementById('a-email').value.trim(), pass = document.getElementById('a-pass')?.value;
    if (!email) return msg('Enter your email address.', true);
    msg('One moment…');
    if (mode === 'reset'){
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) return msg(/rate|seconds/i.test(error.message) ? 'Please wait a minute before asking for another email.' : error.message, true);
      return resetCodeScreen(email);
    }
    if (!pass || pass.length < 6) return msg('Passwords need at least 6 characters.', true);
    const { data, error } = mode === 'in'
      ? await sb.auth.signInWithPassword({ email, password: pass })
      : await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return msg(error.message === 'Invalid login credentials' ? 'That email and password don’t match.' : error.message, true);
    if (mode === 'up' && !data.session) return msg('Nearly there: check your email and tap the link to confirm, then sign in here.');
  };
}

// the reset email carries a code as well as a link. Typing the code works even if the link has been
// used up by a spam filter, or the email was opened on a different device.
function resetCodeScreen(email){
  screen(`<h1 class="hello">Check your<br><em>email.</em></h1>
  <p class="hint" style="margin:0 0 16px">We’ve sent a code to <b>${esc(email)}</b>. It can take a minute, and it might be in your spam or junk folder.</p>
  <form class="form" id="codeForm" novalidate>
    <div class="field"><label for="a-code">Code from the email</label><input id="a-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required style="letter-spacing:4px;font-size:22px"></div>
    <div class="field"><label for="a-new">New password</label><input id="a-new" type="password" autocomplete="new-password" minlength="6" required></div>
    <button class="btn primary" type="submit">Save password</button>
    <p id="authMsg" class="hint" role="status">Or tap the link in the email instead.</p>
    <div class="actions" style="margin:0"><button class="btn small" type="button" id="resend">Send a new code</button><button class="btn small" type="button" data-auth="in">Back to sign in</button></div>
  </form>`);
  app().querySelectorAll('[data-auth]').forEach(b => b.onclick = () => signInScreen(b.dataset.auth));
  document.getElementById('resend').onclick = async () => {
    msg('One moment…');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    msg(error ? (/rate|seconds/i.test(error.message) ? 'Please wait a minute before asking for another code.' : error.message) : 'New code sent. Use the newest email.', !!error);
  };
  document.getElementById('codeForm').onsubmit = async e => {
    e.preventDefault();
    const token = document.getElementById('a-code').value.replace(/\D/g, ''), p = document.getElementById('a-new').value;
    if (token.length < 6) return msg('Enter the code from the email.', true);
    if (p.length < 6) return msg('Passwords need at least 6 characters.', true);
    msg('One moment…');
    resetting = true;
    let { error } = await sb.auth.verifyOtp({ email, token, type: 'recovery' });
    // Supabase sometimes sends its sign-in email instead of the reset one; that code works too
    if (error) ({ error } = await sb.auth.verifyOtp({ email, token, type: 'email' }));
    if (error){ resetting = false; return msg(/expired|invalid/i.test(error.message) ? 'That code didn’t work. Check it, or tap “Send a new code”.' : error.message, true); }
    const { error: e2 } = await sb.auth.updateUser({ password: p });
    resetting = false;
    if (e2) return msg(e2.message, true);
    history.replaceState(null, '', location.pathname); start();
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

// a join link (?join=CODE) waiting from before sign-in
function pendingJoin(){ try { return JSON.parse(sessionStorage.getItem('sb-shared') || 'null')?.join || ''; } catch { return ''; } }
function clearPendingJoin(){ try { const v = JSON.parse(sessionStorage.getItem('sb-shared') || 'null'); if (v?.join){ delete v.join; sessionStorage.setItem('sb-shared', JSON.stringify(v)); } } catch {} }
// a new cookbook is named after its cook: "Ian’s cookbook"
const bookNameFor = n => { const f = String(n || '').trim().split(/\s+/)[0]; return f ? f + '’s cookbook' : 'Our cookbook'; };
const currentKey = () => 'sb-current-' + session?.user?.id;
function householdScreen(){
  screen(`<h1 class="hello">Set up your<br><em>cookbook.</em></h1>
  <form class="form" id="hhForm" novalidate>
    <div class="field"><label for="h-name">Your name</label><input id="h-name" autocomplete="given-name" placeholder="e.g. Mark" value="${esc(((session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || '').split(' ')[0]))}" required></div>
    <div class="field"><label for="h-code">Joining someone? Enter their code</label><input id="h-code" autocomplete="off" placeholder="6-letter code (leave blank to start a new one)" style="text-transform:uppercase" value="${esc(pendingJoin())}"></div>
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
    const { data, error } = code ? await sb.rpc('join_household', { code, my_name: name }) : await sb.rpc('create_household', { cookbook_name: bookNameFor(name), my_name: name });
    if (error) return msg(/code/i.test(error.message) ? 'No cookbook has that code. Check it and try again.' : error.message, true);
    if (code) clearPendingJoin();
    if (data?.id) store.set(currentKey(), data.id);
    // a brand-new cook gets the "Get started" checklist on their Book page
    if (!store.get('sb-guide-' + session.user.id)) store.set('sb-guide-' + session.user.id, JSON.stringify({ done: {} }));
    start();
  };
}

async function removeHouseholdPhotos(hh){
  for (let round = 0; round < 50; round++){
    const { data, error } = await sb.storage.from('photos').list(hh, { limit: 1000 });
    if (error || !data?.length) break;
    const { error: e2 } = await sb.storage.from('photos').remove(data.map(f => `${hh}/${f.name}`));
    if (e2 || data.length < 1000) break;
  }
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
  const ask = sb.from('members').select('household_id, display_name, role, joined_at, households(id, name, created_by)').eq('user_id', session.user.id);
  let m; try { m = await (cached ? withTimeout(ask, 5000) : ask); } catch (e) { m = { error: e }; }
  if (m.error && cached?.household && isNetErr(m.error)){
    household = cached.household; members = cached.members || []; cookbooks = cached.cookbooks || []; offline = true;
    return boot(cached);
  }
  // the database hasn't had the latest schema.sql yet: carry on the old way (everyone can edit, one cookbook)
  let legacy = false;
  if (m.error && /column|does not exist|schema cache|permission denied/i.test(m.error.message || '')){
    legacy = true;
    m = await sb.from('members').select('household_id, display_name, households(id, name, join_code)').eq('user_id', session.user.id);
    (m.data || []).forEach(x => { x.role = 'editor'; if (x.households) x.households.created_by = session.user.id; });
  }
  if (m.error){ screen(`<div class="empty"><h2>Can’t reach your cookbook</h2>${esc(m.error.message)}</div>`); return; }
  if (!m.data?.length) return householdScreen();
  // every cookbook this person belongs to; the one they last used opens
  cookbooks = m.data.filter(x => x.households).map(x => ({ id: x.household_id, name: x.households.name, role: x.role, createdBy: x.households.created_by, myName: x.display_name, joined: x.joined_at }))
    .sort((a, b) => (a.joined || '').localeCompare(b.joined || ''));
  const want = store.get(currentKey());
  const cur = cookbooks.find(c => c.id === want) || cookbooks.find(c => c.role === 'editor') || cookbooks[0];
  store.set(currentKey(), cur.id);
  household = { id: cur.id, name: cur.name, created_by: cur.createdBy, role: cur.role };
  const legacyCode = legacy ? m.data.find(x => x.household_id === cur.id)?.households?.join_code : null;
  const [all, codes] = await Promise.all([
    sb.from('members').select(legacy ? 'user_id, display_name' : 'user_id, display_name, role, joined_at').eq('household_id', household.id),
    legacy ? Promise.resolve({ data: { join_code: legacyCode, view_code: '' } }) : cur.role === 'editor' ? sb.rpc('cookbook_codes', { hh: household.id }) : Promise.resolve({ data: null })
  ]);
  members = all.data || (cached?.members || []);
  if (codes.data){ household.join_code = codes.data.join_code; household.view_code = codes.data.view_code; }
  boot(cached?.household?.id === household.id ? cached : null);
  loadPlan();
}
function boot(cached){
  if (booted) return;
  store.set('sb-been-here', '1');
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
  if (event === 'PASSWORD_RECOVERY'){ session = s; if (!resetting) setTimeout(newPasswordScreen, 0); return; }
  if (event === 'SIGNED_IN' && !booted && s?.user?.id !== session?.user?.id){ session = s; setTimeout(start, 0); }
  if (event === 'SIGNED_OUT'){ session = null; try { Object.keys(localStorage).filter(k => /^sb-(offline|outbox)-/.test(k)).forEach(k => localStorage.removeItem(k)); } catch {} if (booted) location.reload(); else setTimeout(signInScreen, 0); }
});

window.Backend = {
  start(cb){ onReady = cb; start(); },
  photoUrl, clip, importBackup, shareRecipe, getShared, findPhotos, useStockPhoto,
  get household(){ return household; }, get members(){ return members; },
  get cookbooks(){ return cookbooks; }, get role(){ return household?.role || 'editor'; },
  // whoever started the cookbook manages its people; if they've gone, any editor can
  get canManage(){ const me = session?.user?.id; return household?.created_by === me || (household?.role === 'editor' && !members.some(m => m.user_id === household?.created_by)); },
  userId: () => session?.user?.id,
  switchTo(id){ store.set(currentKey(), id); location.hash = '#book'; location.reload(); },
  async createCookbook(name){
    const me = members.find(m => m.user_id === session.user.id)?.display_name || cookbooks[0]?.myName || '';
    const { data, error } = await sb.rpc('create_household', { cookbook_name: name || bookNameFor(me), my_name: me });
    if (error) throw error; return data;
  },
  async joinCookbook(code){
    const me = members.find(m => m.user_id === session.user.id)?.display_name || cookbooks[0]?.myName || '';
    const { data, error } = await sb.rpc('join_household', { code, my_name: me });
    if (error) throw { message: /code/i.test(error.message) ? 'No cookbook has that code. Check it and try again.' : error.message };
    clearPendingJoin(); return data;
  },
  async renameCookbook(name){ const { error } = await sb.from('households').update({ name }).eq('id', household.id); if (error) throw error; household.name = name; const c = cookbooks.find(x => x.id === household.id); if (c) c.name = name; },
  async setRole(userId, role){ const { error } = await sb.rpc('set_member_role', { hh: household.id, member: userId, new_role: role }); if (error) throw error; const m = members.find(x => x.user_id === userId); if (m) m.role = role; if (userId === session.user.id) household.role = role; },
  async removeMember(userId){ const { error } = await sb.rpc('remove_member', { hh: household.id, member: userId }); if (error) throw error; members = members.filter(x => x.user_id !== userId); },
  async newCodes(){ const { data, error } = await sb.rpc('new_codes', { hh: household.id }); if (error) throw error; household.join_code = data.join_code; household.view_code = data.view_code; },
  async leave(){
    if (members.every(m => m.user_id === session.user.id)) await removeHouseholdPhotos(household.id);
    const { error } = await sb.rpc('leave_household', { hh: household.id }); if (error) throw error;
    store.set(currentKey(), ''); location.hash = '#book'; location.reload();
  },
  // a viewer keeping a copy of a recipe in a cookbook of their own, photo and all
  async copyTo(r, targetId){
    let photo = null;
    if (r.photo){
      const { data: blob } = await sb.storage.from('photos').download(r.photo);
      if (blob){ const path = `${targetId}/${uuid()}.jpg`; const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: blob.type || 'image/jpeg' }); if (!error) photo = path; }
    }
    const id = (r.title || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) + '-' + uuid().slice(0, 4);
    const keep = ['title', 'category', 'serves', 'totalMins', 'ingredients', 'steps', 'source', 'tags', 'spice', 'bestCook', 'story'];
    const data = Object.fromEntries(keep.filter(k => r[k] != null).map(k => [k, r[k]]));
    Object.assign(data, { photo, photos: [], note: '', favourite: false, addedBy: session.user.id, createdAt: Date.now(), updatedAt: Date.now(),
      story: [r.story, `Copied from ${household.name}.`].filter(Boolean).join(' ') });
    const { error } = await sb.from('recipes').insert({ household_id: targetId, id, data });
    if (error) throw { code: /free_limit/.test(error.message) ? 'free_limit' : 'failed', message: error.message };
    return id;
  },
  async sendFeedback(message){
    const me = members.find(m => m.user_id === session.user.id);
    const { error } = await sb.from('feedback').insert({ message, name: me?.display_name || '', household_id: household.id, app: navigator.userAgent.slice(0, 200) });
    if (error) throw error;
  },
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
  // account settings
  get provider(){ const p = session?.user?.app_metadata?.providers || [session?.user?.app_metadata?.provider]; return p.includes('google') && !p.includes('email') ? 'google' : 'email'; },
  myName(){ return members.find(m => m.user_id === session?.user?.id)?.display_name || cookbooks[0]?.myName || ''; },
  async setMyName(name){
    // the same name in every cookbook this person belongs to
    const { error } = await sb.from('members').update({ display_name: name }).eq('user_id', session.user.id);
    if (error) throw error;
    members.forEach(m => { if (m.user_id === session.user.id) m.display_name = name; }); cookbooks.forEach(c => c.myName = name);
  },
  async setEmail(email){ const { error } = await sb.auth.updateUser({ email }, { emailRedirectTo: location.origin + location.pathname }); if (error) throw error; },
  async setPassword(password){ const { error } = await sb.auth.updateUser({ password }); if (error) throw error; },
  // Deletes this person's account. If nobody else shares the cookbook, its recipes, lists and photos go too;
  // otherwise the cookbook stays with the others.
  async deleteAccount(progress){
    // photos of every cookbook this person is the last one in
    for (const c of cookbooks){
      const all = await sb.from('members').select('user_id').eq('household_id', c.id);
      if (all.error) throw all.error;
      if ((all.data || []).every(m => m.user_id === session.user.id)){ progress?.('Deleting photos…'); await removeHouseholdPhotos(c.id); }
    }
    // photos of recipes this person shared as links
    const mine = await sb.from('shared_recipes').select('id, data').eq('created_by', session.user.id);
    const files = (mine.data || []).map(x => x.data?.photo).filter(Boolean);
    if (files.length) await sb.storage.from('shared').remove(files).catch(() => {});
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
