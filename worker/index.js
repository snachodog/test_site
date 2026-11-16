// Worker for the Golden Triangle Consulting site.
// Static files come from dist/. This script handles only the contact form at /api/contact.
// Delivery needs two things that are not in the repository:
//   1. The secret CONTACT_TO (the private delivery address): npx wrangler secret put CONTACT_TO
//   2. Email sending enabled for the domain of CONTACT_FROM: npx wrangler email sending enable dogiakos.com
// Until both exist, the handler returns status 503 and sends nothing.

const ORG_TYPES = ['Nonprofit or club', 'Small business', 'Government or tourism', 'Individual'];
const SERVICES = ['Websites and hosting', 'CRM and automation', 'IT and self-hosted systems', 'Nonprofit consulting', 'Not sure'];
const LIMITS = { name: 200, email: 254, organization: 200, message: 5000 };

const page = (status, heading, text) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${heading}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>${heading}</h1><p>${text}</p><p><a href="/contact/">Go back to the contact page</a> or <a href="/lets-chat/">book a time</a>.</p></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
);

const oneLine = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();

export function validate(form) {
  const data = {
    name: oneLine(form.get('name')),
    email: oneLine(form.get('email')),
    organization: oneLine(form.get('organization')),
    organization_type: oneLine(form.get('organization_type')),
    service: oneLine(form.get('service')),
    message: String(form.get('message') ?? '').trim(),
  };
  const errors = [];
  if (!data.name) errors.push('name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('email');
  if (!ORG_TYPES.includes(data.organization_type)) errors.push('organization type');
  if (!SERVICES.includes(data.service)) errors.push('service');
  if (!data.message) errors.push('message');
  for (const [field, max] of Object.entries(LIMITS)) if (data[field].length > max) errors.push(`${field} is too long`);
  return { data, errors };
}

export async function contact(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return page(403, 'Message not sent', 'The form was sent from a different website.');

  let form;
  try { form = await request.formData(); } catch { return page(400, 'Message not sent', 'The form data was not readable.'); }

  // Hidden field. A person leaves it empty. A script fills it. Answer as if the message was sent.
  if (oneLine(form.get('website'))) return Response.redirect(new URL('/thanks/', url), 303);

  const { data, errors } = validate(form);
  if (errors.length) return page(400, 'Message not sent', `Check these fields: ${errors.join(', ')}.`);

  if (!env.EMAIL || !env.CONTACT_TO || !env.CONTACT_FROM) return page(503, 'Message not sent', 'The contact form is not connected yet.');

  const text = [
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Organization: ${data.organization || '(not given)'}`,
    `Organization type: ${data.organization_type}`,
    `Needs help with: ${data.service}`,
    '',
    data.message,
  ].join('\n');

  try {
    await env.EMAIL.send({
      to: env.CONTACT_TO,
      from: { email: env.CONTACT_FROM, name: 'Golden Triangle Consulting website' },
      replyTo: data.email,
      subject: `Website message from ${data.name}`.slice(0, 150),
      text,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'contact_send_failed', code: error.code, message: error.message }));
    return page(502, 'Message not sent', 'The message was not delivered. Try again in a few minutes.');
  }
  return Response.redirect(new URL('/thanks/', url), 303);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/api/contact') return contact(request, env);
    return env.ASSETS.fetch(request);
  },
};
