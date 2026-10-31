/* Reads saved emails (.eml, or a whole folder as .mbox) and plain files (.txt, .html) on the phone, so a folder
   of recipe emails can come into Spoonbook in one go. Works out the subject, who sent it, when, the text, and the
   first photo attached. No AI and nothing leaves the phone. */
(() => {
const bin = buf => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return s; };
const bytesOf = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
function decodeBytes(bytes, charset){
  const cs = (charset || 'utf-8').toLowerCase().replace(/^(us-ascii|ascii)$/, 'utf-8');
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}
function qp(s){ return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function b64(s){ try { return atob(s.replace(/[^A-Za-z0-9+/=]/g, '')); } catch { return ''; } }
// =?utf-8?Q?Mum=27s_lasagne?=  →  Mum's lasagne
function words(h){
  return String(h || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) =>
    decodeBytes(bytesOf(enc.toUpperCase() === 'B' ? b64(txt) : qp(txt.replace(/_/g, ' '))), cs));
}
function headers(block){
  const h = {}; block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(l => { const m = l.match(/^([\w-]+):\s*(.*)$/); if (m && !(m[1].toLowerCase() in h)) h[m[1].toLowerCase()] = m[2]; });
  return h;
}
const param = (v, k) => (String(v || '').match(new RegExp(k + '\\*?=\\s*"?([^";]+)"?', 'i')) || [])[1] || '';
// splits a message into its parts: [{ type, text } | { type, bytes, name }]
function mime(raw, depth = 0){
  const cut = raw.search(/\r?\n\r?\n/);
  const head = headers(cut < 0 ? raw : raw.slice(0, cut)), body = cut < 0 ? '' : raw.slice(cut).replace(/^\r?\n\r?\n/, '');
  const ct = head['content-type'] || 'text/plain', type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 6){
    const bd = param(ct, 'boundary'); if (!bd) return [];
    const parts = body.split(new RegExp('\\r?\\n?--' + bd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?[ \\t]*\\r?\\n?'));
    return parts.slice(1).filter(p => p.trim()).flatMap(p => mime(p, depth + 1));
  }
  if (type === 'message/rfc822' && depth < 6) return mime(body, depth + 1);
  const enc = (head['content-transfer-encoding'] || '').toLowerCase();
  const rawBytes = enc === 'base64' ? b64(body) : enc === 'quoted-printable' ? qp(body) : body;
  if (type.startsWith('text/')) return [{ type, text: decodeBytes(bytesOf(rawBytes), param(ct, 'charset')), head }];
  if (type.startsWith('image/')) return [{ type, bytes: bytesOf(rawBytes), name: words(param(head['content-disposition'], 'filename') || param(ct, 'name')) }];
  return [];
}
function htmlText(html){
  const t = String(html).replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d|table|blockquote)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '');
  const d = new DOMParser().parseFromString('<!doctype html><body>' + t.replace(/</g, '&lt;'), 'text/html');
  return d.body.textContent.replace(/ /g, ' ');
}
// takes out forwarding headers, quote marks, signatures and other email clutter
function tidy(text){
  return String(text).replace(/\r/g, '').split('\n')
    .map(l => l.replace(/^(\s*>)+\s?/, ''))
    .filter(l => !/^\s*(-{2,}\s*(original message|forwarded message|begin forwarded)|_{5,}|from:|sent:|to:|cc:|date:|subject:|reply-to:)/i.test(l))
    .filter(l => !/^\s*(sent from my|get outlook for|sent via|this email (has been|was) scanned|-- ?$)/i.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const subjectTitle = s => words(s).replace(/^\s*((re|fw|fwd|aw|tr)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim();
function fromName(h){ const f = words(h || ''); return (f.match(/^\s*"?([^"<]+?)"?\s*</) || [])[1]?.trim() || f.replace(/<.*>/, '').trim() || ''; }

// a saved web page or an app's export: keep the link to the original recipe if there is one
function htmlFile(html, fileName){
  const link = (html.match(/<a[^>]+href=['"](https?:\/\/[^'"]+)['"][^>]*>\s*(original|source|view original|original article|recipe from)[^<]*<\/a>/i) || [])[1] || '';
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  return { title: h1 ? htmlText(h1).trim() : '', text: tidy(htmlText(html.replace(/<a[^>]*>\s*(original|source|view original|original article)[^<]*<\/a>/gi, ''))), source: link, file: fileName };
}
function readMessage(raw, fileName){
  const cut = raw.search(/\r?\n\r?\n/); const head = headers(cut < 0 ? raw : raw.slice(0, cut));
  const parts = mime(raw);
  const plain = parts.find(p => p.type === 'text/plain' && p.text.trim()), html = parts.find(p => p.type === 'text/html');
  // some emails carry a stub plain version ("view this in HTML"), so use whichever version has more in it
  const a = plain ? tidy(plain.text) : '', b2 = html ? tidy(htmlText(html.text)) : '';
  const text = b2.length > a.length * 1.2 ? b2 : a;
  const img = parts.find(p => p.bytes && p.bytes.length > 8000 && p.bytes.length < 15e6); // skip tiny logos and spacers
  const date = head.date ? new Date(head.date) : null;
  return { title: subjectTitle(head.subject || ''), from: fromName(head.from), date: date && !isNaN(date) ? date : null, text,
    image: img ? new Blob([img.bytes], { type: img.type }) : null, file: fileName };
}

async function readFiles(files, onProgress){
  const out = [];
  let n = 0;
  for (const f of files){
    onProgress?.(++n, files.length, f.name);
    const name = f.name.toLowerCase();
    try {
      if (/\.(txt|md|text)$/.test(name) || f.type === 'text/plain'){ out.push({ title: '', text: tidy(await f.text()), file: f.name }); continue; }
      if (/\.html?$/.test(name) || f.type === 'text/html'){ out.push(htmlFile(await f.text(), f.name)); continue; }
      if (/\.zip$/.test(name) || f.type === 'application/zip'){
        // an export from another app (ChefTap and others give a .zip of recipe files)
        if (!window.JSZip) throw new Error('zip');
        const zip = await JSZip.loadAsync(f);
        const entries = Object.values(zip.files).filter(e => !e.dir && /\.(html?|txt|md|eml)$/i.test(e.name) && !/__MACOSX/.test(e.name));
        for (const e of entries){
          const short = e.name.split('/').pop();
          if (/\.html?$/i.test(e.name)) out.push(htmlFile(await e.async('string'), short));
          else if (/\.eml$/i.test(e.name)) out.push(readMessage(bin(await e.async('arraybuffer')), short));
          else out.push({ title: '', text: tidy(await e.async('string')), file: short });
        }
        continue;
      }
      const raw = bin(await f.arrayBuffer());
      if (/\.mbox$/.test(name) || /^From \S+/.test(raw)){
        // a whole folder in one file: messages start with a line beginning "From "
        raw.split(/\r?\n(?=From \S)/).forEach((m, i) => { const body = m.replace(/^From [^\n]*\n/, '').replace(/^>From /gm, 'From '); if (body.trim()) out.push(readMessage(body, `${f.name} #${i + 1}`)); });
      } else out.push(readMessage(raw, f.name));
    } catch { out.push({ title: '', text: '', file: f.name, error: true }); }
  }
  return out;
}

window.Mail = { readFiles, readMessage, tidy };
})();
