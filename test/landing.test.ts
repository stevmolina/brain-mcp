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
    expect(html).toContain('<link rel="canonical" href="https://brain.mcpbox.dev/">');
    expect(html).toContain('https://computer.mcpbox.dev');
    expect(html).toContain('https://sessions.mcpbox.dev');
    expect(html).toContain('href="https://stevmolina.com">Made by');
    expect(html).toContain('>Agent Computer</a>');
    expect(html).toContain('>Agent Sessions</a>');
    expect(html).toContain('href="#guide"');
    expect(html).not.toMatch(/\bMCP\b/i);

    const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(jsonLd).not.toBeNull();
    expect(JSON.parse(jsonLd?.[1] ?? '')).toMatchObject({
      '@type': 'SoftwareApplication',
      name: 'Agent Brain',
      url: 'https://brain.mcpbox.dev/',
      creator: {
        '@type': 'Person',
        name: 'Steven Molina',
        jobTitle: 'Forward Deployed AI Engineer',
        url: 'https://stevmolina.com',
        sameAs: [
          'https://x.com/stev_molina',
          'https://www.linkedin.com/in/steven-ml',
          'https://github.com/stevmolina',
        ],
      },
    });
    expect(html).toContain('$10<span>/mo</span>');
    expect(html).toContain('"price": "10"');
    expect(html).not.toContain('$X');
    expect(html).not.toContain('price TBD');
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
    expect(robots.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await robots.text()).toContain('Sitemap: https://brain.mcpbox.dev/sitemap.xml');

    const sitemap = await fetch(`${base}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toMatch(/xml/);
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain('<loc>https://brain.mcpbox.dev/</loc>');

    const llms = await fetch(`${base}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(llms.headers.get('content-type')).toMatch(/text\/plain/);
    const llmsText = await llms.text();
    expect(llmsText).toContain('# Agent Brain');
    expect(llmsText).toContain('USD 10/month');
    expect(llmsText).toContain('Steven Molina, Forward Deployed AI Engineer (https://stevmolina.com)');
    expect(llmsText).toContain('Agent Computer (https://computer.mcpbox.dev)');
    expect(llmsText).toContain('Agent Sessions (https://sessions.mcpbox.dev)');
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
