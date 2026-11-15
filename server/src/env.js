// Loads server/.env into process.env (Node's built-in loader, no dependency). Variables already set win.
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (err) {
  if (err.code !== 'ENOENT') throw err; // no .env is fine (for example when pm2 provides the variables)
}
