/* Simple mode: extra help for less confident cooks. The recipe itself is never changed. This only adds
   help around it, worked out on the phone with plain rules (no AI):
   - long steps split into one action at a time
   - cooking words explained when tapped
   - a "before you start" list of chopping and prep, taken from the ingredients
   - plain-English heat guides and food-safety checks */
(() => {
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- one action at a time ---------- */
const ABBR = /\b(approx|tbsp|tsp|oz|lb|lbs|no|min|mins|hr|hrs|e\.g|i\.e|etc|c|vs)\.$/i;
function splitStep(step){
  const text = String(step).replace(/\s+/g, ' ').trim();
  if (!text) return [];
  // sentences: break after . ! ? when the next word starts with a capital (not after "tbsp." or "1.5")
  const sentences = []; let cur = '';
  for (const part of text.split(/(?<=[.!?])\s+(?=[A-Z])/)){
    cur = cur ? cur + ' ' + part : part;
    if (!ABBR.test(cur)){ sentences.push(cur); cur = ''; }
  }
  if (cur) sentences.push(cur);
  // within a sentence: "…, then …" and "…; …" become separate actions when both halves are real instructions
  const out = [];
  for (const s of sentences){
    const bits = s.split(/(?:,|;)\s*(?:and\s+)?then\s+|;\s+|\s+and then\s+/i);
    if (bits.length > 1 && bits.every(b => b.trim().split(' ').length >= 3)){
      bits.forEach((b, i) => { b = b.trim(); out.push(cap(b) + (/[.!?]$/.test(b) ? '' : '.')); });
    } else out.push(s);
  }
  // don't leave crumbs: very short pieces join the one before
  const merged = [];
  for (const s of out){ if (merged.length && s.split(' ').length < 4) merged[merged.length - 1] += ' ' + s; else merged.push(s); }
  return merged;
}

/* ---------- cooking words, explained ---------- */
const G = [
  ['al dente', 'Cooked until just tender but still with a little bite in the middle. Taste a piece a minute or two before the packet time.'],
  ['bain-marie|bain marie|water bath', 'A bowl sitting over a pan of gently simmering water, so the food heats gently. Don’t let the bowl touch the water.'],
  ['baste|basting', 'Spoon the hot juices or fat from the tin back over the food to keep it moist.'],
  ['beat', 'Mix fast and hard with a fork, whisk or wooden spoon to add air and make it smooth.'],
  ['blanch|blanched|blanching', 'Drop into boiling water for a short time (usually 1–3 minutes), then straight into cold water to stop the cooking.'],
  ['blend|blitz', 'Whizz until smooth with a stick blender, blender or food processor. Let hot liquids cool a little first and don’t fill the jug more than halfway.'],
  ['boil|boiling|bring to the boil|bring to a boil', 'Big bubbles breaking all over the surface, constantly. Use a high heat to get there.'],
  ['braise|braised', 'Brown first, then cook slowly in a covered pan with a little liquid, on a low heat or in the oven.'],
  ['brown (?:the|it|them|all over|on all sides)|browned|until browned|to brown', 'Cook in a hot pan until the outside turns a deep golden brown. Don’t move it around too much and don’t crowd the pan, or it steams instead.'],
  ['caramelise|caramelised|caramelize|caramelized', 'Cook slowly until the natural sugars turn golden brown and sweet. For onions this takes a good 20–30 minutes on a low heat.'],
  ['chop finely|finely chop|finely chopped', 'Cut into very small pieces, about the size of a grain of rice.'],
  ['roughly chop|roughly chopped', 'Cut into chunky pieces, about the size of a fingernail. They don’t need to be neat.'],
  ['cream together|cream the', 'Beat butter and sugar together until pale and fluffy. It takes a few minutes with an electric whisk.'],
  ['deglaze', 'Pour liquid (stock, wine or water) into the hot pan and scrape up the brown bits stuck to the bottom. That’s where the flavour is.'],
  ['dice|diced', 'Cut into small cubes, about 1cm.'],
  ['drizzle', 'Pour a thin stream over the top.'],
  ['dust|dusting', 'Sprinkle a light, even layer, usually through a sieve.'],
  ['fold|fold in|folding', 'Mix very gently with a big spoon or spatula, cutting down through the middle and turning it over, so you don’t knock the air out.'],
  ['julienne', 'Cut into thin matchsticks.'],
  ['knead|kneading', 'Push the dough away with the heel of your hand, fold it back, turn it and repeat, for about 10 minutes until smooth and stretchy.'],
  ['knob of butter|a knob', 'A lump of butter about the size of a walnut, roughly 15g.'],
  ['marinate|marinade', 'Leave the food sitting in a flavoured mixture so it soaks in. Cover it and keep it in the fridge.'],
  ['mince|minced', 'Chop as finely as you can, almost to a paste.'],
  ['parboil|parboiled', 'Boil for a few minutes so it’s partly cooked, then drain. It finishes cooking later.'],
  ['pinch', 'The amount you can pick up between your thumb and first finger. Less than ⅛ teaspoon.'],
  ['poach|poached', 'Cook gently in liquid that is barely bubbling.'],
  ['preheat', 'Turn the oven on now so it’s fully hot when the food goes in. Most ovens take 10–15 minutes.'],
  ['reduce|reduced|reduces', 'Let it bubble with the lid off so water steams away and it gets thicker and stronger in flavour.'],
  ['leave (?:it |them )?to rest|let (?:it |them )?rest|rest for|resting', 'Leave it alone, off the heat, before cutting or serving. Meat stays juicier. Cover loosely with foil to keep it warm.'],
  ['roux', 'Butter and flour cooked together for a minute or two. It thickens sauces.'],
  ['rub in|rubbing in|rub the butter', 'Rub the butter into the flour between your fingertips until it looks like breadcrumbs.'],
  ['saut[ée]|saut[ée]ed|saut[ée]ing', 'Fry quickly in a little oil over a medium-high heat, stirring or tossing often.'],
  ['score|scored', 'Make shallow cuts across the surface with a sharp knife.'],
  ['sear|seared', 'Cook in a very hot pan, without moving it, until a brown crust forms on the outside.'],
  ['season|seasoned|seasoning|season to taste', 'Add salt and pepper. “To taste” means add a little, taste, and add more if it needs it.'],
  ['simmer|simmering|simmered', 'A gentle bubble: small bubbles rising lazily, not a rolling boil. Turn the heat down to low or medium-low once it boils.'],
  ['soft peaks', 'Lift the whisk out: the peak stands up, then flops over at the tip.'],
  ['stiff peaks', 'Lift the whisk out: the peak stands straight up and holds its shape. You can tip the bowl and it won’t slide.'],
  ['stir-fry|stir fry|stir-fried', 'Fry fast in a very hot pan or wok, stirring and tossing all the time.'],
  ['sweat|sweated', 'Cook gently in a little fat on a low heat, lid on or off, until soft but not brown.'],
  ['temper|tempering', 'Warm something gently by adding a little of the hot mixture first, so it doesn’t split or scramble.'],
  ['until golden|golden brown', 'A rich, light-brown colour, like a digestive biscuit.'],
  ['until softened|until soft', 'Until it squashes easily against the side of the pan with your spoon. For onions, about 8–10 minutes.'],
  ['whisk|whisked', 'Mix fast with a whisk or fork to break it up and add air.'],
  ['zest|zested', 'The thin coloured outer skin of a lemon, lime or orange, grated finely. Avoid the white bit underneath, it’s bitter.']
].map(([w, d]) => ({ re: new RegExp('\\b(' + w + ')\\b', 'i'), word: w.split('|')[0].replace(/\[.*?\]/g, 'e'), d }));

// marks up cooking words in already-escaped HTML; each word once per step
function explainHtml(html){
  const used = new Set(); let out = html;
  for (let i = 0; i < G.length; i++){
    const g = G[i]; if (used.has(i)) continue;
    const m = out.match(g.re); if (!m) continue;
    // skip matches inside a tag we already added
    const before = out.slice(0, m.index); if ((before.match(/<button/g) || []).length > (before.match(/<\/button>/g) || []).length) continue;
    out = before + `<button class="term" data-act="term" data-g="${i}">${m[0]}</button>` + out.slice(m.index + m[0].length);
    used.add(i);
  }
  return out;
}
const term = i => G[+i];

/* ---------- before you start ---------- */
const PREP = [
  [/\bfinely chopped\b/, 'Finely chop'], [/\broughly chopped\b/, 'Roughly chop'], [/\bthinly sliced\b/, 'Thinly slice'], [/\bfinely sliced\b/, 'Finely slice'],
  [/\bchopped\b/, 'Chop'], [/\bdiced\b/, 'Dice'], [/\bsliced\b/, 'Slice'], [/\bcrushed\b/, 'Crush'], [/\bfinely grated\b/, 'Finely grate'], [/\bgrated\b/, 'Grate'],
  [/\bminced\b/, 'Finely chop'], [/\bpeeled\b/, 'Peel'], [/\bdrained and rinsed\b/, 'Drain and rinse'], [/\bdrained\b/, 'Drain'], [/\brinsed\b/, 'Rinse'],
  [/\bhalved\b/, 'Halve'], [/\bquartered\b/, 'Quarter'], [/\btrimmed\b/, 'Trim'], [/\bdeseeded\b/, 'Take the seeds out of'], [/\bzested\b/, 'Zest'],
  [/\bjuiced\b/, 'Squeeze the juice from'], [/\b(lightly )?beaten\b/, 'Beat'], [/\bsoftened\b/, 'Take out of the fridge to soften'], [/\bmelted\b/, 'Melt'],
  [/\bcubed\b/, 'Dice'], [/\bshredded\b/, 'Shred'], [/\btorn\b/, 'Tear'], [/\bcut into ([^,]+)/, 'Cut into $1:'], [/\bat room temperature\b/, 'Take out of the fridge'],
  [/\bsoaked\b/, 'Soak']
];
const TINNED = /\b(can|cans|tin|tins|tinned|canned|jar|pack|packet|carton)\b/;
const PARTICIPLE = /\b(finely|roughly|thinly|freshly)?\s*(chopped|diced|sliced|crushed|grated|minced|peeled|softened|melted|halved|quartered|cubed|shredded|torn|trimmed|deseeded|beaten|drained|rinsed|cut)\b.*$/;
const MEASURE = /^[\/\d½¼¾⅓⅔⅛.\s-]*(lbs?|oz|g|kg|ml|cm|mm|in|inch(es)?|cups?|pounds?|ounces?|tbsp|tsp|level|heaped|teaspoons?|tablespoons?|x)?\b\.?\s*(of\s+)?(?=\S)/;
const SIZE = /^(rashers?|handful|sprigs?|stalks?|small|large|medium|big|thumb-sized|thumbsized|handful of|small handful of|large handful of|bunch of|small bunch|large bunch|bunch|of)\s+/;
function prepList(ingredients){
  const out = [];
  for (const line of ingredients || []){
    if (/:\s*$/.test(line) && !/^\s*[\d½¼¾⅓⅔⅛]/.test(line)) continue;
    const low = String(line).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ');
    const [head, ...rest] = low.split(',');
    const after = rest.join(',');
    // "chopped tomatoes" from a tin is already done for you
    const where = after || (TINNED.test(head) ? '' : head);
    if (!where) continue;
    // every prep word in the order it's written: "peeled and quartered" → "Peel and quarter"
    const hits = [], taken = [];
    for (const [re, verb] of PREP){
      const g = new RegExp(re.source, 'g'); let m;
      while ((m = g.exec(where))){
        const a = m.index, b = a + m[0].length;
        if (taken.some(([x, y]) => a < y && b > x)) continue;
        taken.push([a, b]); hits.push({ at: a, verb: verb.replace('$1', (m[1] || '').trim()) });
      }
    }
    if (!hits.length) continue;
    hits.sort((x, y) => x.at - y.at);
    let name = Local.splitItem(line).name.replace(PARTICIPLE, '').trim();
    for (let i = 0; i < 4; i++) name = name.replace(MEASURE, '').replace(SIZE, '').replace(/^(finely|roughly|thinly|freshly|lots of|pieces?|piece of)\s+/, '').trim();
    name = name.replace(/\s+or\s+.*$/, '').replace(/[\s–—\-,;:.]+$/, '').trim();
    if (!name || /^(cups?|ounces?|pounds?|grams?|teaspoons?|tablespoons?|g|oz|lb)$/.test(name) || /\d/.test(name)) continue;
    const thing = 'the ' + name.replace(/^(a|an|the)\s+/, '');
    const verbs = hits.map(h => h.verb);
    const cut = verbs.find(v => /:$/.test(v));
    const plain = [...new Set(verbs.filter(v => !/:$/.test(v)))];
    let text;
    if (plain.some(v => /^Take out of the fridge/.test(v))) text = `Take ${thing} out of the fridge to soften`;
    else text = plain.length ? plain.map((v, i) => i ? v.charAt(0).toLowerCase() + v.slice(1) : v).join(' and ') + ' ' + thing : '';
    if (cut) text = text ? `${text}, then ${cut.slice(0, -1).replace(/^Cut/, 'cut it')}` : `Cut ${thing} ${cut.slice(4, -1)}`;
    if (text) out.push(text);
  }
  return [...new Set(out)];
}

/* ---------- heat guides and safety checks ---------- */
const TIPS = [
  [/\b(high heat|over a high|on high)\b/, 'High heat: about 7–8 on a dial of 9. The pan should be properly hot, so a drop of water sizzles away straight off.'],
  [/\bmedium[- ]high\b/, 'Medium-high heat: about 6–7 on a dial of 9. A lively sizzle as food goes in.'],
  [/\bmedium heat\b|\bover a medium\b|\bon medium\b/, 'Medium heat: about 5 on a dial of 9. A steady sizzle, never smoking.'],
  [/\b(low heat|gentle heat|over a low|on low)\b/, 'Low heat: about 2–3 on a dial of 9. Barely a sizzle.'],
  [/\b(preheat|heat) (the )?oven\b|\boven to\b/, 'Many recipes give an oven temperature for normal ovens. If yours is a fan oven and only one number is given, set it about 20°C lower.'],
  [/\b(chicken|turkey)\b.*\b(cook|fry|fried|brown|roast|bake|grill|sear|until)|\b(cook|fry|fried|brown|roast|bake|grill|sear|until)\b.*\b(chicken|turkey)\b/, 'Food safety: chicken and turkey must be cooked through. Cut into the thickest piece: there should be no pink, and the juices should run clear (75°C on a thermometer). Wash your hands and board after handling raw poultry.'],
  [/\b(mince|burgers?|sausages?|meatballs?)\b.*\b(cook|fry|fried|brown|roast|bake|grill|sear|until)|\b(cook|fry|fried|brown|roast|bake|grill|sear|until)\b.*\b(mince|burgers?|sausages?|meatballs?)\b/, 'Food safety: mince, burgers and sausages need cooking all the way through, with no pink left in the middle.'],
  [/\bpork\b.*\b(cook|fry|fried|brown|roast|bake|grill|sear|until)|\b(cook|fry|fried|brown|roast|bake|grill|sear|until)\b.*\bpork\b/, 'Food safety: pork should be cooked until the juices run clear (around 70°C in the middle).'],
  [/\b(prawns?|shrimp)\b/, 'Raw prawns are cooked when they turn pink all over and curl up. Don’t overdo them or they go rubbery.'],
  [/\b(oil|fat)\b.*\b(hot|heat)\b|\bdeep[- ]fry\b/, 'Hot oil: never leave it unattended, keep the handle turned in, and if it starts smoking turn the heat down.'],
  [/\bdrain\b.*\b(pasta|potatoes|rice|noodles)\b|\b(pasta|potatoes|noodles)\b.*\bdrain\b/, 'Draining: put the colander in the sink first and pour away from you. Steam burns.'],
  [/\brice\b.*\b(simmer|cook|boil)\b|\b(simmer|cook|boil)\b.*\brice\b/, 'Rice is done when the grains are soft all the way through. Fluff it with a fork before serving.']
];
function tips(text){
  const t = String(text).toLowerCase(); const out = [];
  for (const [re, tip] of TIPS) if (re.test(t)) out.push(tip);
  return out.slice(0, 2);
}

window.Simple = { splitStep, explainHtml, term, prepList, tips };
})();
