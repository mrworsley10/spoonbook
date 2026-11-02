/* Allergy and diet flags, worked out on the phone from the ingredient list (no AI). It covers the UK's 14
   allergens, plus vegetarian and vegan. It is a helpful guide, not a guarantee: it can't see inside
   shop-bought products, so people with allergies should always check the labels. */
(() => {
// each: name, words that mean it's there, words that look similar but aren't
const A = [
  ['Gluten', /\b(flour|bread|breadcrumbs?|panko|pasta|spaghetti|penne|fusilli|tagliatelle|linguine|macaroni|lasagne|noodles?|couscous|bulgu?r|barley|rye|spelt|semolina|pastry|filo|tortillas?|wraps?|naan|pitta|pita|baguette|ciabatta|brioche|crackers?|biscuits?|digestives?|sponge fingers|cake|croutons?|soy sauce|beer|ale|stout|lager|malt|oats|porridge|seitan|gnocchi|yorkshire)\b/,
    /\b(gluten[- ]free|gf|rice flour|cornflour|corn ?starch|gram flour|chickpea flour|almond flour|coconut flour|buckwheat|rice noodles|tamari|potato flour|tapioca|arrowroot|cauliflower rice)\b/],
  ['Dairy', /\b(milk|butter|buttermilk|cream|cheese|cheddar|parmesan|parmigiano|pecorino|mozzarella|feta|halloumi|paneer|ricotta|mascarpone|brie|camembert|gruyere|stilton|yogh?urt|cr[eè]me fra[iî]che|ghee|custard|ice cream|condensed|evaporated|quark|curd|whey|labneh)\b/,
    /\b(coconut (milk|cream|yogh?urt)|creamed coconut|almond milk|oat milk|soya? milk|rice milk|plant[- ]based|dairy[- ]free|vegan (butter|cheese|cream)|peanut butter|nut butter|almond butter|cashew butter|cocoa butter|butter ?beans?|butternut|cream of tartar|cream crackers?|salad cream)\b/],
  ['Eggs', /\b(eggs?|egg yolks?|egg whites?|mayonnaise|mayo|meringues?|egg noodles|aioli|hollandaise|brioche)\b/, /\b(eggplant|egg[- ]free|vegan mayo)\b/],
  ['Nuts', /\b(almonds?|walnuts?|hazelnuts?|cashews?|pecans?|pistachios?|brazil nuts?|macadamias?|pine nuts?|marzipan|praline|frangipane|nutella|almond (milk|flour|butter|extract)|ground almonds|mixed nuts|nuts)\b/, /\b(nutmeg|butternut|coconut|doughnut|donut|water chestnuts?|nut[- ]free|peanuts?)\b/],
  ['Peanuts', /\b(peanuts?|peanut butter|groundnut|satay)\b/, /\bpeanut[- ]free\b/],
  ['Fish', /\b(fish|salmon|tuna|cod|haddock|pollock|hake|mackerel|sardines?|anchov(y|ies)|trout|sea bass|seabass|bream|plaice|sole|monkfish|kipper|fish sauce|nam pla|worcestershire)\b/, /\b(fish[- ]free|vegan fish sauce)\b/],
  ['Shellfish', /\b(prawns?|shrimps?|crab|lobster|langoustines?|crayfish|mussels?|clams?|scallops?|squid|calamari|octopus|oysters?|oyster sauce|cockles|whelks)\b/, /\b(vegan oyster sauce|mushroom oyster)\b/],
  ['Sesame', /\b(sesame|tahini|hummus|houmous|halva)\b/, /\bsesame[- ]free\b/],
  ['Soya', /\b(soy|soya|tofu|edamame|miso|tempeh|soy sauce|tamari)\b/, /\bsoya?[- ]free\b/],
  ['Celery', /\b(celery|celeriac|celery salt)\b/, /^$/],
  ['Mustard', /\b(mustard|dijon|english mustard|piccalilli)\b/, /^$/],
  ['Sulphites', /\b(wine|sherry|port|vermouth|dried apricots|dried fruit|sultanas|raisins|cider vinegar|wine vinegar|balsamic)\b/, /^$/],
  ['Lupin', /\blupin\b/, /^$/],
  ['Molluscs', /^$/, /^$/] // folded into Shellfish above, kept for completeness
].filter(([n]) => n !== 'Molluscs');

const MEAT = /\b(chicken|beef|pork|lamb|mutton|veal|bacon|ham|gammon|sausages?|chorizo|salami|pepperoni|prosciutto|pancetta|lardons|mince|steak|turkey|duck|goose|venison|rabbit|pheasant|liver|kidneys?|black pudding|gelatine|gelatin|lard|suet|dripping|meatballs?|burgers?|stock|bone broth|oxtail|brisket|ribs?|wings|drumsticks?|thighs?)\b/;
const NOT_MEAT = /\b(vegetable (stock|suet)|veg(etable)? stock|vegan|vegetarian|veggie|quorn|plant[- ]based|meat[- ]free|mushroom stock|soya mince|meatless|beyond|impossible)\b/;
const ANIMAL = /\b(honey|eggs?|milk|butter|cheese|cream|yogh?urt|ghee|mayonnaise|mayo|meringue|custard|gelatine|whey|lard|suet)\b/;

// ingredients whose allergens depend on the brand: Oxo cubes have wheat and celery, some stock pots don't
const MAY = [
  [/\b(stock|stock cubes?|stock pots?|bouillon|gravy|gravy granules|stock powder)\b/, ['Gluten', 'Celery']],
  [/\b(sausages?|sausagemeat|sausage meat)\b/, ['Gluten', 'Sulphites']],
  [/\bworcestershire\b/, ['Gluten']],
  [/\bmustard\b/, ['Gluten']],
  [/\b(curry paste|curry sauce|pasta sauce|stir[- ]fry sauce|cooking sauce|hoisin|bbq sauce|barbecue sauce|brown sauce|ketchup|jarred)\b/, ['Gluten', 'Mustard', 'Celery', 'Soya']],
  [/\bbaking powder\b/, ['Gluten']],
  [/\b(dark|plain) chocolate|\bchocolate chips\b/, ['Dairy', 'Nuts']],
  [/\bpesto\b/, ['Nuts', 'Dairy']],
  [/\b(chorizo|salami|pepperoni)\b/, ['Gluten', 'Dairy']],
  [/\bice cream\b/, ['Eggs', 'Nuts']]
];
// a line that says it's free of something doesn't count for that allergen
const FREE = { Gluten: /gluten[- ]free|\bgf\b|coeliac/, Dairy: /dairy[- ]free|\bvegan\b|lactose[- ]free/, Eggs: /egg[- ]free|\bvegan\b/, Nuts: /nut[- ]free/, Peanuts: /peanut[- ]free/, Sesame: /sesame[- ]free/, Soya: /soya?[- ]free/, Fish: /fish[- ]free/ };
// strips the "look-alike" phrases out of a line before checking it
function clean(line, not){ return String(line).toLowerCase().replace(/\(.*?\)/g, ' ').replace(new RegExp(not.source, 'g'), ' '); }

function check(ingredients, title){
  const lines = (ingredients || []).map(String).filter(l => !(/:\s*$/.test(l) && !/^\s*[\d½¼¾⅓⅔⅛]/.test(l) && l.length <= 60));
  const contains = [];
  for (const [name, yes, not] of A){
    const free = FREE[name];
    const hits = lines.filter(l => !(free && free.test(l.toLowerCase())) && yes.test(clean(l, not)));
    if (hits.length) contains.push({ name, from: hits.slice(0, 3) });
  }
  const sure = new Set(contains.map(c => c.name)), may = new Map();
  for (const l of lines){
    const low = l.toLowerCase().replace(/\(.*?\)/g, ' ');
    for (const [re, names] of MAY){
      if (!re.test(low)) continue;
      for (const n of names){
        if (sure.has(n) || (FREE[n] && FREE[n].test(low))) continue;
        const word = (low.match(re) || [''])[0].trim();
        const m = may.get(n) || { name: n, from: [], words: new Set() }; if (m.from.length < 3) m.from.push(l); m.words.add(word); may.set(n, m);
      }
    }
  }
  const maybe = [...may.values()].map(m => ({ name: m.name, from: m.from, words: [...m.words] }));
  const meaty = lines.filter(l => { const c = clean(l, NOT_MEAT); return MEAT.test(c) && !/\b(vegetable|veg|mushroom) stock\b/.test(l.toLowerCase()); });
  const fishy = contains.some(c => c.name === 'Fish' || c.name === 'Shellfish');
  // the name counts too, in case the meat was missed off the list ("Creamy Chicken Curry")
  const named = title && MEAT.test(clean(title, NOT_MEAT).replace(/\b(stock|burgers?|wings|ribs?)\b/g, '')) || (title && /\b(fish|prawns?|salmon|tuna|cod|murgh|gosht|keema)\b/i.test(title));
  const vegetarian = lines.length > 0 && !meaty.length && !fishy && !named;
  const animal = lines.filter(l => ANIMAL.test(clean(l, A.find(a => a[0] === 'Dairy')[2])) && !/\b(vegan|plant[- ]based|dairy[- ]free|egg[- ]free)\b/.test(l.toLowerCase()));
  const vegan = vegetarian && !animal.length && !contains.some(c => c.name === 'Dairy' || c.name === 'Eggs');
  return { contains, may: maybe, vegetarian, vegan };
}
const NAMES = A.map(a => a[0]);
window.Diet = { check, NAMES };
})();
