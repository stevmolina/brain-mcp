import { missingVerifiedAt } from './missing-verified-at.js';
import { orphanSources } from './orphan-sources.js';
import { staleLive } from './stale-live.js';
import { supersededStillLive } from './superseded-still-live.js';
import type { Check } from './types.js';

export const checks: Check[] = [staleLive, missingVerifiedAt, orphanSources, supersededStillLive];
export type { Check, Finding } from './types.js';
