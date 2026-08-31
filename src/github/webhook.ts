/**
 * Push webhook. A push to a brain's default branch triggers a full rebuild of
 * that brain's rows. Signature is checked against the raw body before anything
 * else looks at it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { loadConfig } from '../config.js';
import { db } from '../db/client.js';
import { indexBrainAtCommit } from '../indexer/sync.js';
import type { BrainRow } from '../types.js';

export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: { name?: string; owner?: { login?: string; name?: string }; default_branch?: string };
  installation?: { id?: number };
}

export async function handleGithubWebhook(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody) || !verifySignature(rawBody, req.header('x-hub-signature-256'), config.githubWebhookSecret)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  const event = req.header('x-github-event');
  if (event === 'ping') {
    res.status(200).json({ ok: true });
    return;
  }
  if (event !== 'push') {
    res.status(202).json({ ignored: event });
    return;
  }

  const payload = JSON.parse(rawBody.toString('utf8')) as PushPayload;
  const owner = payload.repository?.owner?.login ?? payload.repository?.owner?.name;
  const name = payload.repository?.name;
  const commit = payload.after;

  if (!owner || !name || !commit) {
    res.status(400).json({ error: 'incomplete push payload' });
    return;
  }

  const { rows } = await db().query<BrainRow>(
    'select * from brains where repo_owner = $1 and repo_name = $2',
    [owner, name],
  );
  const brain = rows[0];
  if (!brain) {
    res.status(202).json({ ignored: 'repo is not a registered brain' });
    return;
  }

  if (payload.ref !== `refs/heads/${brain.default_branch}`) {
    res.status(202).json({ ignored: `not ${brain.default_branch}`, ref: payload.ref });
    return;
  }

  // A push may carry the installation id; keep the brain row current so a
  // reinstall does not need a manual fix.
  if (payload.installation?.id && String(payload.installation.id) !== String(brain.installation_id)) {
    await db().query('update brains set installation_id = $1 where id = $2', [payload.installation.id, brain.id]);
    brain.installation_id = String(payload.installation.id);
  }

  res.status(202).json({ accepted: true, brain: brain.id, commit });

  // Rebuild after answering: GitHub's delivery timeout is short and a rebuild is
  // idempotent, so a redelivery costs nothing.
  indexBrainAtCommit(brain, commit)
    .then((result) => console.log(JSON.stringify({ level: 'info', at: 'indexer', ...result })))
    .catch((error) =>
      console.error(
        JSON.stringify({ level: 'error', at: 'indexer', brain: brain.id, commit, message: String(error) }),
      ),
    );
}
