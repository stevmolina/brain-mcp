/**
 * Browser pages for signup's onboarding. Static enough to be HTML strings.
 * Every value that came from a user is escaped.
 */
import type { ClaimView } from '../types.js';
import { FREE_NOTE_LIMIT } from '../billing/plans.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function simplePage(title: string, body: string): string {
  return layout(title, `<main class="card"><h1>${escapeHtml(title)}</h1>${body}</main>`);
}

export interface AppModel {
  email: string;
  brainId: string;
  plan: 'free' | 'team';
  noteCount: number;
  notes: ClaimView[];
  query: string;
  results: ClaimView[] | null;
  error: string | null;
  saved: boolean;
  /** Set while a checkout or a cancellation is still waiting on the webhook. */
  waiting: 'team' | 'cancel' | null;
  mcpUrl: string;
}

export function appPage(model: AppModel): string {
  const atLimit = model.plan === 'free' && model.noteCount >= FREE_NOTE_LIMIT;
  const planLabel = model.plan === 'team' ? 'Team · $10/mo' : `Free · ${model.noteCount} of ${FREE_NOTE_LIMIT} notes`;
  const confirm =
    model.waiting === 'team'
      ? `<p class="banner" id="confirm">Confirming your Team plan… this page updates when payment lands.</p>`
      : model.waiting === 'cancel'
        ? `<p class="banner" id="confirm">Updating your plan… cancellation shows up here when it lands.</p>`
        : '';
  const saved = model.saved ? `<p class="banner ok">Saved. Search can see it, and so can a connected agent.</p>` : '';
  const error = model.error ? `<p class="banner warn">${escapeHtml(model.error)}</p>` : '';

  const writer = atLimit
    ? `<section class="card upgrade">
        <h2>You've used all ${FREE_NOTE_LIMIT} Free notes.</h2>
        <p>Team is $10 a month and removes the cap. The notes you already saved stay.</p>
        <form method="post" action="/billing/checkout"><button class="btn pink" type="submit">Upgrade to Team · $10/mo</button></form>
      </section>`
    : `<section class="card">
        <h2>Save a note</h2>
        <form method="post" action="/app/notes">
          <label for="note">One sentence. Agents will be able to search it.</label>
          <textarea id="note" name="text" required minlength="3" maxlength="1000" rows="3" placeholder="Launch is November 4."></textarea>
          <button class="btn" type="submit">Save note</button>
        </form>
      </section>`;

  const manage =
    model.plan === 'team'
      ? `<form method="post" action="/billing/portal"><button class="btn ghost" type="submit">Manage or cancel</button></form>`
      : `<form method="post" action="/billing/checkout"><button class="btn pink" type="submit">Upgrade to Team · $10/mo</button></form>`;

  const noteList = model.notes.length
    ? `<ul class="notes">${model.notes.map(renderNote).join('')}</ul>`
    : `<p class="muted">No notes yet.</p>`;

  const results =
    model.results === null
      ? ''
      : `<h3>${model.results.length} result${model.results.length === 1 ? '' : 's'} for “${escapeHtml(model.query)}”</h3>
         ${model.results.length ? `<ul class="notes">${model.results.map(renderNote).join('')}</ul>` : '<p class="muted">Nothing matches.</p>'}`;

  const cursorConfig = JSON.stringify(
    { mcpServers: { 'agent-brain': { url: model.mcpUrl } } },
    null,
    2,
  );

  return layout(
    'Your brain',
    `<main>
      ${confirm}
      ${saved}
      ${error}
      <header class="top">
        <div>
          <p class="kicker">Starter brain</p>
          <h1>Your agents can read this.</h1>
          <p class="muted">${escapeHtml(model.email)} · <code>${escapeHtml(model.brainId)}</code></p>
        </div>
        <div class="plan">
          <span class="pill">${escapeHtml(planLabel)}</span>
          ${manage}
          <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
        </div>
      </header>
      ${writer}
      <section class="card">
        <h2>Search</h2>
        <form class="search" method="get" action="/app">
          <label class="sr" for="q">Search your notes</label>
          <input id="q" name="q" value="${escapeHtml(model.query)}" placeholder="Search your notes">
          <button class="btn" type="submit">Search</button>
        </form>
        ${results}
        <h3>Notes</h3>
        ${noteList}
      </section>
      <section class="card" id="connect">
        <h2>Connect Claude, ChatGPT, or Cursor</h2>
        <p>Use the same email you just signed up with. The server address is:</p>
        <p><input class="url" readonly value="${escapeHtml(model.mcpUrl)}" onclick="this.select()"></p>
        <ol>
          <li><b>Claude.</b> Settings → Connectors → Add custom connector. Paste the address and sign in.</li>
          <li><b>ChatGPT.</b> Settings → Apps → Advanced settings, turn on Developer mode, then create a connector with the same address and sign in.</li>
          <li><b>Cursor.</b> Add this to <code>~/.cursor/mcp.json</code> (or the project <code>.cursor/mcp.json</code>):</li>
        </ol>
        <pre>${escapeHtml(cursorConfig)}</pre>
      </section>
    </main>
    <script>
      const params = new URLSearchParams(location.search);
      const started = ${JSON.stringify(model.plan)};
      const waiting = params.get('checkout') === 'success' || params.get('billing') === 'updated';
      if (waiting && document.getElementById('confirm')) {
        const timer = setInterval(async () => {
          try {
            const res = await fetch('/api/account', { headers: { accept: 'application/json' } });
            if (!res.ok) return;
            const body = await res.json();
            if (body.plan && body.plan !== started) location.reload();
          } catch { /* keep waiting */ }
        }, 1000);
        setTimeout(() => clearInterval(timer), 30000);
      }
    </script>`,
  );
}

function renderNote(note: ClaimView): string {
  return `<li><p>${escapeHtml(note.text)}</p><span class="src">${escapeHtml(note.page)}:${note.line}</span></li>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} — Agent Brain</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div class="wrap">
    <a class="brand" href="/">Agent Brain</a>
    ${body}
  </div>
</body>
</html>`;
}
