/**
 * Hook logging utility.
 * Appends timestamped entries to ~/.config/opencode/workflows/hook.log.
 * Never throws — logging is best-effort.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const xdg = process.env.XDG_CONFIG_HOME;
const CONFIG_DIR = xdg
  ? path.join(xdg, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode');

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
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.appendFileSync(LOG_FILE, entry, 'utf8');
  } catch {
    // Never throw from logging
  }
}
