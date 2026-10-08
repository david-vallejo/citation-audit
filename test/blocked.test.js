import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksBlocked } from '../src/fetch/page.js';

const pad = '<p>' + 'Fence contractor serving the area. '.repeat(80) + '</p>';

test('a real profile with a recaptcha key in its page config is not blocked', () => {
  const html = `<html><head><title>Kingdom Fence and Supply | BBB Business Profile</title>
<script>window.__ENV={"NEXT_PUBLIC_GOOGLE_RECAPTCHA_SITE_KEY":"6Lfm-HorAAAA"}</script></head>
<body><h1>Kingdom Fence and Supply</h1><p>1304 Holtwood Rd, Holtwood, PA 17532</p>${pad}</body></html>`;
  assert.equal(looksBlocked(200, html), false);
});

test('challenge pages are still blocked', () => {
  const cloudflare = `<html><head><title>Just a moment...</title></head><body><p>Enable JavaScript and cookies to continue</p>${pad}</body></html>`;
  const perimeterx = `<html><head><title>Access to this page has been denied</title></head><body><div id="px-captcha"></div>${pad}</body></html>`;
  const datadome = `<html><head><title>yelp.com</title><script src="https://ct.captcha-delivery.com/c.js"></script></head><body>${pad}</body></html>`;
  const human = `<html><head><title>Verify</title></head><body><h1>Are you a human?</h1>${pad}</body></html>`;
  for (const html of [cloudflare, perimeterx, datadome, human]) assert.equal(looksBlocked(200, html), true);
});

test('error statuses and tiny bodies are blocked', () => {
  assert.equal(looksBlocked(403, `<html>${pad}</html>`), true);
  assert.equal(looksBlocked(200, '<html><body>nope</body></html>'), true);
});
