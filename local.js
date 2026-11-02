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
  const CONT_END = /(,|\band|\bor|\bfinely|\broughly|\binto|\bof|\bthe|\ba|\bthinly|\bcut|\bpeeled|\bfresh)$/i;
  const CONT_START = /^(chopped|sliced|diced|crushed|peeled|grated|minced|halved|quartered|drained|trimmed|rinsed|deseeded|torn|to serve|or |and |plus )/i;
  const joins = (prev, l, i) => !bul.has(i) && prev && !QTY.test(l) && (CONT_END.test(prev) || CONT_START.test(l));
  // a numbered method often comes as "1." on its own line: drop the lone numbers
  const out = { title: '', serves: '', totalMins: null, prepMins: null, cookMins: null, ingredients: [], steps: [], warnings: [] };
  let mode = null; const pre = [], preAt = [];
  for (let i = 0; i < raw.length; i++){
    let l = raw[i];
    const meta = l.match(META);
    if (meta && l.length < 60){
      const k = meta[1].toLowerCase(), v = meta[meta.length - 1];
      if (/serv|make|yield/.test(k)){ if (!out.serves && v) out.serves = v.replace(/^:?\s*/, '').replace(/\s*(people|portions)$/i, ''); continue; }
      if (/total|ready/.test(k)){ out.totalMins = mins(v) || out.totalMins; continue; }
      if (/prep/.test(k)){ out.prepMins = mins(v); continue; }
      if (/cook/.test(k) && mins(v)){ out.cookMins = mins(v); continue; }
      if (/difficulty|level/.test(k)) continue;
    }
    if (HEAD_ING.test(l)){ mode = 'ing'; continue; }
    if (HEAD_STEP.test(l)){ mode = 'step'; continue; }
    // a "Cook's tip" or "Variation" box sits beside the recipe in many cookbooks: leave it out
    if (/^(cook['’]?s tips?|tips?|variations?|notes?|serving suggestions?)\s*:?$/i.test(l)){ mode = 'skip'; continue; }
    // printed steps often start "3 ▲" (read from a photo as "3 A"): that's the method
    const mark = l.match(/^(\d{1,2})\s*[▲△►▶A]\s+(?=[A-Z])/);
    if (mark && mode !== null){ l = l.slice(mark[0].length); mode = 'step'; out.steps.push(l); continue; }
    if (mode === 'skip') continue;
    if (JUNK.test(l)) continue;
    if (mode === null){ pre.push(l); preAt.push(para.has(i)); continue; }
    if (mode === 'ing'){
      // long prose inside the ingredient list means the method has started without a heading
      if (isStep(l) && l.length > 60 && out.ingredients.length){ mode = 'step'; out.steps.push(l); continue; }
      // a wrapped line from a photo continues the previous ingredient
      if (joins(out.ingredients[out.ingredients.length - 1], l, i)) out.ingredients[out.ingredients.length - 1] += ' ' + l;
      else out.ingredients.push(l);
    } else {
      const prev = out.steps[out.steps.length - 1];
      if (prev && !bul.has(i) && !/[.!?:)]$/.test(prev) && /^[a-z(]/.test(l)) out.steps[out.steps.length - 1] = prev + ' ' + l;
      else out.steps.push(l);
    }
  }
  // No headings at all: sort lines by what they look like.
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
    const joinP = ls => ls.reduce((a, l) => !a ? l : /[-–]$/.test(a) && /^[a-z]/.test(l) ? a.replace(/[-–]$/, '') + l : a + ' ' + l, '');
    const texts = paras.map(joinP), first = texts.findIndex((t, k) => k > 0 && VERB.test(t.replace(/^[^A-Za-z]+/, '')) && t.length > 30);
    if (first > 0){
      const intro = texts.slice(1, first).filter(t => t.length > 60).join(' ');
      if (intro) out.intro = intro;
      out.steps = texts.slice(first).map(t => t.replace(/^[^A-Za-z0-9]+/, '')).filter(t => t.length > 15);
      pre.length = paras[0].length;
    }
  }
  // Title: the first short line before the recipe proper that isn't chatter.
  out.title = (pre.find(l => l.length >= 3 && l.length <= 80 && !/[.!?]$/.test(l) && !QTY.test(l) && !/^(by |recipe from|from |posted|updated|home|recipes?$)/i.test(l)) || '').replace(/\s*(recipe)$/i, '');
  if (!out.totalMins && (out.prepMins || out.cookMins)) out.totalMins = (out.prepMins || 0) + (out.cookMins || 0);
  // "Serves 4" buried in an intro sentence; "1 Heat the oil…" numbered steps
  if (!out.serves){ const m = raw.join(' ').match(/\b(?:serves|feeds)\s+(\d+(?:\s*[-–]\s*\d+)?)\b|\bfor\s+(\d+(?:\s*[-–]\s*\d+)?)\s+(?:people|persons|servings|adults)\b/i); if (m) out.serves = (m[1] || m[2]).replace(/\s+/g, ''); }
  out.steps = out.steps.map(l => l.replace(/^\d{1,2}\s*[.)]?\s+(?=[A-Z])/, ''));
  out.ingredients = out.ingredients.filter(l => l.length > 1 && l.length < 200);
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
  const k = Math.min(2.5, (opt.max || 2400) / Math.max(cw, ch));
  const c = document.createElement('canvas'); c.width = Math.round(cw * k); c.height = Math.round(ch * k);
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.35)';
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
function splitColumns(lines, width){
  const ls = lines.filter(l => (l.words || []).length);
  if (ls.length < 6 || !width) return null;
  const spaces = [];
  ls.forEach(l => { for (let i = 1; i < l.words.length; i++) spaces.push(l.words[i].bbox.x0 - l.words[i - 1].bbox.x1); });
  spaces.sort((a, b) => a - b);
  const med = spaces[Math.floor(spaces.length / 2)] || 10, minGap = Math.max(med * 3, width * 0.025);
  const pts = [];
  ls.forEach(l => { let best = null;
    for (let i = 1; i < l.words.length; i++){ const g = l.words[i].bbox.x0 - l.words[i - 1].bbox.x1; if (!best || g > best.g) best = { g, x: (l.words[i].bbox.x0 + l.words[i - 1].bbox.x1) / 2 }; }
    if (best && best.g >= minGap && best.x > width * 0.2 && best.x < width * 0.85) pts.push({ x: best.x, y: (l.words[0].bbox.y0 + l.words[0].bbox.y1) / 2 }); });
  if (pts.length < 4 || pts.length < ls.length * 0.2) return null;
  const fit = ps => { const n = ps.length, my = ps.reduce((a, p) => a + p.y, 0) / n, mx = ps.reduce((a, p) => a + p.x, 0) / n;
    const sxy = ps.reduce((a, p) => a + (p.y - my) * (p.x - mx), 0), syy = ps.reduce((a, p) => a + (p.y - my) ** 2, 0); const b = syy ? sxy / syy : 0; return { a: mx - b * my, b }; };
  let f = fit(pts);
  const kept = pts.filter(p => Math.abs(p.x - (f.a + f.b * p.y)) < width * 0.06);
  if (kept.length < 4) return null;
  f = fit(kept);
  const cols = [[], []];
  ls.forEach(l => { const y = (l.words[0].bbox.y0 + l.words[0].bbox.y1) / 2, gx = f.a + f.b * y, ws0 = l.words;
    // only split a line where it actually has a gap at the gutter; a heading running across stays whole
    let cut = -1;
    for (let i = 1; i < ws0.length; i++) if (ws0[i].bbox.x0 - ws0[i - 1].bbox.x1 >= minGap * 0.6 && ws0[i - 1].bbox.x1 <= gx + width * 0.03 && ws0[i].bbox.x0 >= gx - width * 0.03){ cut = i; break; }
    const parts = cut > 0 ? [ws0.slice(0, cut), ws0.slice(cut)] : ws0[0].bbox.x0 < gx - width * 0.02 ? [ws0, []] : [[], ws0];
    parts.forEach((ws, c) => {
      // a word or two the reader wasn't sure of, on their own, are usually smudges or bits of pictures
      ws = ws.filter(w => !/^[_|\\/~^*•·:;'‘’"“”&{}\[\]-]+$/.test(w.text));
      if (!ws.length) return;
      const conf = ws.reduce((a, w) => a + (w.confidence ?? 100), 0) / ws.length;
      if (ws.length <= 2 && conf < 60 && !/\d/.test(ws.map(w => w.text).join(''))) return;
      cols[c].push({ text: ws.map(w => w.text).join(' '), x: ws[0].bbox.x0, y0: Math.min(...ws.map(w => w.bbox.y0)), y1: Math.max(...ws.map(w => w.bbox.y1)) }); }); });
  const asText = col => {
    if (!col.length) return '';
    // the usual distance from one line to the next
    const pitches = col.slice(1).map((l, i) => l.y0 - col[i].y0).filter(g => g > 0).sort((a, b) => a - b), pitch = pitches[Math.floor(pitches.length / 2)] || 40;
    let out = col[0].text;
    for (let i = 1; i < col.length; i++){ const l = col[i], p = col[i - 1], step = l.y0 - p.y0;
      // a line set in further than the one above, not starting with an amount, carries on the line above
      if (l.x - p.x > width * 0.012 && !/^[\d½¼¾⅓⅔]/.test(l.text) && step < pitch * 1.4) out += ' ' + l.text;
      // a bigger space than usual starts a new paragraph
      else out += (step > pitch * 1.5 ? '\n\n' : '\n') + l.text; }
    return out;
  };
  return asText(cols[0]) + '\n\n' + asText(cols[1]);
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
const fixOcr = t => t.replace(/(^|\s)[VY]a\s*[—–-]\s*V2(?=\s)/g, '$1¼–½').replace(/(^|\s)V2(?=\s)/g, '$1½').replace(/(^|\s)Va(?=\s+(tsp|tbsp|cup))/g, '$1¼').replace(/\b(\d)%(?=\s+(tsp|tbsp|cups?|kg|g|lb|oz|pints?)\b)/g, '$1½')
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
async function readPhotos(pages, onProgress){
  await loadTesseract();
  const worker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100)); } });
  try {
    // read the page as one block of lines; columns are worked out afterwards from where the words sit
    const out = [];
    for (const p of pages) out.push(await readOne(worker, p, onProgress));
    const score = out.reduce((a, o) => a + o.score, 0) / out.length;
    return { text: out.map(o => o.text).join('\n'), score, turned: out.map(o => o.rot) };
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
  const lines = (recipe.ingredients || []).filter(l => !/\b(to serve|for serving|to garnish|optional)\b/i.test(l));
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

window.Local = { parseRecipe, readPhotos, prepImage, wordiness, splitColumns, bestReading, combine, aisleOf, splitItem, num, nutrition, grams, matchFood };
})();
