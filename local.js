/* Spoonbook's own smarts, running on the phone with no AI and no per-use cost:
   - reading a recipe from pasted text or a photo of a cookbook page
   - combining the shopping list and sorting it by supermarket aisle
   - rough calories from the UK government's food data (McCance & Widdowson's CoFID) */
(() => {
const FR = { '½': .5, '¼': .25, '¾': .75, '⅓': 1/3, '⅔': 2/3, '⅛': .125 };
const QTY = /^(?:about\s+|approx\.?\s+)?([\d½¼¾⅓⅔⅛]|a (?:pinch|handful|splash|knob|few|little|small|large|thumb)|pinch|handful|small|large|medium|thumb|juice|zest|salt|black pepper|freshly|knob|splash|dash|drizzle|sprig|bunch|clove)/i;
const VERB = /^(add|heat|preheat|put|place|mix|stir|whisk|combine|tip|pour|fry|cook|bake|blitz|blend|bring|season|serve|remove|cut|slice|chop|make|in a|meanwhile|to make|now|once|when|leave|cover|melt|simmer|roast|boil|drain|spread|scatter|transfer|return|line|grease|beat|fold|rub|toss|marinate|arrange|sprinkle|warm|for the|first|then|using|take|turn|set|lay|divide|brush|garnish|burn|enjoy|squeeze|shape|roll|knead|stuff|dip|coat|grill|it will|allow|let|repeat|finish|reduce|lower|increase|check|carefully|gently|quickly|finally|next|after|while|you can|if)\b/i;
const HEAD_ING = /^(ingredients?|you will need|you'll need|what you need|for the [a-z ,&]+)\s*:?$/i;
const HEAD_STEP = /^(method|instructions?|directions?|steps?|preparation|how to make( it)?)\s*:?$/i;
const JUNK = /^(print( recipe)?|jump to recipe|save( recipe)?|pin( it)?|share|rate( this)?( recipe)?|advertisement|ad|reviews?|\d+\s*(reviews?|comments?|ratings?)|nutrition\b.*|kcal\b.*|(calories|kcal|sugars?|saturates|salt|fat|protein|carbs?|carbohydrates?|fibre|fiber|sodium|cholesterol)\s*[:\d].*|shop ingredients|per portion:?|skip to (content|recipe)|tap to (view|check)|read more|watch( video)?|video|newsletter|sign up.*|subscribe.*|cookie.*|step \d+ of \d+|\d+|©.*|all rights reserved.*)$/i;
const META = /^(serves|servings?|makes|yield|(?:prep(?:aration)?|cook(?:ing)?|total)(?:\s+time)?(?=\s*:|\s+time|\s+\d)|ready in|difficulty|level)\s*:?\s*(.*)$/i;

const clean = l => l.replace(/ /g, ' ').replace(/^[\s•●▪◦‣∙·*\-–—▢☐□✓✔]+/, '').replace(/^step\s*\d+\s*[:.)-]?\s*/i, '').replace(/\s+/g, ' ').trim();
// a group heading inside an ingredient list: "For the marinade:" (no amount, ends with a colon)
const isHead = l => /:\s*$/.test(l) && !/^\s*[\d½¼¾⅓⅔⅛]/.test(l) && String(l).length <= 60;
const asHead = l => { const t = String(l).replace(/\s*:?\s*$/, '').trim(); return t.charAt(0).toUpperCase() + t.slice(1) + ':'; };
const isStep = l => !QTY.test(l) && (l.length > 110 || (/[.!]$/.test(l) && (l.length > 45 || VERB.test(l))) || (VERB.test(l) && l.length > 25));
function mins(t){ const h = t.match(/(\d+)\s*(h|hr|hrs|hour|hours)\b/i), m = t.match(/(\d+)\s*(m|min|mins|minute|minutes)\b/i); const v = (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0); return v || null; }

/* Pasted text or recognised photo text → a draft recipe. */
function parseRecipe(text){
  const src = String(text || '').replace(/\r/g, '').split('\n');
  const bulleted = new Set();
  let raw = [];
  const paraAt = new Set(); let gapBefore = false;
  for (const line of src){ const c = clean(line); if (!c){ gapBefore = true; continue; } if (gapBefore) paraAt.add(raw.length); gapBefore = false; if (/^\s*[•●▪◦‣∙·*\-–—▢☐□✓✔]/.test(line)) bulleted.add(raw.length); raw.push(c); }
  const keep = raw.map((l, i) => !/^\d{1,2}[.)]?$/.test(l)); raw = raw.filter((_, i) => keep[i]);
  const bul = new Set(), para = new Set(); { let j = 0; keep.forEach((k, i) => { if (k){ if (bulleted.has(i)) bul.add(j); if (paraAt.has(i)) para.add(j); j++; } }); }
  const CONT_END = /(,|\band|\bor|\bfinely|\broughly|\binto|\bof|\bthe|\ba|\bthinly|\bcut|\bpeeled|\bfresh|\bbut|\bon|\bwith|\bto|\bin|\bfor|\bat|\bdried|\bground|\bwhole|\blarge|\bsmall|\bmedium)$/i;
  const CONT_START = /^(chopped|sliced|diced|crushed|peeled|grated|minced|halved|quartered|drained|trimmed|rinsed|deseeded|torn|pierced|softened|melted|beaten|to serve|to taste|or |and |plus |\(|leaves\b|the tartness)/i;
  const joins = (prev, l, i) => !bul.has(i) && prev && !QTY.test(l) && (CONT_END.test(prev) || CONT_START.test(l));
  // a numbered method often comes as "1." on its own line: drop the lone numbers
  const out = { title: '', serves: '', totalMins: null, prepMins: null, cookMins: null, ingredients: [], steps: [], warnings: [] };
  let mode = null; const pre = [], preAt = [];
  for (let i = 0; i < raw.length; i++){
    let l = raw[i];
    const meta = l.match(META);
    if (meta && l.length < 60){
      const k = meta[1].toLowerCase(), v = meta[meta.length - 1];
      if (/serv|make|yield/.test(k)){ if (!out.serves && v){ const num = v.match(/\d+(?:\s*[-–]\s*\d+)?/); out.serves = num && /serv/.test(k) ? num[0].replace(/\s+/g, '') : v.replace(/^:?\s*/, '').replace(/\s*(people|portions)$/i, ''); } continue; }
      if (/total|ready/.test(k)){ out.totalMins = mins(v) || out.totalMins; continue; }
      if (/prep/.test(k)){ out.prepMins = mins(v); continue; }
      if (/cook/.test(k) && mins(v)){ out.cookMins = mins(v); continue; }
      if (/difficulty|level/.test(k)) continue;
    }
    if (HEAD_ING.test(l)){ mode = 'ing'; if (/^for the /i.test(l)) out.ingredients.push(asHead(l)); continue; }
    if (HEAD_STEP.test(l)){ mode = 'step'; continue; }
    // a "Cook's tip" or "Variation" box sits beside the recipe in many cookbooks: leave it out
    if (/^(cook['’]?s tips?|tips?|variations?|notes?|serving suggestions?)\s*:?$/i.test(l)){ mode = 'skip'; continue; }
    // printed steps often start "3 ▲" (read from a photo as "3 A"): that's the method
    const mark = l.match(/^(\d{1,2})\s*[▲△►▶A]\s+(?=[A-Z])/);
    if (mark && mode !== null){ l = l.slice(mark[0].length); mode = 'step'; out.steps.push(l); continue; }
    if (mode === 'skip') continue;
    if (JUNK.test(l)) continue;
    if (mode === null){ pre.push(l); preAt.push(para.has(i)); continue; }
    // a new paragraph of sentences after the ingredient list is the method, even with no "Method" heading
    if (mode === 'ing' && para.has(i) && out.ingredients.length >= 3 && !QTY.test(l) && !isHead(l) && raw[i + 1] && !QTY.test(raw[i + 1]) && !isHead(raw[i + 1]) && (l + raw[i + 1]).length > 50){ mode = 'step'; }
    if (mode === 'ing'){
      // long prose inside the ingredient list means the method has started without a heading
      if (isStep(l) && l.length > 60 && out.ingredients.length){ mode = 'step'; out.steps.push(l); continue; }
      // a wrapped line from a photo continues the previous ingredient
      if (isHead(l) || /^(to serve|for the [a-z ,&]+|for serving|to garnish)$/i.test(l)){ out.ingredients.push(asHead(l)); continue; }
      if (joins(out.ingredients[out.ingredients.length - 1], l, i)) out.ingredients[out.ingredients.length - 1] += ' ' + l;
      else out.ingredients.push(l);
    } else {
      const prev = out.steps[out.steps.length - 1];
      if (prev && !bul.has(i) && !/[.!?:)]$/.test(prev) && /^[a-z(]/.test(l)) out.steps[out.steps.length - 1] = prev + ' ' + l;
      else out.steps.push(l);
    }
  }
  // No headings at all: sort lines by what they look like.
  // A page with no headings but clear paragraphs (a cookbook): short lines with amounts are the ingredients,
  // prose paragraphs are the method, and prose before the first instruction is the introduction.
  if (!out.ingredients.length && !out.steps.length && preAt.filter(Boolean).length >= 2){
    const paras = []; pre.forEach((l, k) => { if (!paras.length || preAt[k]) paras.push([]); paras[paras.length - 1].push(l); });
    const joinP = ls => ls.reduce((a, l) => !a ? l : /[a-z][-–]$/.test(a) && /^[a-z]/.test(l) && !/^(and|or|to|the|a|of|in|with)\b/.test(l) ? a.replace(/[-–]$/, '') + l : a + ' ' + l, '');
    const ing = [], prose = []; let titleP = null;
    paras.forEach((p, k) => {
      const amt = p.filter(l => QTY.test(l)).length, avg = p.reduce((a, l) => a + l.length, 0) / p.length;
      if (k === 0 && p.length <= 2 && !amt && avg < 80) titleP = p;
      else if (amt && (amt / p.length >= 0.4 || avg < 45)) ing.push(...p.map(l => /^for the [a-z ,&]+:?$/i.test(l) ? asHead(l) : l));
      else prose.push(joinP(p).replace(/^[^A-Za-z0-9]+/, ''));
    });
    const first = prose.findIndex(t => VERB.test(t) && t.length > 25);
    if (ing.length && first >= 0){
      out.ingredients = ing.filter(l => !META.test(l));
      const intro = prose.slice(0, first).filter(t => t.length > 60).join(' ');
      if (intro) out.intro = intro;
      out.steps = prose.slice(first).filter(t => t.length > 15 && !META.test(t));
      pre.length = 0; if (titleP) pre.push(...titleP);
    }
  }
  if (!out.ingredients.length && !out.steps.length){
    const lines = [...pre]; pre.length = 0;
    const first = lines.findIndex(l => QTY.test(l) || isStep(l));
    pre.push(...lines.slice(0, Math.max(0, first)));
    for (const l of lines.slice(Math.max(0, first))){
      if (QTY.test(l) && l.length < 140) out.ingredients.push(l);
      else if (isStep(l)) out.steps.push(l);
      else if (/^[a-z(]/.test(l) && out.steps.length) out.steps[out.steps.length - 1] += ' ' + l;
      else if (!out.steps.length) out.ingredients.push(l);
    }
  }
  // Ingredients found but the method sat before them (a cookbook page with the ingredients in a side column,
  // read left column first): the paragraphs before are the method, after an intro that isn't instructions.
  if (out.ingredients.length && !out.steps.length && pre.length > 2){
    const paras = []; pre.forEach((l, k) => { if (!paras.length || preAt[k]) paras.push([]); paras[paras.length - 1].push(l); });
    const joinP = ls => ls.reduce((a, l) => !a ? l : /[a-z][-–]$/.test(a) && /^[a-z]/.test(l) && !/^(and|or|to|the|a|of|in|with)\b/.test(l) ? a.replace(/[-–]$/, '') + l : a + ' ' + l, '');
    // a paragraph that's mostly amounts ("for the marinade" whose heading didn't read) is more ingredients
    const extra = [];
    const keepP = paras.filter((p, k) => { if (k === 0) return true; const amt = p.filter(l => QTY.test(l)).length;
      if (amt && amt / p.length >= 0.5){ extra.push(...p.map(l => /^for the /i.test(l) && !QTY.test(l) ? asHead(l) : l)); return false; } return true; });
    paras.length = 0; paras.push(...keepP);
    if (extra.length) out.ingredients.unshift(...extra);
    const texts = paras.map(joinP), first = texts.findIndex((t, k) => k > 0 && VERB.test(t.replace(/^[^A-Za-z]+/, '')) && t.length > 30);
    if (first > 0){
      const intro = texts.slice(1, first).filter(t => t.length > 60).join(' ');
      if (intro) out.intro = intro;
      out.steps = texts.slice(first).map(t => t.replace(/^[^A-Za-z0-9]+/, '')).filter(t => t.length > 15);
      pre.length = paras[0].length;
    }
  }
  // Title: the first short line before the recipe proper that isn't chatter.
  // the chatty paragraph before the recipe starts (a cookbook's introduction) is kept as the story
  if (!out.intro && out.steps.length){ const t0 = pre.map(l => l.replace(/^[^A-Za-z]+/, '')); const prose = t0.filter((l, k) => /[a-z]{3,}/.test(l) && !QTY.test(l) && (l.split(' ').length >= 4 || (/^[a-z]/.test(l) && k && t0[k - 1].split(' ').length >= 4)));
    const story = prose.join(' ').replace(/\s+/g, ' ').trim().replace(/^[a-z]\s+(?=[A-Z])/, ''); if (story.length > 60 && story.length < 1500) out.intro = story; }
  const tt = l => l.replace(/^[\d|.:;\-–\s]{1,5}(?=[A-Z])/, '');
  out.title = (pre.map(tt).find(l => l.length >= 3 && /[A-Za-z][a-z]{2,}/.test(l) && l.length <= 80 && !/[.!?]$/.test(l) && !QTY.test(l) && !/^(by |recipe from|from |posted|updated|home|recipes?$)/i.test(l)) || '').replace(/\s*(recipe)$/i, '').replace(/^\d{1,3}\s+(?=[A-Za-z])/, '');
  if (!out.totalMins && (out.prepMins || out.cookMins)) out.totalMins = (out.prepMins || 0) + (out.cookMins || 0);
  // "Serves 4" buried in an intro sentence; "1 Heat the oil…" numbered steps
  if (!out.serves){ const m = raw.join(' ').match(/(?:^|[^a-z])(?:serves|feeds)\s*(\d+(?:\s*[-–]\s*\d+)?)\b|\bfor\s+(\d+(?:\s*[-–]\s*\d+)?)\s+(?:people|persons|servings|adults)\b/i); if (m) out.serves = (m[1] || m[2]).replace(/\s+/g, ''); }
  out.steps = out.steps.map(l => l.replace(/^\d{1,2}\s*[.)]?\s+(?=[A-Z])/, '').replace(/^[▲△►▶]\s*/, '').replace(/^A\s+(?=(In|Heat|Add|Mix|Place|Put|Stir|Pour|Cook|Bake|Fry|Make|Using|Meanwhile|Remove|Serve|Preheat|Combine|Whisk|Bring)\b)/, ''));
  // scraps from a photo (smudges, page numbers, bits of pictures) that ended up as a step
  out.steps = out.steps.filter(l => { const w = l.split(/\s+/).length; if (VERB.test(l)) return true; const toks = l.split(/\s+/); if (toks.filter(t => /^[("'“‘]?[A-Za-z]{4,}/.test(t)).length < 2) return false; const good = toks.filter(t => /^[(\["'“‘]?[A-Za-z][a-z'’-]+[.,;:!?)\]"'”’]*$|^\d/.test(t)).length; return w < 4 ? /[a-z]{3,}/.test(l) : good / toks.length >= 0.6; });
  out.ingredients = out.ingredients.filter(l => l.length > 1 && l.length < 200);
  out.ingredients = out.ingredients.filter((l, k, a) => !isHead(l) || (a[k + 1] && !isHead(a[k + 1])));
  if (!out.ingredients.length) out.warnings.push('No ingredients found');
  if (!out.steps.length) out.warnings.push('No method found');
  return out;
}

/* ---------- photo → text, on the phone (Tesseract, open source) ---------- */
let tess = null;
function loadTesseract(){
  if (window.Tesseract) return Promise.resolve();
  return tess = tess || new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = res; s.onerror = () => { tess = null; rej(new Error('load')); };
    document.head.appendChild(s);
  });
}
// turns a photo into a clean picture for reading: turned the right way up, cut down to just the recipe,
// larger, greyscale and higher-contrast
async function prepImage(file, opt = {}){
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const rot = ((opt.rot || 0) % 360 + 360) % 360, side = rot === 90 || rot === 270;
  const rw = side ? bmp.height : bmp.width, rh = side ? bmp.width : bmp.height;
  const b = opt.box || { x: 0, y: 0, w: 1, h: 1 };
  const cw = Math.max(1, b.w * rw), ch = Math.max(1, b.h * rh);
  const k = Math.min(opt.colour ? 1 : 2.5, (opt.max || 2400) / Math.max(cw, ch));
  const c = document.createElement('canvas'); c.width = Math.round(cw * k); c.height = Math.round(ch * k);
  const g = c.getContext('2d'); if (!opt.colour) g.filter = 'grayscale(1) contrast(1.35)';
  g.scale(k, k); g.translate(-b.x * rw, -b.y * rh);
  g.translate(rw / 2, rh / 2); g.rotate(rot * Math.PI / 180); g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  return c;
}
// how much of this looks like real words: photos taken sideways or of pictures come out as gibberish
function wordiness(text){
  const toks = String(text).split(/\s+/).filter(Boolean);
  if (toks.length < 8) return 0;
  const good = toks.filter(t => /^[(\["'“‘]?[A-Za-z][a-z'’-]{1,}[.,;:!?)\]"'”’]*$|^\d+([.,/½¼¾-]\d+)?(g|kg|ml|l|oz|lb|tbsp|tsp)?[.,]?$|^[½¼¾⅓⅔]$/.test(t) && !/[A-Z]{2,}[a-z]+[A-Z]/.test(t)).length;
  return good / toks.length;
}
// Cookbooks often print the ingredients in a column beside the method. Reading straight across mixes the two,
// so find the gap between the columns (it can lean a little if the photo was taken at an angle) and read
// each column on its own: the left one first, then the right.
function splitColumns(lines, width, detail, one){
  // leave out stray marks and scraps of pictures before looking for columns, so they can't fake a gap
  const JUNKW = /^[_|\\/~^*•·:;.,'‘’"“”=&{}\[\]™©®-]+$/;
  let ls = lines.map(l => ({ ...l, words: (l.words || []).filter(w => w.text && !JUNKW.test(w.text)) }))
    .filter(l => l.words.some(w => /[A-Za-z]{3,}|\d/.test(w.text)));
  if (ls.length < 6 || !width) return null;
  const spaces = [];
  ls.forEach(l => { for (let i = 1; i < l.words.length; i++) spaces.push(l.words[i].bbox.x0 - l.words[i - 1].bbox.x1); });
  spaces.sort((a, b) => a - b);
  const med = spaces[Math.floor(spaces.length / 2)] || 10, minGap = Math.max(med * 3, width * 0.025);
  // headings in bigger print (the title) go first, whole, rather than being cut at a column gap
  const hts = ls.flatMap(l => l.words.map(w => w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b), hMed = hts[Math.floor(hts.length / 2)] || 20;
  const isBig = l => l.words.length <= 8 && l.words.reduce((a, w) => a + (w.bbox.y1 - w.bbox.y0), 0) / l.words.length > hMed * 1.45;
  const heads = ls.filter(isBig); ls = ls.filter(l => !isBig(l));
  const fit = ps => { const n = ps.length, my = ps.reduce((a, p) => a + p.y, 0) / n, mx = ps.reduce((a, p) => a + p.x, 0) / n;
    const sxy = ps.reduce((a, p) => a + (p.y - my) * (p.x - mx), 0), syy = ps.reduce((a, p) => a + (p.y - my) ** 2, 0); const b = syy ? sxy / syy : 0; return { a: mx - b * my, b }; };
  // find the clearest gap between columns in this stretch of the page, cut there, then look again on each side
  // (some books have three columns: ingredients, then the method in two)
  const cols = (rows, x0, x1, depth) => {
    const span = x1 - x0, pts = [];
    rows.forEach(ws => { let best = null;
      const real = w => /[A-Za-z]{3,}/.test(w.text);
      for (let i = 1; i < ws.length; i++){ const g = ws[i].bbox.x0 - ws[i - 1].bbox.x1, x = (ws[i].bbox.x0 + ws[i - 1].bbox.x1) / 2;
        // a real gap between columns has words on both sides of it
        if (x > x0 + span * 0.15 && x < x1 - span * 0.12 && ws.slice(0, i).some(real) && ws.slice(i).some(real) && (!best || g > best.g)) best = { g, x }; }
      if (best && best.g >= minGap) pts.push({ x: best.x, y: (ws[0].bbox.y0 + ws[0].bbox.y1) / 2 }); });
    if (depth > 2 || pts.length < 3 || pts.length < rows.length * 0.15) return [rows];
    let f = fit(pts); const kept = pts.filter(p => Math.abs(p.x - (f.a + f.b * p.y)) < width * 0.05);
    if (kept.length < 3) return [rows];
    f = fit(kept);
    // the gutter only runs as far up and down the page as the columns do
    const yTop = Math.min(...kept.map(p => p.y)) - hMed * 3, yBot = Math.max(...kept.map(p => p.y)) + hMed * 3;
    const L = [], R = [];
    rows.forEach(ws => { const y = (ws[0].bbox.y0 + ws[0].bbox.y1) / 2, gx = f.a + f.b * y, inside = y >= yTop && y <= yBot;
      // only cut a line where it actually has a gap at the gutter
      let cut = -1;
      let cg = 0;
      for (let i = 1; i < ws.length; i++){ const g = ws[i].bbox.x0 - ws[i - 1].bbox.x1; if (g >= minGap * 0.6 && g > cg && ws[i - 1].bbox.x1 <= gx + width * 0.03 && ws[i].bbox.x0 >= gx - width * 0.03){ cut = i; cg = g; } }
      // no clear gap right at the gutter but words on both sides: cut at the widest gap near it
      if (cut < 0 && inside && ws[0].bbox.x0 < gx - width * 0.02 && ws[ws.length - 1].bbox.x1 > gx + width * 0.02){ let bd = Infinity;
        for (let i = 1; i < ws.length; i++){ const g = ws[i].bbox.x0 - ws[i - 1].bbox.x1, c = (ws[i].bbox.x0 + ws[i - 1].bbox.x1) / 2, d = Math.abs(c - gx);
          if (g >= med * 1.5 && d < width * 0.1 && d - g * 0.5 < bd){ bd = d - g * 0.5; cut = i; } } }
      if (cut > 0){ L.push(ws.slice(0, cut)); R.push(ws.slice(cut)); }
      else if (ws[ws.length - 1].bbox.x1 <= gx + width * 0.03) L.push(ws);
      else if (ws[0].bbox.x0 >= gx - width * 0.03) R.push(ws);
      else (ws[0].bbox.x0 < gx - width * 0.02 ? L : R).push(ws); });
    if (L.length < 2 || R.length < 2) return [rows];
    return [...cols(L, x0, f.a + f.b * (L[0][0].bbox.y0), depth + 1), ...cols(R, f.a + f.b * (R[0][0].bbox.y0), x1, depth + 1)];
  };
  const found = cols(ls.map(l => l.words), 0, width, 0);
  if (found.length < 2 && !detail && !one) return null;
  const clean = ws => {
    // a word or two the reader wasn't sure of, on their own, are usually smudges or bits of pictures
    ws = ws.filter(w => !/^[_|\\/~^*•·:;'‘’"“”&{}\[\]-]+$/.test(w.text));
    if (!ws.length) return null;
    const conf = ws.reduce((a, w) => a + (w.confidence ?? 100), 0) / ws.length;
    if (ws.length <= 2 && conf < 60 && !/\d/.test(ws.map(w => w.text).join(''))) return null;
    // a mark in the margin between paragraphs (no real word in it) would hide the gap between them
    if (!ws.some(w => /[A-Za-z]{3,}|\d/.test(w.text))) return null;
    return { text: ws.map(w => w.text).join(' '), x: ws[0].bbox.x0, x1: Math.max(...ws.map(w => w.bbox.x1)), w: ws[ws.length - 1].bbox.x1 - ws[0].bbox.x0, y0: Math.min(...ws.map(w => w.bbox.y0)), y1: Math.max(...ws.map(w => w.bbox.y1)) };
  };
  const asText = col => {
    col = col.map(clean).filter(Boolean).sort((a, b) => a.y0 - b.y0);
    if (!col.length) return '';
    // the usual distance from one line to the next
    const pitches = col.slice(1).map((l, i) => l.y0 - col[i].y0).filter(g => g > 0).sort((a, b) => a - b), pitch = pitches[Math.floor(pitches.length / 2)] || 40;
    const widths = col.map(l => l.w).sort((a, b) => a - b), full = widths[Math.floor(widths.length * 0.8)] || 1;
    let out = col[0].text;
    for (let i = 1; i < col.length; i++){ const l = col[i], p = col[i - 1], step = l.y0 - p.y0;
      // a line set in further than the one above, not starting with an amount, carries on the line above
      if (l.x - p.x > width * 0.012 && !/^[\d½¼¾⅓⅔]/.test(l.text) && step < pitch * 1.4) out += ' ' + l.text;
      // a bigger space than usual, or a short line ending a sentence then a capital, starts a new paragraph
      else out += ((step > pitch * 1.5 && (/[.!?:]$/.test(p.text) || /^[A-Z0-9"“‘(]/.test(l.text))) || (/[.!]$/.test(p.text) && /^[A-Z]/.test(l.text) && p.w < full * 0.72) ? '\n\n' : '\n') + l.text; }
    return out;
  };
  if (detail) return { heads: heads.map(l => clean(l.words)).filter(Boolean), cols: found.map(col => col.map(clean).filter(Boolean).sort((a, b) => a.y0 - b.y0)) };
  // the biggest print first: that's the title
  const hsz = l => l.words.reduce((a, w) => a + (w.bbox.y1 - w.bbox.y0), 0) / l.words.length;
  return [[...heads].sort((a, b) => hsz(b) - hsz(a)).map(l => clean(l.words)).filter(Boolean).map(h => h.text).join('\n'), ...found.map(asText)].filter(Boolean).join('\n\n');
}
/* ---------- tidying words the photo reader got slightly wrong (no AI: a word list and a few rules) ---------- */
const COOK_WORDS = new Set('bhajia bhajias pakora pakoras tarka dhansak pasanda jalfrezi rogan josh phall pathia oil salt sugar butter flour water onion onions garlic pepper stir boil heat cook pan oven bake fry chop slice dice mix add serve sauce cream milk egg eggs rice pasta stock lemon lime herbs spices cloves leaves ajwain allspice amaretti amchur anchovy andouille arborio asafoetida aubergine aubergines baharat balsamic balti bashed basmati beansprouts bechamel beetroot bhaji bhajis biryani blitz blitzed blitzing bouillon bouquet bourguignon braise braised brioche brisket bulgur buttermilk cacciatore cajun calvados cannellini capers caraway cardamom cardamoms casserole cassoulet cavolo chana chapati chapatis charred chermoula chilli chillies chipotle chorizo ciabatta cm colander coriander cornflour courgette courgettes couscous creme crumble cumin cupful cupfuls curd dal dauphinoise demerara deseed deseeded dhal dijon dopiaza edamame emmental enchilada enchiladas fajita fajitas falafel fan farfalle fenugreek feta filo focaccia fraiche freezer fridge frittata frying fusilli galangal garam gas gnocchi gochujang gratin gremolata gruyere guacamole halloumi halved harissa hob hoisin houmous hummus jalapeno jalapenos jalfrezi jollof kalonji karahi kashmiri kasoori katsu kedgeree keema kg kofta korma labneh laksa lardons lasagne lb lbs linguine madras makhani manchego mangetout marinade marinate marinated marinating masala mascarpone methi microwave mirin miso ml mm moussaka mozzarella naan nduja nigella orzo oz paella pan pancetta paneer panko paprika paratha parathas parmesan parmigiano passata pastry pecorino penne pesto pilaf pilau piri polenta porcini prosciutto puree pureed purees quartered quinoa ragu raita ramekin ramekins ramen ras rasam rigatoni risotto rogan roux saag sambal samosa samosas satay saucepan schnitzel semolina shakshuka shallot shallots sichuan sieve spatula sriracha stir-fry stroganoff sumac tadka tagine tagliatelle tahini tamarind tandoori tapenade tarka tbsp teriyaki tikka tofu tortilla tortillas tray traybake traybakes tsp turmeric tzatziki udon vindaloo wasabi whisk wok worcestershire yoghurt zaatar zest zested zesty'.split(' '));
let WORDS = null;
async function loadWords(){
  if (WORDS) return WORDS;
  try { const t = await (await fetch('words.txt')).text(); WORDS = new Set(t.split('\n')); COOK_WORDS.forEach(w => WORDS.add(w)); } catch { WORDS = null; }
  return WORDS;
}
const has = w => WORDS.has(w) || COOK_WORDS.has(w);
// the list holds base words, so "releases", "stirring" and "chopped" are checked by their stems too
const known = w => has(w) || (w.length > 4 && (
  (/s$/.test(w) && has(w.slice(0, -1))) || (/es$/.test(w) && has(w.slice(0, -2))) || (/ies$/.test(w) && has(w.slice(0, -3) + 'y')) ||
  (/ed$/.test(w) && (has(w.slice(0, -2)) || has(w.slice(0, -1)) || (w[w.length - 3] === w[w.length - 4] && has(w.slice(0, -3))))) || (/ied$/.test(w) && has(w.slice(0, -3) + 'y')) ||
  (/ing$/.test(w) && (has(w.slice(0, -3)) || has(w.slice(0, -3) + 'e') || (w[w.length - 4] === w[w.length - 5] && has(w.slice(0, -4))))) ||
  (/ly$/.test(w) && has(w.slice(0, -2)))));
const ABC = 'abcdefghijklmnopqrstuvwxyz';
// letters the reader commonly mistakes for each other
const LOOKALIKE = { c: 'deo', d: 'c', e: 'co', o: 'ceaq', l: 'it', i: 'lj', t: 'lf', h: 'bn', n: 'hmr', m: 'n', r: 'n', u: 'v', v: 'uy', a: 'oe', b: 'h', f: 't', g: 'q', q: 'g', s: '', y: 'v' };
function oneOff(w){
  const out = new Map(), add = (c, look) => { if (c !== w && known(c)) out.set(c, Math.max(out.get(c) || 0, look ? 2 : 1)); };
  for (let i = 0; i <= w.length; i++){
    if (i < w.length){ add(w.slice(0, i) + w.slice(i + 1));
      for (const ch of ABC) if (ch !== w[i]) add(w.slice(0, i) + ch + w.slice(i + 1), (LOOKALIKE[w[i]] || '').includes(ch));
      if (i < w.length - 1) add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); }
    for (const ch of ABC) add(w.slice(0, i) + ch + w.slice(i));
  }
  // "rn" read for "m", "cl" for "d", "ii" for "u"
  [['rn', 'm'], ['ra', 'm'], ['m', 'rn'], ['ri', 'n'], ['cl', 'd'], ['ii', 'u'], ['vv', 'w'], ['li', 'h'], ['iri', 'm']].forEach(([a, b]) => { let k = w.indexOf(a); while (k >= 0){ const c = w.slice(0, k) + b + w.slice(k + a.length); if (known(c)) out.set(c, 2); k = w.indexOf(a, k + 1); } });
  return out;
}
function bestOf(cands){
  if (!cands.size) return null;
  const list = [...cands].sort((a, b) => b[1] - a[1] || (COOK_WORDS.has(b[0]) - COOK_WORDS.has(a[0])));
  const top = list.filter(x => x[1] === list[0][1]);
  const cook = top.filter(x => COOK_WORDS.has(x[0]));
  if (cook.length === 1) return cook[0][0];
  return top.length === 1 ? top[0][0] : null;
}
const keepCase = (orig, fixed) => /^[A-Z]/.test(orig) ? fixed[0].toUpperCase() + fixed.slice(1) : fixed;
function fixWords(text){
  if (!WORDS) return text;
  return String(text).split('\n').map(line => {
    let toks = line.split(/ +/);
    const out = [];
    for (let i = 0; i < toks.length; i++){
      let t = toks[i];
      // stray marks: a lone symbol, or a lone letter that isn't a word
      if (/^[_|¢~^•·‘'"`]+$/.test(t) || (/^[b-hj-zB-HJ-Z]$/.test(t) && out.length && i < toks.length - 1)) continue;
      t = t.replace(/^[_|¢~^•·]+(?=[A-Za-z])/, '');
      const m = t.match(/^([("'“‘]*)([A-Za-z]+)([.,;:!?)"'”’]*)$/);
      if (!m || /\d/.test(t)){ out.push(t); continue; }
      const [, pre, core, post] = m, low = core.toLowerCase();
      if (known(low) || low.length < 3 || /^[A-Z]{2,}$/.test(core)){ out.push(t); continue; }
      // a capital in the middle of a sentence is a name (India, Birmingham): leave it
      if (/^[A-Z]/.test(core) && out.length && !/[.!?:]$/.test(out[out.length - 1])){ out.push(t); continue; }
      // a word broken in two: "remair ing" → "remaining"
      const nx = toks[i + 1] && toks[i + 1].match(/^([a-z]+)([.,;:!?)]*)$/);
      if (nx && !known(nx[1]) && !post){ const j = low + nx[1]; const f = known(j) ? j : bestOf(oneOff(j)); if (f){ out.push(pre + keepCase(core, f) + nx[2]); i++; continue; } }
      // two words run together: "asieve" → "a sieve", "dothat" → "do that"
      let split = null;
      const LITTLE = /^(a|an|as|at|by|do|if|in|is|it|of|on|or|so|to|up|we|you|the|and|for|but|not|can|all|with|that|this|then|than|into|onto|until|from|over|each|your|them|they|will|very|well|when|once|also|just|more|some)$/;
      let sc = -1;
      for (let k = 1; k < low.length; k++){ const a = low.slice(0, k), b = low.slice(k);
        if (!((a.length >= 2 || a === 'a') && b.length >= 2 && known(a) && known(b))) continue;
        // prefer splits into everyday little words ("do that", not "dot hat")
        const s = (LITTLE.test(a) ? 2 : 0) + (LITTLE.test(b) ? 2 : 0) + Math.min(a.length, b.length) / 10;
        if ((LITTLE.test(a) || LITTLE.test(b) || (Math.min(a.length, b.length) >= 4 && has(a) && has(b))) && s > sc){ sc = s; split = [a, b]; } }
      // one letter wrong or missing: "gooc" → "good"
      const one = low.length >= 4 ? bestOf(oneOff(low)) : (() => { const c = [...oneOff(low)].filter(([w, s]) => s === 2 && COOK_WORDS.has(w)); return c.length === 1 ? c[0][0] : null; })();
      if (one && (!split || oneOff(low).get(one) === 2)){ out.push(pre + keepCase(core, one) + post); continue; }
      if (split){ out.push(pre + keepCase(core, split[0]) + ' ' + split[1] + post); continue; }
      out.push(t);
    }
    return out.join(' ');
  }).join('\n');
}
// of two ways of reading the same page, keep the one that makes the more sensible recipe
function recipeScore(t){
  const r = parseRecipe(t), amt = r.ingredients.filter(l => QTY.test(l) && l.length < 90).length;
  return amt * 2 - (r.ingredients.length - amt) * 1.5 + Math.min(r.steps.length, 8) * 2 + (r.steps.some(x => x.length > 40) ? 3 : 0);
}
function looksMuddled(t){
  const r = parseRecipe(t), odd = r.ingredients.filter(l => !QTY.test(l) || l.length > 90).length;
  return r.steps.length < 2 || !r.ingredients.length || odd / r.ingredients.length > 0.3;
}
function bestReading(texts){
  const ok = texts.filter(Boolean); if (ok.length < 2) return ok[0] || '';
  return ok.map(t => ({ t, s: recipeScore(t) })).sort((a, b) => b.s - a.s)[0].t;
}
// common slips when reading printed recipes
// how the reader tends to see printed fractions: ½ as "V2", "Y2", "‘2", "%"; ¼ as "Va", "Y4", "‘/4"
const UNIT_AFTER = '(?=\\s*(?:[-–—]\\s*\\S+\\s+)?(?:tsp|tbsp|teaspoons?|tablespoons?|cups?|kg|g|lb|lbs|oz|pints?|each|level|heaped|rounded)\\b)';
const FRAC_HALF = new RegExp("(^|\\s|\\d|[—–-])(?:[‘’'`]\\/?2|[‘’'`]%|\\/2|[VYUvyu][2zZo]|[VY]s|%|1\\/2|l\\/2)" + UNIT_AFTER, 'gm');
const FRAC_QTR = new RegExp("(^|\\s|\\d|[—–-])(?:[‘’'`]\\/?4|\\/4|[VYUvyu][a4A]|1\\/4|l\\/4)" + UNIT_AFTER, 'gm');
const FRAC_3Q = new RegExp("(^|\\s|\\d|[—–-])(?:3\\/4|%4)" + UNIT_AFTER, 'gm');
const fixFractions = t => t.replace(/(\d)\s*0[2z](?=\s*\/)/g, '$1 oz').replace(FRAC_3Q, '$1¾').replace(FRAC_QTR, '$1¼').replace(FRAC_HALF, '$1½')
  .replace(/(^|\s)1\/3(?=\s)/g, '$1⅓').replace(/(^|\s)2\/3(?=\s)/g, '$1⅔').replace(/(\d) ([½¼¾⅓⅔])/g, '$1$2').replace(/([½¼¾⅓⅔\d])\s*[—-]\s*(?=[½¼¾⅓⅔\d])/g, '$1–');
const fixOcr = t => fixFractions(t).replace(/(^|\s)[VY][ao]\s*[=—–-]+\s*[VYa]?[a2o](?=\s+(tsp|tbsp|cups?)\b)/g, '$1¼–½').replace(/^[a-z|.:;'’"”§\]\[]{1,2}\.?\s+(?=[\d½¼¾‘’'])/gm, '').replace(/^[B-HJ-Z§\]\[|ij]\s+(?=[a-z(])/gm, '').replace(/(^|\s)[‘’'`]\/?4(?=\s+(tsp|tbsp|cups?|kg|g|lb|oz|pints?)\b)/g, '$1¼').replace(/(^|\s)[‘’'`]\/?2(?=\s+(tsp|tbsp|cups?|kg|g|lb|oz|pints?|each)\b)/g, '$1½').replace(/(\d)\s*g[il](\d)/g, '$1 g/$2')
  .replace(/\b([Ii])na\b/g, '$1n a').replace(/\b([Oo])na\b/g, '$1n a').replace(/(^|\s)[VY]a\s*[—–-]\s*V2(?=\s)/g, '$1¼–½').replace(/(^|\s)V2(?=\s)/g, '$1½').replace(/(^|\s)Va(?=\s+(tsp|tbsp|cup))/g, '$1¼').replace(/\b(\d)%(?=\s+(tsp|tbsp|cups?|kg|g|lb|oz|pints?)\b)/g, '$1½')
  .replace(/\bthsp\b/g, 'tbsp').replace(/\b(tbsp|tsp)(?=[a-z]{3,})/g, '$1 ')
  .replace(/^([IJl|])(?=\s*(tsp|tbsp|cup|kg|g|ml|large|medium|small)\b)/gm, '1');
async function readOne(worker, page, onProgress){
  const file = page.file || page, base = { rot: page.rot || 0, box: page.box || null };
  const go = async (rot, psm = '6') => { const cv = await prepImage(file, { ...base, rot }); await worker.setParameters({ tessedit_pageseg_mode: psm }); const { data } = await worker.recognize(cv);
    // keep the lines it was reasonably sure of; scraps of pictures come out as low-confidence noise
    const lines = (data.lines || []).filter(l => l.text.trim() && (l.confidence >= 45 || wordiness(l.text) >= 0.7 || (l.words || []).length > 4));
    // ingredients printed in a column beside the method are read as their own column
    const plain = lines.length ? lines.map(l => l.text.trimEnd()).join('\n') : data.text;
    const text = bestReading([splitColumns(lines, cv.width), plain]);
    return { text: fixOcr(text), conf: data.confidence || 0, score: (data.confidence || 0) / 100 * 0.5 + wordiness(data.text) * 0.5, rot }; };
  let best = await go(base.rot);
  // looks like it's sideways or upside down: try the other ways round and keep the best
  if (best.score < 0.6) for (const r of [90, 270, 180]){ onProgress?.(-1); const t = await go((base.rot + r) % 360); if (t.score > best.score) best = t; if (best.score >= 0.7) break; }
  // a busy page (photos between the steps, several columns) can read better letting the reader find the blocks itself
  if (looksMuddled(best.text)){ onProgress?.(-2); const t = await go(best.rot, '3'); if (recipeScore(t.text) > recipeScore(best.text)) best = { ...t, score: Math.max(t.score, best.score) }; }
  return best;
}

/* ---------- telling the reader which part is which: box the ingredients, box the method ---------- */
let sharedWorker = null, idle = null;
async function getWorker(onProgress){
  await loadTesseract(); clearTimeout(idle);
  if (!sharedWorker) sharedWorker = Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') getWorker.cb?.(Math.round(m.progress * 100)); } });
  getWorker.cb = onProgress;
  return sharedWorker;
}
function releaseWorker(){ clearTimeout(idle); idle = setTimeout(async () => { const w = sharedWorker; sharedWorker = null; if (w) (await w).terminate(); }, 60000); }
async function readLines(worker, file, opt){
  const cv = await prepImage(file, opt); await worker.setParameters({ tessedit_pageseg_mode: '6' });
  const { data } = await worker.recognize(cv);
  const lines = (data.lines || []).filter(l => l.text.trim() && (l.confidence >= 45 || wordiness(l.text) >= 0.7 || (l.words || []).length > 4));
  return { lines, cv, data };
}
const STEPSTART = /^(\d{1,2}\s*[.)▲△►▶A]?\s+)?[A-Z]/;
// A quick low-detail read of the page to put the two boxes roughly in the right places, and to find the title.
async function guessLayout(file, rot = 0){
  const worker = await getWorker();
  try {
    let best = null;
    for (const r of [0, 90, 270, 180]){
      const rr = (rot + r) % 360, { lines, cv, data } = await readLines(worker, file, { rot: rr, max: 1200 });
      const score = (data.confidence || 0) / 100 * 0.5 + wordiness(data.text) * 0.5;
      if (!best || score > best.score) best = { score, lines, cv, rot: rr, text: data.text };
      if (best.score >= 0.6) break;
    }
    const { lines, cv } = best, W = cv.width, H = cv.height;
    let d = splitColumns(lines, W, true);
    if (!d){ return { rot: best.rot }; }
    const box = segs => { if (!segs.length) return null; const pad = W * 0.015;
      const x0 = Math.max(0, Math.min(...segs.map(s => s.x)) - pad), x1 = Math.min(W, Math.max(...segs.map(s => s.x1)) + pad), y0 = Math.max(0, Math.min(...segs.map(s => s.y0)) - pad), y1 = Math.min(H, Math.max(...segs.map(s => s.y1)) + pad);
      return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H }; };
    const ing = [], meth = [];
    d.cols.forEach(col => {
      // an ingredient line: an amount, short, lower-case words, and not "1 Heat the oil…" (a numbered step)
      const q = col.map(s => QTY.test(s.text) && s.text.length < 75 && /[a-z]{2,}/.test(s.text) && !VERB.test(s.text.replace(/^\d{1,2}\s*[.)▲△►▶A]?\s*/, '')));
      const nq = q.filter(Boolean).length;
      if (nq >= 3 && nq / col.length >= 0.3){
        // the ingredients: from the first amount to the last, plus a heading just above
        const first = q.indexOf(true), last = q.lastIndexOf(true);
        let a = first; if (a > 0 && (HEAD_ING.test(col[a - 1].text) || /^for the /i.test(col[a - 1].text))) a--;
        // carry on past the last amount for short lines like "salt, to taste" or "cold water, to mix"
        let z = last; while (z + 1 < col.length && col[z + 1].text.length < 60 && !/[.!?]$/.test(col[z + 1].text) && col[z + 1].y0 - col[z].y1 < (col[z].y1 - col[z].y0) * 2.5) z++;
        ing.push(...col.slice(a, z + 1));
        // prose after the list in the same column is method
        const rest = col.slice(last + 1).filter(s => s.text.length > 25);
        if (rest.length >= 2) meth.push(...rest);
      } else {
        // the method: from the first line that reads like an instruction
        const k = col.findIndex(s => { const t = s.text.replace(/^\d{1,2}\s*[.)▲△►▶A]?\s+/, ''); return s.text.length > 20 && /^[A-Z]/.test(t) && (VERB.test(t) || /^\d{1,2}\s*[.)▲△►▶]?\s+[A-Z]/.test(s.text)); });
        if (k >= 0) meth.push(...col.slice(k).filter(s => s.text.length > 3));
      }
    });
    const full = splitColumns(lines, W) || lines.map(l => l.text).join('\n');
    const info = parseRecipe(fixOcr(full));
    // the title should be real words: the biggest print that reads properly
    await loadWords();
    const real = t => { const ws = (String(t || '').toLowerCase().match(/[a-z]+/g) || []).filter(w => w.length >= 3); return ws.length && WORDS ? ws.filter(w => known(w)).length / ws.length : 0; };
    if (real(info.title) < 0.6){ const alt = [...d.heads.map(h => h.text), ...full.split('\n')].map(t => t.replace(/^[\d|.:;\-–\s]{1,5}(?=[A-Z])/, '').trim()).find(t => t.length >= 3 && t.length <= 70 && /[a-z]{3,}/i.test(t) && real(t) >= 0.75 && !QTY.test(t)); info.title = alt || ''; }
    return { rot: best.rot, ing: box(ing), method: box(meth), title: info.title, serves: info.serves, intro: info.intro };
  } catch { return null; } finally { releaseWorker(); }
}
async function readArea(worker, file, rot, box, kind, auto){
  let { lines, cv, data } = await readLines(worker, file, { rot, box });
  // a close-up taken sideways or upside down: try the other ways round
  if (auto){ const sc = d => (d.confidence || 0) / 100 * 0.5 + wordiness(d.text) * 0.5; let s = sc(data);
    for (const r of [90, 270, 180]){ if (s >= 0.6) break; const t = await readLines(worker, file, { rot: (rot + r) % 360, box }); const s2 = sc(t.data); if (s2 > s){ ({ lines, cv, data } = t); s = s2; } } }
  const JUNKW = /^[_|\\/~^*•·:;.,'‘’"“”=&{}\[\]™©®§$-]+$/;
  // a close-up often catches the edge of the next column: keep only the column(s) that are what we're after
  const d = splitColumns(lines, cv.width, true);
  if (d && d.cols.length >= 2){
    const isIng = s => QTY.test(s.text) && s.text.length < 75;
    const stat = d.cols.map(c => ({ c, x0: Math.min(...c.map(s => s.x)), x1: Math.max(...c.map(s => s.x1)), ing: c.filter(isIng).length, len: c.reduce((a, s) => a + s.text.length, 0) / Math.max(1, c.length) }));
    let keep;
    if (kind === 'ing'){ const best = stat.reduce((a, b) => b.ing > a.ing ? b : a); keep = best.ing >= 2 ? [best] : stat; }
    else keep = stat.filter(s => s.len >= 18 && s.ing / s.c.length < 0.5);
    if (keep.length && keep.length < stat.length){
      const inKeep = w => { const cx = (w.bbox.x0 + w.bbox.x1) / 2; return keep.some(k => cx >= k.x0 - 4 && cx <= k.x1 + 4); };
      lines = lines.map(l => ({ ...l, words: (l.words || []).filter(inKeep) })).filter(l => l.words.length).map(l => ({ ...l, text: l.words.map(w => w.text).join(' ') }));
    }
  }
  const plain = lines.map(l => (l.words || []).length ? l.words.map(w => w.text).filter(t => !JUNKW.test(t)).join(' ') : l.text.trim()).filter(t => /[A-Za-z]{2,}|\d/.test(t)).join('\n');
  // amounts the reader wasn't sure of, or that looked like a garbled fraction: worth a second look
  const unsure = kind === 'ing' ? lines.map(l => { const ws = (l.words || []).filter(w => !JUNKW.test(w.text)); const a = ws[0];
    if (!a || !/^[\dVYUvyu%‘’'`\/½¼¾]/.test(a.text) || !/[a-z]{3,}/i.test(ws.slice(1).map(w => w.text).join(' '))) return null;
    return (a.confidence < 70 || /^[VYUvyu%‘’'`\/]|^\d%|^\d?[\/%]/.test(a.text) || (/^\d$/.test(a.text) && ws[1] && /^(tsp|tbsp)$/i.test(ws[1].text) && a.confidence < 85)) ? ws.slice(1).map(w => w.text).join(' ') : null; }).filter(Boolean) : [];
  // the method keeps its paragraphs (one step each); an ingredient list is read line by line
  const text = kind === 'method' ? (splitColumns(lines, cv.width, false, true) || plain) : plain;
  return { text: fixOcr(text), unsure, score: (data.confidence || 0) / 100 * 0.5 + wordiness(data.text) * 0.5 };
}
async function readBoxes(pages, onProgress){
  const worker = await getWorker(onProgress);
  try {
    let ingText = '', methodText = '', scores = [], unsure = [];
    for (const p of pages){
      if (p.ing){ const r = await readArea(worker, p.file, p.rot, p.ing, 'ing', p.auto); ingText += r.text + '\n'; scores.push(r.score); unsure.push(...r.unsure); }
      if (p.method){ const r = await readArea(worker, p.file, p.rot, p.method, 'method', p.auto); methodText += r.text + '\n\n'; scores.push(r.score); }
    }
    await loadWords();
    ingText = fixWords(ingText); methodText = fixWords(methodText);
    // a close-up of the ingredients often includes the recipe's name, "serves 4" and an "Ingredients" heading above the list
    const top = parseRecipe(ingText), whole = parseRecipe(ingText + '\nMethod\n' + methodText);
    const realT = t => { const ws = (String(t || '').toLowerCase().match(/[a-z]+/g) || []).filter(w => w.length >= 3); return ws.length ? ws.filter(w => known(w)).length / ws.length : 0; };
    const title = [top.title, whole.title].find(t => t && t.length <= 60 && t.split(/\s+/).length <= 7 && realT(t) >= 0.75 && !QTY.test(t) && !/[,;.]$/.test(t) && !/\b(the|a|an|of|and|to|with|in|for)$/i.test(t)) || '';
    const lines = ingText.split('\n'), hi = lines.findIndex(l => HEAD_ING.test(l.trim()) && !/^for the /i.test(l.trim()));
    if (hi > 0) ingText = lines.slice(hi + 1).join('\n');
    // scraps that aren't words at all ("EE HCP TH pH at") are left out
    const wordy = l => { if (isHead(l)) return true; const ws = (l.toLowerCase().match(/[a-z]{3,}/g) || []); return ws.length > 0 && ws.filter(w => known(w)).length / ws.length >= 0.5; };
    const ingredients = parseRecipe('Ingredients\n' + ingText).ingredients.filter(l => !META.test(l) && l !== title && wordy(l));
    const keyOf = s => (fixWords(String(s)).toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 3).join(' ');
    const unsureKeys = unsure.map(keyOf).filter(Boolean);
    const smallMeasure = l => /^([½¼¾⅓⅔]|\d[½¼¾]?|\d?[½¼¾][–-][½¼¾\d]|\d[–-]\d)\s*(tsp|tbsp|teaspoons?|tablespoons?|cups?)\b/i.test(l);
    const check = [...new Set(ingredients)].filter(l => smallMeasure(l) && (() => { const k = keyOf(l.replace(/^[^a-z]*/i, '')); return k && unsureKeys.some(u => u === k || (u.length > 6 && k.startsWith(u.split(' ')[0]) && u.split(' ')[0].length > 4)); })());
    // the method: one step per paragraph when the page shows paragraphs, otherwise line by line
    const paras = methodText.split(/\n\s*\n/).map(p => p.split('\n').map(s => s.trim()).filter(Boolean)
      .reduce((a, l) => !a ? l : /[a-z][-–]$/.test(a) && /^[a-z]/.test(l) ? a.replace(/[-–]$/, '') + l : a + ' ' + l, '')).filter(Boolean);
    const steps = parseRecipe('Ingredients\nx\nMethod\n' + (paras.length > 1 ? paras.join('\n') : methodText)).steps;
    return { ingredients, steps, check, title, serves: whole.serves || top.serves || '', intro: '', score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0 };
  } finally { releaseWorker(); }
}
async function readPhotos(pages, onProgress){
  await loadTesseract();
  const worker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100)); } });
  try {
    // read the page as one block of lines; columns are worked out afterwards from where the words sit
    const out = [];
    for (const p of pages) out.push(await readOne(worker, p, onProgress));
    const score = out.reduce((a, o) => a + o.score, 0) / out.length;
    await loadWords();
    return { text: fixWords(out.map(o => o.text).join('\n')), score, turned: out.map(o => o.rot) };
  } finally { await worker.terminate(); }
}

/* ---------- shopping list: combine and sort by aisle ---------- */
const AISLES = [
  ['Fruit & veg', /\b(onions?|shallots?|garlic|ginger|chill(i|ies|y)|peppers?|carrots?|celery|leeks?|potato(es)?|sweet potato|tomato(es)?(?! (puree|paste|ketchup|passata))|cherry tomatoes|plum tomatoes|mushrooms?|spinach|kale|lettuce|rocket|cabbage|broccoli|cauliflower|courgettes?|aubergines?|squash|pumpkin|cucumber|beansprouts?|bean sprouts|spring onions?|asparagus|peas?(?! (frozen))|sweetcorn|baby corn|green beans|fine beans|lemons?|limes?|oranges?|apples?|bananas?|berries|strawberries|raspberries|blueberries|rhubarb|avocados?|coriander|cilantro|parsley|basil|mint|thyme|rosemary|sage|dill|tarragon|chives|lemongrass|herbs?|salad|beetroot|parsnips?|swede|turnips?|radish|fennel(?! seed)|okra|pak choi|bok choy)\b/i],
  ['Bakery', /\b(bread|loaf|rolls?|baguette|naan|wraps?|tortillas?|pittas?|flatbreads?|buns?|crumpets?|bagels?|croissants?)\b/i],
  ['Meat & fish', /\b(chicken|beef|steak|pork|lamb|mince|sausages?|bacon|pancetta|chorizo|ham|gammon|turkey|duck|salami|prosciutto|meatballs?|fillets?|medallions?|salmon|cod|haddock|tuna steak|prawns?|shrimp|fish|mussels|scallops?|mackerel|sea bass)\b/i],
  ['Dairy & eggs', /\b(milk|butter|cream|creme fraiche|crème fraîche|yogh?urt|cheese|cheddar|mozz?arella|parmesan|parmigiano|feta|halloumi|mascarpone|ricotta|paneer|eggs?|soft cheese|cream cheese|quark|ghee)\b/i],
  ['Chilled', /\b(fresh pasta|gnocchi|tofu|hummus|houmous|pastry|puff pastry|shortcrust|filo|fresh custard|pesto)\b/i],
  ['Rice, pasta & grains', /\b(rice|basmati|arborio|pasta|spaghetti|penne|lasagne sheets?|tagliatelle|fusilli|macaroni|noodles?|couscous|bulgur|quinoa|oats|lentils|barley)\b/i],
  ['Tins, jars & packets', /\b(tins?|cans?|canned|tinned|chopped tomatoes|passata|tomato (puree|paste)|coconut milk|coconut cream|beans|chickpeas|kidney beans|stock|stock cubes?|stock pot|gravy|bouillon|olives|capers|jam|honey|peanut butter|curry paste|soup)\b/i],
  ['Herbs, spices & seasoning', /\b(salt|pepper(corns)?|black pepper|cumin|coriander (seeds?|ground)|ground coriander|turmeric|paprika|cayenne|chilli (powder|flakes)|garam masala|curry powder|cinnamon|nutmeg|cloves|cardamom|star anise|fennel seeds?|mustard seeds?|fenugreek|saffron|bay lea(f|ves)|oregano|mixed herbs|dried|spice|seasoning|five spice|allspice|vanilla)\b/i],
  ['Oils, sauces & condiments', /\b(oil|olive oil|vinegar|soy sauce|fish sauce|worcestershire|ketchup|mayonnaise|mayo|mustard|sriracha|hot sauce|sweet chilli|oyster sauce|hoisin|tahini|mirin|horseradish|chutney|relish|brown sauce|bbq sauce)\b/i],
  ['Baking', /\b(flour|sugar|caster|icing sugar|brown sugar|muscovado|baking powder|bicarbonate|bicarb|yeast|cornflour|cocoa|chocolate|syrup|treacle|sultanas|raisins|nuts|almonds|walnuts|peanuts|cashews|desiccated|biscuits?|digestives?|popping corn|popcorn|gelatine|cornstarch)\b/i],
  ['Frozen', /\b(frozen|ice cream)\b/i],
  ['Drinks & alcohol', /\b(wine|beer|ale|cider|brandy|cognac|rum|vodka|gin|whisky|sherry|port|juice|lemonade)\b/i],
];
// "chicken stock", "coconut milk": the second word decides the aisle, so test those first
const OVERRIDE = [[/\b(stock|broth|bouillon)\b/i, 'Tins, jars & packets'], [/\bcoconut (milk|cream)\b/i, 'Tins, jars & packets'], [/\b(frozen)\b/i, 'Frozen'], [/\b(ground|dried|seeds?|powder|flakes)\b/i, 'Herbs, spices & seasoning'], [/\b(tinned|canned|can of|x \d+g can|\d+g can|tin of|tin)\b/i, 'Tins, jars & packets'], [/\b(curry paste|tomato (puree|paste))\b/i, 'Tins, jars & packets'], [/\b(sauce|oil|vinegar)\b/i, 'Oils, sauces & condiments'], [/\bwine\b/i, 'Drinks & alcohol']];
function aisleOf(text){
  const name = itemName(text), whole = String(text).toLowerCase();
  if (/^(salt|black pepper|salt and (black )?pepper|freshly ground|pepper)\b/.test(name)) return 'Herbs, spices & seasoning';
  if (/\b(\d+\s*g\s*(can|tin)|cans?|tins?|tinned|canned)\b/.test(whole) && !/\bcan be\b/.test(whole)) return 'Tins, jars & packets';
  for (const [re, a] of OVERRIDE) if (re.test(name)) return a;
  for (const [a, re] of AISLES) if (re.test(name)) return a;
  return 'Other';
}
const UNITS = { g: 'g', gram: 'g', grams: 'g', kg: 'kg', ml: 'ml', l: 'l', litre: 'l', litres: 'l', tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp', tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp', cup: 'cup', cups: 'cup', clove: 'clove', cloves: 'clove', can: 'can', cans: 'can', tin: 'can', tins: 'can', pack: 'pack', packs: 'pack', bunch: 'bunch', handful: 'handful', pinch: 'pinch' };
function num(s){ s = String(s).trim(); let m; if ((m = s.match(/^(\d+)\s*([½¼¾⅓⅔⅛])$/))) return +m[1] + FR[m[2]]; if (FR[s] != null) return FR[s]; if ((m = s.match(/^(\d+)[\s-]+(\d+)\/(\d+)$/))) return +m[1] + m[2]/m[3]; if ((m = s.match(/^(\d+)\/(\d+)$/))) return m[1]/m[2]; const v = parseFloat(s); return isNaN(v) ? null : v; }
/* "2 x 400g cans chopped tomatoes, drained" → { qty: 800, unit: 'g', name: 'chopped tomatoes' } */
function splitItem(text){
  let t = String(text).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  let mult = 1, m;
  if ((m = t.match(/^(\d+)\s*x\s*/))){ mult = +m[1]; t = t.slice(m[0].length); }
  m = t.match(/^(\d+(?:\.\d+)?(?:[\s-]+\d+\/\d+|\s*[½¼¾⅓⅔⅛])?|\d+\/\d+|[½¼¾⅓⅔⅛])(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*/);
  let qty = null, unit = '';
  if (m){ qty = num(m[1]); t = t.slice(m[0].length); }
  const u = t.match(/^([a-z]+)\b\.?\s*(of\s+)?/);
  if (u && UNITS[u[1]]){ unit = UNITS[u[1]]; t = t.slice(u[0].length); }
  if (qty != null) qty *= mult;
  if (!unit && /^garlic cloves?\b|^cloves? (of )?garlic\b/.test(t)){ unit = 'clove'; t = 'garlic'; }
  const name = t.split(',')[0].replace(/\b(can|cans|tin|tins|pack|packs|jar)\b\s*/g, '').replace(/\s+(to serve|optional|to taste)$/, '').trim();
  return { qty, unit, name };
}
function itemName(text){ return splitItem(text).name || String(text).toLowerCase(); }
const singular = w => w.replace(/(tomato|potato)es\b/g, '$1').replace(/([^s])s\b/g, '$1');
function fmt(q){ if (q == null) return ''; if (q >= 100) return String(Math.round(q / 5) * 5); return String(Math.round(q * 100) / 100).replace(/\.0+$/, ''); }
function combine(items){
  // items: [{text, from}] → [{text, aisle}] with like items merged where the units agree
  const groups = new Map();
  for (const it of items){
    const p = splitItem(it.text);
    if (!p.name || /^(water|boiling water|cold water|hot water|ice)$/.test(p.name)) continue;
    let unit = p.unit, qty = p.qty;
    if (unit === 'kg'){ unit = 'g'; qty = qty != null ? qty * 1000 : null; }
    if (unit === 'l'){ unit = 'ml'; qty = qty != null ? qty * 1000 : null; }
    const key = singular(p.name.replace(/^(fresh|large|small|medium|ripe|whole)\s+/, '')) + '|' + unit;
    const g = groups.get(key);
    if (g){ if (g.qty != null && qty != null) g.qty += qty; else if (qty != null) g.qty = qty; g.count++; if (/s$/.test(p.name) && !/s$/.test(g.name)) g.name = p.name; }
    else groups.set(key, { qty, unit, name: p.name, text: it.text, count: 1 });
  }
  const out = [];
  for (const g of groups.values()){
    let text;
    if (g.count === 1) text = g.text;
    else if (g.qty == null) text = g.name;
    else {
      let q = g.qty, u = g.unit;
      if (u === 'g' && q >= 1000){ q /= 1000; u = 'kg'; } else if (u === 'ml' && q >= 1000){ q /= 1000; u = 'l'; }
      text = fmt(q) + (/(g|kg|ml|l)$/.test(u) ? u : u ? ' ' + u + (q > 1 && /^(tbsp|tsp|clove|can|pack|bunch|handful|pinch|cup)$/.test(u) && !/^(tbsp|tsp)$/.test(u) ? 's' : '') : '') + ' ' + g.name;
    }
    out.push({ text: text.replace(/\s+/g, ' ').trim(), aisle: aisleOf(text) });
  }
  const order = [...AISLES.map(a => a[0]), 'Other'];
  out.sort((a, b) => order.indexOf(a.aisle) - order.indexOf(b.aisle) || a.text.localeCompare(b.text));
  return out;
}

/* ---------- rough nutrition from the UK dataset ---------- */
const DUAL = /(\d\s*(?:g|kg|ml|l))\s*\/\s*[\d.½¼¾⅓⅔⅛\/\s]+(?:lbs?\s*[\d.½¼¾]+\s*oz|fl\.?\s?oz|oz|lbs?|pints?)\b/gi;
function grams(line, food){
  // weight in grams of one ingredient line, or null when it can't be worked out
  let t = String(line).toLowerCase().replace(DUAL, '$1');
  let mult = 1, m;
  // a weight written in brackets is the most reliable figure: "8 chicken thighs (about 800g)"
  if ((m = t.match(/\((?:about|approx\.?|around)?\s*(\d+(?:\.\d+)?)\s*(g|kg|ml|pounds?|lbs?)\b[^)]*\)/))) return +m[1] * ({ g: 1, ml: 1, kg: 1000 }[m[2]] || 453.6);
  // quantity written after the name: "soy sauce 3tsps", "peanut butter 1 1/2tblsps"
  if (!/^[\d½¼¾⅓⅔⅛]/.test(t) && (m = t.match(/(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?)\s*(tsps?|tbsps?|tblsps?|tbps|g|ml|kg)\s*$/))) t = m[1] + ' ' + m[2] + ' ' + t.slice(0, m.index);
  t = t.replace(/^([\d½¼¾⅓⅔⅛\/.\s-]+)\s*(heaped|level|rounded|generous|scant|large|small|medium)\s+/, '$1 ');
  if ((m = t.match(/^(\d+)\s*x\s*/))){ mult = +m[1]; t = t.slice(m[0].length); }
  // "a 400g can", "1 x 400g tin": the pack size is the weight
  if ((m = t.match(/^(?:an?\s+|1\s+)?(\d+(?:\.\d+)?)\s*(g|ml)\s+(?:can|tin|pack|jar|bag|carton|pot|tub|block)\b/))) return +m[1] * mult;
  m = t.match(/^(\d+(?:\.\d+)?(?:[\s-]+\d+\/\d+|\s*[½¼¾⅓⅔⅛])?|\d+\/\d+|[½¼¾⅓⅔⅛])(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*/);
  let q = null;
  if (m){ q = num(m[1]); if (m[2]) q = (q + +m[2]) / 2; t = t.slice(m[0].length); }
  const u = (t.match(/^([a-z]+)\.?\b/) || [])[1] || '';
  const tbsp = food?.tbsp || 15;
  const per = {
    g: 1, gram: 1, grams: 1, kg: 1000, ml: 1, l: 1000, litre: 1000, litres: 1000,
    tbsp: tbsp, tbsps: tbsp, tbps: tbsp, tablespoon: tbsp, tablespoons: tbsp, tblsps: tbsp, tblsp: tbsp,
    tsp: tbsp / 3, tsps: tbsp / 3, teaspoon: tbsp / 3, teaspoons: tbsp / 3,
    cup: 240 * (tbsp / 15), cups: 240 * (tbsp / 15), oz: 28.35, lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6,
    pinch: 0.5, dash: 1, splash: 15, drizzle: 10, knob: 15, handful: 30, bunch: 30, sprig: 1, sprigs: 1,
    clove: 5, cloves: 5, can: 400, cans: 400, tin: 400, tins: 400, pack: 30, packet: 30, sachet: 7, cm: 5, thumb: 15
  };
  if (q == null){
    if (/^(a |an )?(small )?(pack|bunch|handful)\b/.test(t)) return 30;
    if (/^(a |an )?(thumb|knob)/.test(t)) return 15;
    if (/^(a |an )?(pinch|dash)/.test(t)) return 0.5;
    if (/^(juice|zest) of/.test(t)) return /juice/.test(t) ? 30 : 2;
    if (/\b(oil|butter|ghee)\b/.test(t)) return food?.tbsp || 14; // "oil, for frying": about a tablespoon
    if (food?.each) return food.each;                              // "1 carrot" written as just "carrot"
    return null;
  }
  q *= mult;
  if (per[u] != null) return q * per[u];
  if (food?.each) return q * food.each;
  return null;
}
function matchFood(line){
  const name = itemName(line), whole = String(line).toLowerCase().replace(/\(.*?\)/g, ' ');
  const N = window.NUTRITION || [];
  for (const f of N) if (new RegExp(f.re, 'i').test(name)) return f;
  // "8 bone-in, skin-on chicken thighs": the food can come after a comma
  for (const f of N) if (!f.zero && new RegExp(f.re, 'i').test(whole)) return f;
  return null;
}
function nutrition(recipe){
  const lines = (recipe.ingredients || []).filter(l => !isHead(l) && !/\b(to serve|for serving|to garnish|optional)\b/i.test(l));
  let kcal = 0, p = 0, f = 0, c = 0, counted = 0; const missed = [];
  for (const l of lines){
    const food = matchFood(l);
    if (food?.zero){ counted++; continue; }
    const g = food ? grams(l, food) : null;
    if (!food || g == null){ missed.push(l); continue; }
    kcal += food.kcal * g / 100; p += food.p * g / 100; f += food.f * g / 100; c += food.c * g / 100; counted++;
  }
  const s = String(recipe.serves || '').match(/\d+/);
  const portions = s ? +s[0] : 4;
  const r = v => Math.round(v / portions);
  return { kcal: r(kcal), protein: r(p), fat: r(f), carbs: r(c), portions, portionsAssumed: !s, counted, total: lines.length, missed };
}

window.Local = { fixFractions, guessLayout, readBoxes, isHead, fixWords, loadWords, parseRecipe, readPhotos, prepImage, wordiness, splitColumns, bestReading, combine, aisleOf, splitItem, num, nutrition, grams, matchFood };
})();
