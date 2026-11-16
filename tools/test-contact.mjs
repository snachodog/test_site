#!/usr/bin/env node
// Tests the contact form handler with a fake email binding. Sends no email.
// Run: node tools/test-contact.mjs
import assert from 'node:assert/strict';
import { contact } from '../worker/index.js';

const good = { name: 'Test Person', email: 'person@example.com', organization: '', organization_type: 'Nonprofit or club', service: 'Not sure', message: 'Line one\nLine two' };
const post = (fields, headers = {}) => new Request('https://site.test/api/contact', { method: 'POST', body: new URLSearchParams(fields), headers });
const sent = [];
const env = { EMAIL: { send: async (m) => { sent.push(m); } }, CONTACT_TO: 'private@example.com', CONTACT_FROM: 'website@example.com' };

let r = await contact(post(good), env);
assert.equal(r.status, 303); assert.equal(r.headers.get('Location'), 'https://site.test/thanks/');
assert.equal(sent.length, 1); assert.equal(sent[0].to, 'private@example.com'); assert.equal(sent[0].replyTo, 'person@example.com');

r = await contact(post({ ...good, name: 'A\r\nBcc: x@example.com' }), env);
assert.equal(r.status, 303); assert.ok(!/[\r\n]/.test(sent[1].subject), 'no line break in the subject');

r = await contact(post({ ...good, email: 'not-an-address' }), env); assert.equal(r.status, 400);
r = await contact(post({ ...good, service: 'Something else' }), env); assert.equal(r.status, 400);
r = await contact(post({ ...good, message: 'x'.repeat(5001) }), env); assert.equal(r.status, 400);
r = await contact(post({ ...good, website: 'http://spam.test' }), env); assert.equal(r.status, 303);
r = await contact(post(good, { Origin: 'https://other.test' }), env); assert.equal(r.status, 403);
r = await contact(new Request('https://site.test/api/contact'), env); assert.equal(r.status, 405);
r = await contact(post(good), {}); assert.equal(r.status, 503);
r = await contact(post(good), { ...env, EMAIL: { send: async () => { const e = new Error('x'); e.code = 'E_DELIVERY_FAILED'; throw e; } } }); assert.equal(r.status, 502);
assert.equal(sent.length, 2, 'only the two valid messages were sent');
console.log('PASS: 10 contact handler cases');
