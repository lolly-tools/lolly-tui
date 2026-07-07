// SPDX-License-Identifier: MPL-2.0
/**
 * Shared headless-Chromium launcher for the TUI's browser render tier.
 *
 * The TUI is normally the CLI's DOM-free path (svg/emf/eps + text/data). This module
 * is the opt-in "Tier B" that makes the terminal shell able to do what only a real
 * browser can — screenshot a live URL (url-shot) and rasterise/print HTML-layout tools
 * to png/jpg/pdf/video. It reuses the SAME scoped Chromium the MCP server installs
 * (`services/mcp/.browsers`, via `npm run install:browser`) so nothing new downloads.
 *
 * Lazy + pooled: the browser launches on first use (never at TUI boot) and is reused
 * across renders in a session. `closeBrowser()` tears it down on exit.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// shells/tui/src → repo root is three levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The MCP server's scoped Chromium install — the render tier travels with the repo.
const BROWSERS_DIR = join(REPO_ROOT, 'services', 'mcp', '.browsers');

/** Raised for a caller-facing render problem (browser missing, navigation failed). */
export class BrowserError extends Error {}

let browserPromise: Promise<import('playwright-core').Browser> | null = null;

/**
 * Launch (or reuse) the scoped Chromium. Resolves the browser the same way the MCP
 * render path does: an explicit LOLLY_BROWSER_CHANNEL / LOLLY_BROWSER_PATH wins,
 * otherwise Chromium is loaded from the scoped install directory.
 */
export async function getBrowser(): Promise<import('playwright-core').Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const channel = process.env.LOLLY_BROWSER_CHANNEL;   // e.g. 'chrome'
      const executablePath = process.env.LOLLY_BROWSER_PATH;
      if (!channel && !executablePath) {
        process.env.PLAYWRIGHT_BROWSERS_PATH ??= BROWSERS_DIR;
      }
      const { chromium } = await import('playwright-core');
      try {
        return await chromium.launch({
          ...(channel ? { channel } : {}),
          ...(executablePath ? { executablePath } : {}),
          args: ['--no-sandbox'],
        });
      } catch (err) {
        const msg = (err as Error).message || '';
        if (/executable doesn't exist|Executable doesn't exist|please run|not been downloaded/i.test(msg)) {
          throw new BrowserError(
            'The TUI needs Chromium for raster/PDF/URL-capture export. Run ' +
            '`npm run install:browser` (downloads Chromium into services/mcp/.browsers), ' +
            'or point LOLLY_BROWSER_CHANNEL / LOLLY_BROWSER_PATH at an existing browser.',
          );
        }
        throw err;
      }
    })().catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

/** Whether the scoped Chromium install is present (cheap check — no launch). */
export function browserInstalled(): boolean {
  if (process.env.LOLLY_BROWSER_CHANNEL || process.env.LOLLY_BROWSER_PATH) return true;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || BROWSERS_DIR;
  return existsSync(dir);
}

export async function closeBrowser(): Promise<void> {
  const b = browserPromise;
  browserPromise = null;
  if (b) { try { (await b).close(); } catch { /* ignore */ } }
}
