import type { BrainRow } from '../../types.js';

export interface Finding {
  checkName: string;
  severity: 'info' | 'warn' | 'error';
  claimId?: string | null;
  pagePath?: string | null;
  detail: string;
}

export interface Check {
  name: string;
  run(brain: BrainRow): Promise<Finding[]>;
}
