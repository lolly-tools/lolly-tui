// SPDX-License-Identifier: MPL-2.0
/**
 * Persistent, on-device store for the TUI — the CLI shell is ephemeral (in-memory),
 * but a usable interactive shell needs saved projects and a profile that stick. Both
 * are plain JSON under a config dir (`~/.lolly`, or $LOLLY_TUI_DIR). No network, no DB
 * — files on disk, matching the offline-first ethos of every other shell.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DIR = process.env.LOLLY_TUI_DIR || join(homedir(), '.lolly');
const SESSIONS_DIR = join(DIR, 'sessions');
const PROFILE_PATH = join(DIR, 'profile.json');

export function configDir(): string { return DIR; }

/** Where exports land by default — the user's Desktop (falls back to home). Created on
 *  write if missing (see engine-render.exportToFile). */
export function defaultExportDir(): string {
  const desktop = join(homedir(), 'Desktop');
  return existsSync(desktop) ? desktop : homedir();
}

async function ensure(): Promise<void> { await mkdir(SESSIONS_DIR, { recursive: true }); }

/** A saved "project" — a tool plus its serialised URL-state, so it reopens through
 *  the same parseUrlState round-trip the web/CLI use (robust across value shapes). */
export interface SavedSession {
  slot: string;
  toolId: string;
  label: string;
  query: string;
  updatedAt: string;
}

export function slug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

export async function listSessions(): Promise<SavedSession[]> {
  await ensure();
  const files = existsSync(SESSIONS_DIR) ? await readdir(SESSIONS_DIR) : [];
  const out: SavedSession[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(await readFile(join(SESSIONS_DIR, f), 'utf8')) as SavedSession); } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function saveSession(s: SavedSession): Promise<void> {
  await ensure();
  await writeFile(join(SESSIONS_DIR, s.slot + '.json'), JSON.stringify(s, null, 2));
}

export async function deleteSession(slot: string): Promise<void> {
  try { await unlink(join(SESSIONS_DIR, slot + '.json')); } catch { /* already gone */ }
}

/** Rename a saved session (its display label only) — keeps slot + updatedAt so its
 *  position in the 'recent' order doesn't jump. */
export async function renameSession(slot: string, label: string): Promise<void> {
  const p = join(SESSIONS_DIR, slot + '.json');
  const s = JSON.parse(await readFile(p, 'utf8')) as SavedSession;
  s.label = label;
  await writeFile(p, JSON.stringify(s, null, 2));
}

export async function getProfile(): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(PROFILE_PATH, 'utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

export async function setProfile(p: Record<string, unknown>): Promise<void> {
  await ensure();
  await writeFile(PROFILE_PATH, JSON.stringify(p, null, 2));
}

/** Back up everything the TUI persists (all saved projects + profile + folders) into a
 *  single portable zip on the Desktop — the "export my data" half of the web feature.
 *  Reopenable: each project keeps its serialised URL-state. Returns the written path. */
export async function backupData(stamp: string): Promise<{ path: string; count: number }> {
  const { zipSync, strToU8 } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  const sessions = await listSessions();
  for (const s of sessions) files[`sessions/${s.slot}.json`] = strToU8(JSON.stringify(s, null, 2));
  try { files['profile.json'] = strToU8(await readFile(PROFILE_PATH, 'utf8')); } catch { /* none */ }
  try { files['folders.json'] = strToU8(await readFile(join(DIR, 'folders.json'), 'utf8')); } catch { /* none */ }
  const zip = zipSync(files, { level: 6 });
  const path = join(defaultExportDir(), `lolly-backup-${stamp}.zip`);
  await mkdir(defaultExportDir(), { recursive: true });
  await writeFile(path, Buffer.from(zip));
  return { path, count: sessions.length };
}
