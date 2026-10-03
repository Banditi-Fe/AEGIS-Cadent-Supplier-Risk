import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(process.cwd(), 'apps/core-api/public'),
  join(process.cwd(), 'public'),
  join(sourceDir, '../public'),
  join(sourceDir, '../../apps/core-api/public'),
];

export const PUBLIC_ASSETS_DIR = candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? candidates[0]!;
