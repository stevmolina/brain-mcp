import { reconcileAll } from '../src/reconcile/run.js';
import { closeDb } from '../src/db/client.js';

for (const result of await reconcileAll(process.argv[2])) console.log(JSON.stringify(result));
await closeDb();
