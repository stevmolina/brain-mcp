import { migrate } from '../src/db/migrate.js';
import { closeDb } from '../src/db/client.js';

const ran = await migrate();
console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date');
await closeDb();
