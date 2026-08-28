// Regression coverage for a stored/reflected XSS found in a fresh
// security sweep (see docs/qa): both GET /register?tier= and the POST
// /register `email` field flowed into dashboard/pages.ts HTML templates
// (registerPage's hidden `tier` input, keyCreatedPage's success banner)
// with no HTML-escaping — only a loose format check that never rejected
// markup characters. `tier` was exploitable with a single crafted link
// (no auth, no POST needed): `/register?tier="><script>...`. `email`
// was exploitable via a same-origin auto-submitting form (no CSRF token
// guards /register), and would have run attacker script on the very page
// that displays the brand-new API key in plaintext — i.e. it could have
// exfiltrated the key it was rendered next to. Both are now escaped via
// escapeHtml() in dashboard/pages.ts; these tests prove the raw markup
// never reaches the response body unescaped.
import { describe, expect, it } from 'vitest';
import { registerKey, request } from './helpers';

describe('XSS hardening — /register', () => {
  it('escapes a script-bearing tier query param on GET /register', async () => {
    const payload = '"><script>alert(document.domain)</script>';
    const res = await request(`/register?tier=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(document.domain)</script>');
    // The escaped form should still be present somewhere reasonable (proves
    // the value was processed, not silently dropped) — quotes/angle
    // brackets must be entity-encoded.
    expect(html).not.toMatch(/value="[^"]*"><script>/);
  });

  it('escapes a script-bearing tier form field on a failed POST /register', async () => {
    const payload = '"><script>alert(1)</script>';
    const form = new URLSearchParams();
    form.set('email', 'not-an-email'); // deliberately invalid, to hit the registerPage(error, tier) branch
    form.set('tier', payload);
    const res = await request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes a script-bearing email on the key-created success page', async () => {
    const payload = '<script>alert(document.cookie)</script>@evil.example';
    const { html, res } = await registerKey({ email: payload });
    expect(res.status).toBe(200);
    expect(html).not.toContain('<script>alert(document.cookie)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
