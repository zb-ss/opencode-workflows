/**
 * Hook logging utility.
 * Appends timestamped entries below the selected OpenCode workflow directory.
 * Never throws — logging is best-effort.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const xdg = process.env.XDG_CONFIG_HOME;
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || (xdg
  ? path.join(xdg, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode'));

export const LOG_FILE = path.join(CONFIG_DIR, 'workflows', 'hook.log');

/**
 * Append a timestamped log entry. Never throws.
 */
export function log(event: string, message: string): void {
  try {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${event}] ${message}\n`;

    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    fs.appendFileSync(LOG_FILE, entry, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(LOG_FILE, 0o600); } catch {}
  } catch {
    // Never throw from logging
  }
}
