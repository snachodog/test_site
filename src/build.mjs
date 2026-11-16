#!/usr/bin/env node
// Builds the static site from COPY.md into dist/.
// Run: node src/build.mjs
// Safe to run again: the script builds into dist.tmp/ and then replaces dist/.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
const copy = fs.readFileSync(path.join(root, 'COPY.md'), 'utf8');
const out = path.join(root, 'dist.tmp');
const BOOK = '/lets-chat/';
const CONTACT = '/contact/';
const report = { pending: [], confirm: [] };

// ---------- helpers ----------
const esc = (s) => s.replace(/&(?!nbsp;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s)
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>');
const write = (rel, data) => {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const hashName = (file) => {
  const data = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
  const ext = path.extname(file);
  return { data, name: `${path.basename(file, ext)}.${hash}${ext}` };
};

// ---------- parse COPY.md ----------
const chunks = copy.split(/\n---\n/);
const pages = [];
for (const chunk of chunks) {
  const head = chunk.match(/^## (\d+)\. (.+)$/m);
  if (!head || !chunk.includes('### Copy\n')) continue;
  const get = (label) => (chunk.match(new RegExp(`\\*\\*${label}:\\*\\* (.+)`)) || [])[1]?.trim();
  const url = (get('URL') || '').replace(/`/g, '') || null;
  const blocks = chunk.split('### Copy\n')[1].trim().split(/\n\s*\n/).map((b) => b.trim());
  const h1 = blocks.find((b) => b.startsWith('# ')).slice(2);
  pages.push({
    n: Number(head[1]),
    name: head[2],
    url,
    file: url ? path.join(url, 'index.html') : '404.html',
    title: get('Title tag'),
    description: get('Meta description') || null,
    noindex: !url || /noindex/.test(get('Search') || ''),
    blocks,
    h1,
  });
}
if (pages.length !== 15) throw new Error(`Expected 15 pages in COPY.md, found ${pages.length}`);

const closing = (() => {
  const lines = copy.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2));
  return { heading: lines.find((l) => l.startsWith('## ')).slice(3), text: lines.find((l) => /^[A-Z]/.test(l)) };
})();

// Service groups on the Past Work page give the tags for each case study.
const work = pages.find((p) => p.url === '/work/');
const tagsByUrl = {};
{
  let group = null;
  for (const b of work.blocks) {
    if (b.startsWith('## ')) group = b.slice(3);
    else if (group && b.startsWith('- ')) {
      for (const m of b.matchAll(/\]\((\/work\/[^)]+)\)/g)) (tagsByUrl[m[1]] ||= []).push(group);
    }
  }
}
const caseByName = (name) => pages.find((p) => p.url?.startsWith('/work/') && p.h1.startsWith(name));

// ---------- components ----------
const kind = (b) => {
  if (b.startsWith('# ')) return 'h1';
  if (b.startsWith('## ')) return 'h2';
  if (b.startsWith('### ')) return 'h3';
  if (b.startsWith('[CONFIRM:')) return 'confirm';
  if (b.startsWith('[PLACEHOLDER:')) return 'pending';
  if (b.startsWith('[IMAGE:')) return 'image';
  if (b.startsWith('[EMBED:')) return 'embed';
  if (b.startsWith('[Book a time]')) return 'actions';
  if (b === '*(Closing block)*') return 'closing';
  if (/^\[[^\]]+\]$/.test(b)) return 'button';
  if (b.startsWith('- ')) return 'list';
  return 'p';
};

// Removes notes that do not go live, and headings that have no content left.
function clean(blocks, page) {
  let list = blocks.filter((b) => {
    const k = kind(b);
    if (k === 'confirm') { report.confirm.push(`${page.name}: ${b.slice(10, -1)}`); return false; }
    if (k === 'pending') { report.pending.push(`${page.name}: ${b.slice(14, -1)}`); return cfg.showPending; }
    if (k === 'image') report.pending.push(`${page.name}: image, ${b.slice(8, -1)}`);
    return true;
  });
  const level = { h2: 2, h3: 3 };
  for (let changed = true; changed;) {
    changed = false;
    list = list.filter((b, i) => {
      const lv = level[kind(b)];
      if (!lv) return true;
      const next = list[i + 1] ? kind(list[i + 1]) : 'end';
      const empty = next === 'end' || next === 'closing' || (level[next] && level[next] <= lv);
      if (empty) changed = true;
      return !empty;
    });
  }
  return list;
}

const actions = () => `<div class="actions"><a class="btn btn-primary" href="${BOOK}">Book a time</a><a class="text-link" href="${CONTACT}">Send a message</a></div>`;
const cta = (heading, text) => `<section class="cta"><h2>${inline(heading)}</h2><p>${inline(text)}</p>${actions()}</section>`;
const pendingNote = (b) => `<p class="pending">Content to come: ${inline(b.slice(14, -1).trim())}</p>`;
const imagePlaceholder = (b) => {
  const label = b.slice(8, -1).trim();
  const headshot = /^headshot/i.test(label);
  // One element, one class. Replace it with an <img> when the image exists.
  const text = (headshot ? label.split('.')[0] : label).replace(/^./, (c) => c.toUpperCase());
  return `<div class="placeholder${headshot ? ' placeholder-headshot' : ''}" role="img" aria-label="Placeholder: ${esc(label)}">${esc(text)}</div>`;
};
const listHtml = (b) => `<ul>${b.split('\n').map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;

function prose(blocks) {
  const html = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (kind(b)) {
      case 'h1': break;
      case 'h2':
        if (b === '## Need something like this?') {
          html.push(cta(b.slice(3), blocks[i + 1]));
          i += 2; // paragraph and actions
        } else html.push(`<h2>${inline(b.slice(3))}</h2>`);
        break;
      case 'h3': html.push(`<h3>${inline(b.slice(4))}</h3>`); break;
      case 'pending': html.push(pendingNote(b)); break;
      case 'image': {
        // Headshots that follow each other go side by side.
        const group = [b];
        while (/^\[IMAGE: headshot/i.test(b) && /^\[IMAGE: headshot/i.test(blocks[i + 1] || '')) group.push(blocks[++i]);
        html.push(`<div class="figure${group.length > 1 ? ' headshots' : ''}">${group.map(imagePlaceholder).join('')}</div>`);
        break;
      }
      case 'embed':
        html.push(`<iframe class="embed" src="${esc(cfg.bookingEmbedUrl)}" title="Booking calendar for a call with Golden Triangle Consulting" loading="lazy"></iframe>`);
        break;
      case 'actions': html.push(actions()); break;
      case 'closing': html.push(cta(closing.heading, closing.text)); break;
      case 'list': html.push(listHtml(b)); break;
      default:
        if (/^\*(My|Steve's) role/.test(b)) html.push(`<p class="role">${inline(b)}</p>`);
        else if (b.startsWith('Next project:')) html.push(`<p class="next">${inline(b)}</p>`);
        else html.push(`<p>${inline(b)}</p>`);
    }
  }
  return html.join('\n');
}

const h1Class = (text) => {
  const words = text.trim().split(/\s+/).length;
  return words <= 3 ? 'h-display' : words <= 6 ? 'h-xl' : 'h-lg';
};
const h1 = (page) => `<h1 class="${h1Class(page.h1)}">${inline(page.h1)}</h1>`;

// Splits blocks into the lead (before the first h2) and h2 sections.
function sections(blocks) {
  const lead = [];
  const list = [];
  for (const b of blocks) {
    if (kind(b) === 'h2') list.push({ heading: b.slice(3), blocks: [] });
    else if (kind(b) === 'closing') list.push({ closing: true, blocks: [] });
    else (list.length ? list.at(-1).blocks : lead).push(b);
  }
  return { lead, list };
}
// Splits a section into h3 items: { heading, blocks }.
const items = (blocks) => blocks.reduce((acc, b) => {
  if (kind(b) === 'h3') acc.push({ heading: b.slice(4), blocks: [] });
  else acc.at(-1)?.blocks.push(b);
  return acc;
}, []);

const motif = `<svg class="motif" viewBox="0 0 240 240" aria-hidden="true" focusable="false"><path d="M120 24 228 216H12Z" fill="var(--color-gold)"/><path d="M168 96 236 216H100Z" fill="none" stroke="var(--color-ink)" stroke-width="2"/></svg>`;

const tagList = (url) => `<ul class="tags">${(tagsByUrl[url] || []).map((t) => `<li class="tag">${esc(t)}</li>`).join('')}</ul>`;

// ---------- page bodies ----------
function homeBody(page, blocks) {
  const { lead, list } = sections(blocks);
  const html = [`<section class="hero"><div class="container hero-grid"><div><p class="label">Steve and Sandra Dogiakos</p>${h1(page)}
${lead.filter((b) => kind(b) === 'p').map((b) => `<p>${inline(b)}</p>`).join('')}${actions()}</div>${motif}</div></section>`];
  for (const s of list) {
    if (s.closing) { html.push(`<section class="band band-tight"><div class="container">${cta(closing.heading, closing.text)}</div></section>`); continue; }
    const head = `<div class="heading-block"><h2 class="h-section">${inline(s.heading)}</h2></div>`;
    let body;
    let band = '';
    if (s.heading === 'Who we work with') {
      body = `<ul class="grid grid-4">${s.blocks[0].split('\n').map((l) => `<li class="audience">${inline(l.slice(2))}</li>`).join('')}</ul>`;
    } else if (s.heading === 'What we do') {
      band = 'band-mist';
      body = `<div class="grid grid-4">${items(s.blocks).map((it) => `<article class="card"><h3>${inline(it.heading)}</h3>${it.blocks.map((b) => `<p>${inline(b)}</p>`).join('')}</article>`).join('')}</div>`;
    } else if (s.heading === 'Why work with us') {
      band = 'band-wash';
      body = `<div class="grid grid-3">${items(s.blocks).map((it) => `<div class="reason"><h3>${inline(it.heading)}</h3>${it.blocks.map((b) => `<p>${inline(b)}</p>`).join('')}</div>`).join('')}</div>`;
    } else if (s.heading === 'Recent work') {
      const more = s.blocks.at(-1);
      body = `<div class="grid grid-2">${items(s.blocks.slice(0, -1)).map((it) => {
        const target = caseByName(it.heading);
        if (!target) throw new Error(`No case study page for "${it.heading}"`);
        const text = it.blocks.filter((b) => kind(b) === 'p');
        return `<article class="card case-card"><div class="placeholder" role="img" aria-label="Placeholder: image for ${esc(it.heading)}">Image: ${esc(it.heading)}</div><div class="case-body">${tagList(target.url)}<h3>${inline(it.heading)}</h3>${text.map((b) => `<p>${inline(b)}</p>`).join('')}<a class="text-link" href="${target.url}">Read the case study<span class="sr"> for ${esc(it.heading)}</span></a></div></article>`;
      }).join('')}</div><p class="more"><a class="text-link" href="/work/">${esc(more.slice(1, -1))}</a></p>`;
    } else throw new Error(`Home section without a layout: ${s.heading}`);
    html.push(`<section class="band ${band}"><div class="container">${head}${body}</div></section>`);
  }
  return html.join('\n');
}

function workBody(page, blocks) {
  const { lead, list } = sections(blocks);
  const html = [`<div class="container page-head">${h1(page)}<div class="prose">${prose(lead)}</div></div>`];
  let n = 0;
  for (const s of list) {
    if (s.closing) { html.push(`<section class="band band-tight"><div class="container">${cta(closing.heading, closing.text)}</div></section>`); continue; }
    const cards = s.blocks[0].split('\n').map((l) => {
      const m = l.match(/^- \*\*\[([^\]]+)\]\(([^)]+)\)\.\*\* (.+)$/);
      if (!m) throw new Error(`Past Work item not understood: ${l}`);
      return `<li class="card case-card"><div class="case-body"><h3>${esc(m[1])}</h3><p>${inline(m[3])}</p><a class="text-link" href="${m[2]}">Read the case study<span class="sr"> for ${esc(m[1])}</span></a></div></li>`;
    });
    html.push(`<section class="band ${n++ % 2 ? '' : 'band-mist'}"><div class="container"><div class="heading-block"><h2 class="h-section">${inline(s.heading)}</h2></div><ul class="grid grid-cards">${cards.join('')}</ul></div></section>`);
  }
  return html.join('\n');
}

function contactBody(page, blocks) {
  const formAt = blocks.findIndex((b) => b.startsWith('**Form**'));
  const rows = blocks.find((b) => b.startsWith('| Field')).split('\n').slice(2).map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
  const names = ['name', 'email', 'organization', 'organization_type', 'service', 'message'];
  const auto = { name: 'name', email: 'email', organization: 'organization' };
  const fields = rows.map(([label, type, req], i) => {
    const name = names[i];
    const required = req === 'Yes' ? ' required' : '';
    const id = `f-${name}`;
    const err = `<p class="error" id="${id}-error">Error: ${type === 'Email' ? 'enter an email address in the format name@example.com.' : type.startsWith('Dropdown') ? 'select one option.' : 'fill in this field.'}</p>`;
    let control;
    let hint = '';
    if (type.startsWith('Dropdown:')) {
      const options = type.slice(9).split(' / ').map((o) => o.trim());
      control = `<select id="${id}" name="${name}"${required}><option value="">Select one</option>${options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
    } else if (type.startsWith('Long text')) {
      const h = type.match(/Hint: "(.+)"/);
      if (h) hint = `<span class="hint" id="${id}-hint">${esc(h[1])}</span>`;
      control = `<textarea id="${id}" name="${name}" rows="6"${h ? ` aria-describedby="${id}-hint"` : ''}${required}></textarea>`;
    } else {
      control = `<input id="${id}" name="${name}" type="${type === 'Email' ? 'email' : 'text'}"${auto[name] ? ` autocomplete="${auto[name]}"` : ''}${required}>`;
    }
    return `<div class="field"><label for="${id}">${esc(label)}${required ? '' : ' (optional)'}</label>${hint}${control}${required ? err : ''}</div>`;
  });
  const button = blocks.find((b) => b.startsWith('Button:')).match(/\*\*(.+)\*\*/)[1];
  const note = blocks.find((b) => b.startsWith('Line below the button:')).replace('Line below the button: ', '');
  const live = Boolean(cfg.formAction);
  const offline = live ? '' : `<p class="pending" role="note">The contact form is not connected yet. To reach us now, <a href="${BOOK}">book a time</a>.</p>`;
  const form = `<form class="form"${live ? ` method="post" action="${esc(cfg.formAction)}"` : ''}>${offline}<fieldset${live ? '' : ' disabled'}><div class="hp" aria-hidden="true"><label for="f-website">Leave this field empty</label><input id="f-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>${fields.join('')}<div><button class="btn btn-primary" type="submit">${esc(button)}</button></div></fieldset><p class="form-note">${inline(note)}</p></form>`;
  return `<div class="container page-head">${h1(page)}<div class="prose">${prose(blocks.slice(0, formAt))}</div></div>
<div class="container page-body">${form}</div>`;
}

function genericBody(page, blocks) {
  const isCase = page.url?.startsWith('/work/');
  let body = blocks;
  if (page.url === '/about/' && kind(body.at(-1)) === 'actions') body = [...body.slice(0, -1), '*(Closing block)*'];
  return `<div class="container page-head">${isCase ? '<p class="label">Case study</p>' : ''}${h1(page)}</div>
<div class="container page-body prose">${prose(body)}</div>`;
}

// ---------- document shell ----------
const fonts = {
  archivo: hashName(path.join(root, 'src/fonts/archivo-latin.woff2')),
  inter: hashName(path.join(root, 'src/fonts/inter-latin.woff2')),
};
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8')
  .replace('__FONT_ARCHIVO__', `/fonts/${fonts.archivo.name}`)
  .replace('__FONT_INTER__', `/fonts/${fonts.inter.name}`)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s*\n\s*/g, '')
  .replace(/\s*([{};,])\s*/g, '$1')
  .replace(/:\s+/g, ':')
  .replace(/;}/g, '}');

const nav = [['/', 'Home'], ['/work/', 'Past Work'], ['/about/', 'About'], ['/contact/', 'Contact']];
const footerLinks = [['/work/', 'Past Work'], ['/about/', 'About'], ['/contact/', 'Contact'], [BOOK, 'Book a time'], ['/privacy/', 'Privacy']];
const navScript = `(()=>{const m=document.getElementById('site-menu'),q=matchMedia('(min-width:768px)'),f=()=>q.matches?m.removeAttribute('popover'):m.setAttribute('popover','auto');f();q.addEventListener('change',f)})()`;

function shell(page, body) {
  const abs = page.url ? cfg.siteUrl + page.url : null;
  const noindex = page.noindex || !cfg.indexable;
  const cur = (u) => (u === page.url ? ' aria-current="page"' : '');
  const jsonLd = page.url === '/' ? `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    name: 'Golden Triangle Consulting',
    url: cfg.siteUrl + '/',
    image: cfg.siteUrl + '/og.png',
    description: page.description,
    founder: [{ '@type': 'Person', name: 'Steve Dogiakos' }, { '@type': 'Person', name: 'Sandra Dogiakos' }],
    address: { '@type': 'PostalAddress', addressLocality: 'Choteau', addressRegion: 'MT', addressCountry: 'US' },
  })}</script>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
${page.description ? `<meta name="description" content="${esc(page.description)}">` : ''}
${abs ? `<link rel="canonical" href="${abs}">` : ''}
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(cfg.siteName)}">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${esc(page.title)}">
${page.description ? `<meta property="og:description" content="${esc(page.description)}">` : ''}
${abs ? `<meta property="og:url" content="${abs}">` : ''}
<meta property="og:image" content="${cfg.siteUrl}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A gold triangle on a dark blue background">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#10263b">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/${fonts.archivo.name}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/${fonts.inter.name}" as="font" type="font/woff2" crossorigin>
<style>${css}</style>
${jsonLd}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
<div class="container header-inner">
<a class="brand" href="/">Golden Triangle Consulting<span>Steve and Sandra Dogiakos</span></a>
<nav class="site-nav" aria-label="Primary">
<button class="btn btn-outline menu-button" type="button" popovertarget="site-menu" aria-controls="site-menu">Menu</button>
<ul id="site-menu" class="site-menu" popover="auto">
${nav.map(([u, t]) => `<li><a href="${u}"${cur(u)}>${t}</a></li>`).join('')}<li class="menu-book"><a href="${BOOK}"${cur(BOOK)}>Book a time</a></li>
</ul>
</nav>
<a class="btn btn-outline header-book" href="${BOOK}">Book a time</a>
</div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
<div class="container footer-inner">
<p><strong>Golden Triangle Consulting</strong>Steve and Sandra Dogiakos<br>Choteau, Montana</p>
<nav aria-label="Footer"><ul>${footerLinks.map(([u, t]) => `<li><a href="${u}">${t}</a></li>`).join('')}</ul></nav>
</div>
</footer>
<script>${navScript}</script>
${cfg.webAnalyticsToken ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${esc(cfg.webAnalyticsToken)}"}'></script>` : ''}
</body>
</html>
`.replace(/\n{2,}/g, '\n');
}

// ---------- OG image: 1200x630 PNG, Front Ink with a Triangle Gold triangle ----------
function ogPng() {
  const W = 1200, H = 630, ink = [0x10, 0x26, 0x3b], gold = [0xf5, 0xb8, 0x2e];
  const A = [600, 135], B = [810, 495], C = [390, 495];
  const edge = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const inside = (x, y) => edge(A, B, x, y) >= 0 && edge(B, C, x, y) >= 0 && edge(C, A, x, y) >= 0;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    for (let x = 0; x < W; x++) {
      let hit = 0;
      if (y >= 134 && y <= 496 && x >= 389 && x <= 811) {
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
      }
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(ink[c] + (gold[c] - ink[c]) * (hit / 16));
    }
  }
  const part = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), part('IHDR', ihdr), part('IDAT', zlib.deflateSync(raw, { level: 9 })), part('IEND', Buffer.alloc(0))]);
}

// ---------- write ----------
fs.rmSync(out, { recursive: true, force: true });
for (const page of pages) {
  const blocks = clean(page.blocks, page);
  const body = page.url === '/' ? homeBody(page, blocks)
    : page.url === '/work/' ? workBody(page, blocks)
    : page.url === '/contact/' ? contactBody(page, blocks)
    : genericBody(page, blocks);
  write(page.file, shell(page, body));
}
write(`fonts/${fonts.archivo.name}`, fonts.archivo.data);
write(`fonts/${fonts.inter.name}`, fonts.inter.data);
write('og.png', ogPng());
write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#10263b"/><path d="M16 7 26 25H6Z" fill="#f5b82e"/></svg>\n');

const indexable = pages.filter((p) => p.url && !p.noindex);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexable.map((p) => `  <url><loc>${cfg.siteUrl}${p.url}</loc></url>`).join('\n')}\n</urlset>\n`);
write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${cfg.siteUrl}/sitemap.xml\n`);
write('_headers', `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
${cfg.indexable ? '' : '  X-Robots-Tag: noindex\n'}
/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/og.png
  Cache-Control: public, max-age=86400

/favicon.svg
  Cache-Control: public, max-age=86400
`);

const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.renameSync(out, dist);
fs.writeFileSync(path.join(root, 'OPEN-ITEMS.txt'), [
  'Open items found by src/build.mjs. This file is written again on each build.',
  '', `Content to come (${report.pending.length}):`, ...report.pending.map((s) => `- ${s}`),
  '', `Statements to confirm, not shown on the site (${report.confirm.length}):`, ...report.confirm.map((s) => `- ${s}`), '',
].join('\n'));
console.log(`Built ${pages.length} pages to dist/ for ${cfg.siteUrl} (indexable: ${cfg.indexable}). Sitemap URLs: ${indexable.length}. Pending: ${report.pending.length}. Confirm: ${report.confirm.length}.`);
