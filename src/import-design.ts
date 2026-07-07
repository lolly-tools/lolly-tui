// SPDX-License-Identifier: MPL-2.0
/**
 * Design import → a saved Layout Studio session. Reads a PDF/.ai from disk, turns its
 * first page into editable boxes (import/pdf.ts), seeds a layout-studio runtime, and
 * saves the serialised state as a project — which then opens in the ToolView like any
 * other saved session (fully re-editable). Terminal scope is PDF/.ai; IDML/Penpot stay
 * a web feature (they need a DOM/canvas the Node shell doesn't have).
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { parsePdfBytes } from './import/pdf.ts';
import { mountTool, currentQuery } from './engine-render.ts';
import { saveSession } from './store.ts';
import type { HostV1 } from '../../../engine/src/bridge/host-v1.ts';

const expandHome = (p: string): string => (p.startsWith('~') && (p.length === 1 || p[1] === '/') ? homedir() + p.slice(1) : p);

export interface ImportedSession { slot: string; label: string; query: string; toolId: string; boxes: number }

/** Import a PDF/.ai file → a saved Layout Studio project. Returns the session so the
 *  caller can open it immediately. Throws a user-facing message on any failure. */
export async function importDesignFile(path: string, host: HostV1): Promise<ImportedSession> {
  const ext = extname(path).toLowerCase();
  if (ext !== '.pdf' && ext !== '.ai') {
    throw new Error('The terminal imports PDF and .ai files. For IDML or Penpot, use the web app.');
  }
  const bytes = new Uint8Array(await readFile(expandHome(path)));
  const { boxes, background } = await parsePdfBytes(bytes);

  const { runtime } = await mountTool('layout-studio', host, '');
  await runtime.setInput('boxes', boxes as never);
  await runtime.setInput('background', background as never);
  const query = currentQuery(runtime);

  const label = `Imported ${basename(path)}`;
  const slot = `layout-studio-${Date.now()}`;
  await saveSession({ slot, toolId: 'layout-studio', label, query, updatedAt: new Date().toISOString() });
  return { slot, label, query, toolId: 'layout-studio', boxes: boxes.length };
}
