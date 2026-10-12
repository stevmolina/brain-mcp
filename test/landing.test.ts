/**
 * The landing is static HTML on GET /. It is mounted after the API, so the
 * routes a client, a monitor, or GitHub already call keep their answers.
 *
 * Same env as CI: loadConfig() requires the eight variables, and booting the
 * app reads AuthKit's public metadata. Nothing here is a secret, and nothing
 * touches the database.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let server: Server | undefined;
let base: string;

beforeAll(async () => {
  const app = await createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (!server) return;
  const listening = server;
  await new Promise<void>((resolve, reject) => {
    listening.close((err) => (err ? reject(err) : resolve()));
  });
});

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('GET /', () => {
  it('returns the Agent Brain landing as HTML', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Agent Brain — Your agents remember.');
    expect(html).toContain('https://brain.mcpbox.dev/');
    expect(html).toContain('https://computer.mcpbox.dev');
    expect(html).toContain('https://www.stevmolina.com');
    expect(html).toContain('href="#guide"');
    expect(html).toContain('SoftwareApplication');
    expect(html).toContain('Forward Deployed AI Engineer');
    expect(html).toContain('$X');
    expect(html).toContain('price TBD');
    expect(html).not.toContain('answers need review');
    expect(html).not.toContain('Cannot GET');
  });

  it('serves the share image, robots, sitemap, and llms.txt', async () => {
    const image = await fetch(`${base}/og.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toMatch(/image\/png/);
    const size = pngSize(Buffer.from(await image.arrayBuffer()));
    expect(size).toEqual({ width: 1200, height: 630 });

    const robots = await fetch(`${base}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain('Sitemap: https://brain.mcpbox.dev/sitemap.xml');

    const sitemap = await fetch(`${base}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    expect(await sitemap.text()).toContain('https://brain.mcpbox.dev/');

    const llms = await fetch(`${base}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain('# Agent Brain');
  });
});

describe('existing routes stay in front of the landing', () => {
  it('answers liveness without the landing HTML', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('still challenges an anonymous read of /mcp', async () => {
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/i);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('<!doctype html>');
  });

  it('still rejects a webhook with no signature', async () => {
    const res = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad signature' });
  });

  it('still publishes the protected-resource metadata', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = await res.json();
    expect(body.resource).toBe('https://brain.mcpbox.dev/mcp');
  });
});
