import { describe, expect, it } from 'vitest';
import { registerKey, request } from './helpers';

describe('GET /og', () => {
  it('401s when the key parameter is missing', async () => {
    const res = await request('/og?title=Hello+World');
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/key/i);
  });

  it('401s when the key parameter is invalid', async () => {
    const res = await request('/og?title=Hello+World&key=sk_this_key_does_not_exist_0000');
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/invalid api key/i);
  });

  it('400s when the title parameter is missing', async () => {
    const { rawKey } = await registerKey();
    const res = await request(`/og?key=${rawKey}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/title/i);
  });

  it('400s when the title parameter is present but blank', async () => {
    const { rawKey } = await registerKey();
    const res = await request(`/og?title=%20%20&key=${rawKey}`);
    expect(res.status).toBe(400);
  });

  it('returns a 200 PNG for a valid request', async () => {
    const { rawKey } = await registerKey();
    const res = await request(`/og?title=Hello+World&description=A+test&domain=example.com&key=${rawKey}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-SnapOG-Tier')).toBe('free');

    const buf = await res.arrayBuffer();
    // A real 1200x630 PNG is easily several KB; a stub/blank response
    // would not be. This guards against a silently broken renderer.
    expect(buf.byteLength).toBeGreaterThan(1000);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const magic = new Uint8Array(buf.slice(0, 8));
    expect(Array.from(magic)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('rejects an unknown key even if the title is valid', async () => {
    const res = await request('/og?title=Hello&key=sk_' + '0'.repeat(64));
    expect(res.status).toBe(401);
  });
});
