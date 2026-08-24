import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
chmodSync(join(scriptsDirectory, '..', 'dist', 'index.js'), 0o755);
