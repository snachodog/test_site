#!/usr/bin/env node
// Launch checks for the built site.
// Run: node tools/check.mjs                  (checks the files in dist/)
//      node tools/check.mjs https://host     (checks the live site)
// Exit code 1 if a check fails.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import net from 'node:net';

// Use IPv4. On a host with no IPv6 route, fetch fails with ENETUNREACH.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
const base = process.argv[2]?.replace(/\/$/, '') || null;
// A browser User-Agent: the default client User-Agent gets Cloudflare error 1010 on this zone.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Expected pages, from COPY.md.
const copy = fs.readFileSync(path.join(root, 'COPY.md'), 'utf8');
const pages = copy.split(/\n---\n/).filter((c) => /^## \d+\. /m.test(c) && c.includes('### Copy\n')).map((c) => {
  const get = (l) => (c.match(new RegExp(`\\*\\*${l}:\\*\\* (.+)`)) || [])[1]?.trim();
  const url = (get('URL') || '').replace(/`/g, '') || null;
  return { url, title: get('Title tag'), description: get('Meta description') || null, noindex: !url || /noindex/.test(get('Search') || '') };
});

const fails = [];
const fail = (where, msg) => fails.push(`${where}: ${msg}`);
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function load(urlPath) {
  if (base) {
    const res = await fetch(base + urlPath, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'br, gzip' }, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: buf, headers: res.headers };
  }
  let file = path.join(root, 'dist', urlPath);
  if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return { status: 404, body: Buffer.alloc(0), headers: new Headers() };
  return { status: 200, body: fs.readFileSync(file), headers: new Headers() };
}

const rows = [];
const linkTargets = new Set();
for (const page of pages) {
  const where = page.url || '404';
  const res = await load(page.url || (base ? '/this-page-does-not-exist/' : '/404.html'));
  const wantStatus = page.url ? 200 : (base ? 404 : 200);
  if (res.status !== wantStatus) { fail(where, `status ${res.status}, expected ${wantStatus}`); continue; }
  const html = res.body.toString('utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const meta = (attr, name) => {
    const m = head.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`));
    return m ? decode(m[1]) : null;
  };
  const title = decode((head.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  if (title !== page.title) fail(where, `title is "${title}"`);
  if (meta('name', 'description') !== page.description) fail(where, 'meta description does not match COPY.md');
  if (meta('property', 'og:title') !== page.title) fail(where, 'og:title');
  if (meta('property', 'og:description') !== page.description) fail(where, 'og:description');
  for (const p of ['og:type', 'og:site_name', 'og:image']) if (!meta('property', p)) fail(where, `${p} is missing`);
  if (meta('name', 'twitter:card') !== 'summary_large_image') fail(where, 'twitter:card');
  const canonical = (head.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || null;
  const wantUrl = page.url ? cfg.siteUrl + page.url : null;
  if (canonical !== wantUrl) fail(where, `canonical is ${canonical}`);
  if (meta('property', 'og:url') !== wantUrl) fail(where, 'og:url');
  const noindex = meta('name', 'robots') === 'noindex';
  if (noindex !== (page.noindex || !cfg.indexable)) fail(where, `robots noindex is ${noindex}`);
  if (!/<html lang="en">/.test(html)) fail(where, 'lang attribute');

  // Headings: one h1, no skipped level.
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  if (levels.filter((l) => l === 1).length !== 1) fail(where, `h1 count is ${levels.filter((l) => l === 1).length}`);
  if (levels[0] !== 1) fail(where, 'first heading is not the h1');
  levels.forEach((l, i) => { if (i && l > levels[i - 1] + 1) fail(where, `heading level skips from h${levels[i - 1]} to h${l}`); });
  for (const tag of ['<header', '<nav', '<main', '<footer']) if (!html.includes(tag)) fail(where, `${tag}> landmark is missing`);

  // No draft markers, no contact data.
  const text = html.replace(/<style>[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '');
  for (const marker of ['[PLACEHOLDER', '[CONFIRM', '[IMAGE', '[EMBED', '&nbsp;', '](', '**']) if (text.includes(marker)) fail(where, `draft marker ${marker}`);
  if (/mailto:|tel:|[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text.replace('name@example.com', ''))) fail(where, 'an email address or a phone link shows');
  if (/Two Medicine/i.test(text)) fail(where, 'old TMDC name');
  if (!text.includes('Steve and Sandra Dogiakos')) fail(where, 'the two principals are not named');
  if (/15-minute/.test(text)) fail(where, 'old call length');

  for (const m of html.matchAll(/(?:href|src)="(\/[^"#]*)/g)) linkTargets.add(m[1]);
  rows.push({ page: where, html_bytes: res.body.length, gzip_bytes: zlib.gzipSync(res.body).length, h: levels.join(''), noindex });
}

// Internal links and assets resolve.
for (const target of linkTargets) {
  const res = await load(target);
  if (res.status !== 200) fail(target, `linked from a page, status ${res.status}`);
}

// Sitemap and robots.
const sm = await load('/sitemap.xml');
const locs = [...sm.body.toString().matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const want = pages.filter((p) => p.url && !p.noindex).map((p) => cfg.siteUrl + p.url);
if (JSON.stringify(locs.sort()) !== JSON.stringify(want.sort())) fail('sitemap.xml', `has ${locs.length} URLs, expected ${want.length}`);
for (const loc of locs) if ((await load(loc.replace(cfg.siteUrl, ''))).status !== 200) fail('sitemap.xml', `${loc} does not resolve`);
const robots = await load('/robots.txt');
if (!robots.body.toString().includes(`Sitemap: ${cfg.siteUrl}/sitemap.xml`)) fail('robots.txt', 'Sitemap line');
const og = await load('/og.png');
if (og.status !== 200 || og.body.readUInt32BE(16) !== 1200 || og.body.readUInt32BE(20) !== 630) fail('og.png', 'not a 1200x630 PNG');

if (base) {
  const home = await load('/');
  const font = await load([...linkTargets].find((t) => t.startsWith('/fonts/')));
  console.log(`Live headers: content-encoding=${home.headers.get('content-encoding')}, x-robots-tag=${home.headers.get('x-robots-tag')}, font cache-control=${font.headers.get('cache-control')}`);
  if (!cfg.indexable && home.headers.get('x-robots-tag') !== 'noindex') fail('/', 'X-Robots-Tag header is missing');
  if (!/immutable/.test(font.headers.get('cache-control') || '')) fail('fonts', 'no immutable cache header');
}

console.table(rows);
console.log(`Checked ${rows.length} pages, ${linkTargets.size} internal links and assets, ${locs.length} sitemap URLs on ${base || 'dist/'}.`);
if (fails.length) { console.log(`FAIL (${fails.length}):\n` + fails.map((f) => `- ${f}`).join('\n')); process.exit(1); }
console.log('PASS');
