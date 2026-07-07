// SPDX-License-Identifier: MPL-2.0
/**
 * Folder export — render every saved session in a folder subtree to a node-format file
 * (html fallback) and pack the whole tree into ONE zip on the user's Desktop.
 *
 * HARD CONSTRAINT: node-only, offline, no browser. The TUI can render svg/text/emf/eps
 * and HTML, but NOT raster/pdf/video. So a folder export zips the node-renderable outputs
 * (html fallback for HTML-layout tools, exactly as ToolView.doExport does). PDF passwords
 * are moot — no pdf is produced — but the ZIP itself can be password-locked via the
 * engine's zip-crypto framer (buildEncryptedZip), and that works here.
 *
 * The render itself is delegated to engine-render.exportToFile so the exportFile hook +
 * physical-unit handling stay in one place; this module re-implements only the html
 * fallback (which lives in the view, not the helper) and the packaging.
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, deflateSync, strToU8, type Zippable } from 'fflate';
import { crc32, buildEncryptedZip, type ZipTier, type ZipEntryInput, type BatchRow } from '@lolly/engine';
import type { JSDOM } from 'jsdom';
import { mountTool, exportToFile, exportableFormats } from './engine-render.ts';
import { listSessions, defaultExportDir, slug, type SavedSession } from './store.ts';
import { childFolders, type Folder } from './folders.ts';
import type { HostV1 } from '../../../engine/src/bridge/host-v1.ts';

/** A rendered (or skipped) member, surfaced for the tick log + result summary. */
export interface BatchMember {
  slot: string;
  label: string;
  zipPath: string;        // relative path inside the zip (nested by folder tree)
  format: string;         // format actually written (may be 'html' via fallback)
  bytes: number;
  ok: boolean;
  reason?: string;        // set when ok === false
}

export interface ExportFolderOpts {
  /** Per-file progress. `label` carries a status glyph prefix: '✓ ', '⚠ ', or '✗ '.
   *  `done` increments AFTER each session is attempted (success OR skip). */
  onProgress?: (done: number, total: number, label: string) => void;
  /** When set, the whole zip is encrypted via engine zip-crypto (buildEncryptedZip). */
  zipPassword?: string;
  /** Encryption tier when zipPassword is set. Default 'standard' (opens in any unzip,
   *  incl. Windows Explorer); 'strong' = WinZip AES-256. */
  zipTier?: ZipTier;
  /** Preferred export format; falls back per-tool when unsupported. Default 'svg'. */
  format?: string;
  unit?: string;          // default 'px'
  dpi?: number;           // default 300
  /** Where the .zip lands. Default defaultExportDir() (~/Desktop). */
  outDir?: string;
}

export interface ExportFolderResult {
  zipPath: string;        // absolute path of the written .zip
  count: number;          // sessions successfully rendered into the zip
  bytes: number;          // size of the zip on disk
  members: BatchMember[]; // every attempted session (ok + skipped), in render order
}

// Already-compressed payloads gain nothing from deflate; store them (method 0). The node
// shell only ever produces text/svg (all compressible), but keep the set for correctness
// and future formats — mirrors pro/zip.ts.
const STORE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'pdf', 'webm', 'mp4']);
const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** The small credit/manifest dropped into every zip. */
function manifestText(zipName: string, folderName: string, members: BatchMember[]): string {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const ok = members.filter(m => m.ok);
  const lines = [
    'Lolly  •  https://lolly.tools',
    '-'.repeat(56),
    '',
    `[[ ${zipName} ]]`,
    `Folder: ${folderName}`,
    `Created on ${date} at ${time} (local)`,
    '',
    `[ ${ok.length} file${ok.length === 1 ? '' : 's'} included ]`,
    '',
    ...members.map(m => (m.ok ? `✓ ${m.zipPath}` : `✗ ${m.zipPath}  (skipped: ${m.reason ?? 'unknown'})`)),
    '',
    '-'.repeat(56),
    'Rendered in the terminal (node-only): raster/PDF/video export is unavailable',
    'here — only svg/text/emf/eps/html. PDF password-protection is therefore moot;',
    'the ZIP itself is the lock when a password is set.',
    '',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Render `folder` and its whole subtree (nested via `allFolders`) into a single zip.
 * Sessions directly in `folder` sit at the zip root; sessions in a descendant folder D sit
 * under D's slugged path beneath `folder`. Filenames within one dir are deduped with a -NN
 * suffix. Adds a `lolly.txt` manifest. Returns { zipPath, count, bytes, members }.
 */
export async function exportFolder(
  host: HostV1,
  dom: JSDOM,
  folder: Folder,
  allFolders: Folder[],
  opts: ExportFolderOpts = {},
): Promise<ExportFolderResult> {
  // 1. Enumerate the subtree, mapping each folder id → its slugged path relative to
  //    `folder` (root → ''). BFS so a parent's relDir is set before its children.
  const relDirOf = new Map<string, string>();
  relDirOf.set(folder.id, '');
  const order: string[] = [folder.id];
  const queue: string[] = [folder.id];
  while (queue.length) {
    const pid = queue.shift()!;
    const base = relDirOf.get(pid)!;
    for (const child of childFolders(allFolders, pid)) {
      if (relDirOf.has(child.id)) continue; // guard against malformed cycles
      relDirOf.set(child.id, base ? `${base}/${slug(child.name)}` : slug(child.name));
      order.push(child.id);
      queue.push(child.id);
    }
  }
  // 2. Collect (ref, relDir) in render order, honouring single-membership (first wins).
  const byId = new Map(allFolders.map(f => [f.id, f]));
  const planned: { ref: string; relDir: string }[] = [];
  const claimed = new Set<string>();
  for (const id of order) {
    const f = byId.get(id);
    if (!f) continue;
    const relDir = relDirOf.get(id) ?? '';
    for (const it of f.items) {
      if (claimed.has(it.ref)) continue;
      claimed.add(it.ref);
      planned.push({ ref: it.ref, relDir });
    }
  }

  // 3. Resolve sessions.
  const byslot = new Map<string, SavedSession>((await listSessions()).map(s => [s.slot, s]));
  const resolved = planned.filter(p => byslot.has(p.ref));
  const total = resolved.length;
  if (total === 0) throw new Error('Nothing to export — this folder has no saved sessions.');

  // 4. Stage dir — one shared jsdom #canvas means renders MUST stay sequential.
  const stage = await mkdtemp(join(tmpdir(), 'lolly-batch-'));
  const members: BatchMember[] = [];
  const usedByDir = new Map<string, Set<string>>(); // relDir → base names taken (dedup)
  const want = opts.format ?? 'svg';
  const dims = { unit: opts.unit ?? 'px', dpi: opts.dpi ?? 300 };
  let done = 0;

  try {
    // 5. Render each session sequentially into the stage tree.
    for (const { ref, relDir } of planned) {
      const session = byslot.get(ref);
      if (!session) {
        // A planned ref with no session (deleted between plan + resolve). Skipped, still
        // counted against `total`? No — total counts only resolved; report but don't tick.
        continue;
      }
      const label = session.label || session.toolId;
      // Dedup the base name within its directory.
      const set = usedByDir.get(relDir) ?? new Set<string>();
      usedByDir.set(relDir, set);
      let base = slug(session.label) || slug(session.toolId);
      if (set.has(base)) {
        let n = 2;
        while (set.has(`${base}-${String(n).padStart(2, '0')}`)) n++;
        base = `${base}-${String(n).padStart(2, '0')}`;
      }
      set.add(base);
      const relNoExt = relDir ? `${relDir}/${base}` : base;

      const member = await renderSessionTo(host, dom, session, relNoExt, stage, want, dims);
      members.push(member);
      done++;
      const prefix = member.ok ? (member.format === 'html' && want !== 'html' ? '⚠' : '✓') : '✗';
      opts.onProgress?.(done, total, `${prefix} ${member.zipPath}`);
    }

    // 6-8. Pack the staged files into one zip on disk.
    return packMembersToZip(stage, members, {
      zipName: `${slug(folder.name) || 'lolly-folder'}.zip`,
      folderName: folder.name,
      zipPassword: opts.zipPassword, zipTier: opts.zipTier, outDir: opts.outDir,
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Pack the staged member files (+ a lolly.txt manifest) into one zip and write it. The
 *  shared tail of every batch — folder export, a CSV batch, and a saved-session set. */
async function packMembersToZip(
  stage: string,
  members: BatchMember[],
  o: { zipName: string; folderName: string; zipPassword?: string; zipTier?: ZipTier; outDir?: string },
): Promise<ExportFolderResult> {
  // Only zip members whose staged file is actually on disk. A "render everything" must
  // never let a single session that reported success but produced no file (an odd fallback,
  // a browser-tier render that didn't land) crash the whole archive with an ENOENT.
  const okMembers = members.filter(m => m.ok && existsSync(join(stage, m.zipPath)));
  const manifest = manifestText(o.zipName, o.folderName, members);

  let zipBytes: Uint8Array;
  if (o.zipPassword) {
    const entries: ZipEntryInput[] = [];
    const add = (name: string, bytes: Uint8Array): void => {
      const store = STORE_EXT.has(extOf(name));
      entries.push({
        name,
        compressed: store ? bytes : deflateSync(bytes),
        method: store ? 0 : 8,
        crc32: crc32(bytes),
        uncompressedSize: bytes.length,
      });
    };
    for (const m of okMembers) add(m.zipPath, new Uint8Array(await readFile(join(stage, m.zipPath))));
    add('lolly.txt', strToU8(manifest));
    zipBytes = await buildEncryptedZip(entries, { tier: o.zipTier ?? 'standard', password: o.zipPassword });
  } else {
    const entries: Zippable = {};
    for (const m of okMembers) {
      const bytes = new Uint8Array(await readFile(join(stage, m.zipPath)));
      entries[m.zipPath] = [bytes, { level: STORE_EXT.has(extOf(m.zipPath)) ? 0 : 6 }];
    }
    entries['lolly.txt'] = [strToU8(manifest), { level: 6 }];
    zipBytes = zipSync(entries);
  }

  const zipPath = join(o.outDir ?? defaultExportDir(), o.zipName);
  await writeFile(zipPath, zipBytes);
  return { zipPath, count: okMembers.length, bytes: zipBytes.length, members };
}

/**
 * Render ONE session into `stage/<relNoExt>.<fmt>`, with the same html fallback as
 * ToolView.doExport. Never throws — a failure returns a skipped BatchMember so the batch
 * continues.
 */
async function renderSessionTo(
  host: HostV1,
  dom: JSDOM,
  session: SavedSession,
  relNoExt: string,
  stage: string,
  want: string,
  dims: { unit: string; dpi: number },
): Promise<BatchMember> {
  const label = session.label || session.toolId;
  try {
    const { runtime, manifest } = await mountTool(session.toolId, host, session.query);
    const avail = exportableFormats(manifest);
    const fmt = avail.includes(want) ? want : (avail[0] ?? 'html');
    const zipPath = `${relNoExt}.${fmt}`;
    try {
      const bytes = await exportToFile(runtime, dom, manifest, fmt, join(stage, zipPath), dims);
      if (!existsSync(join(stage, zipPath))) throw new Error('render produced no file');
      return { slot: session.slot, label, zipPath, format: fmt, bytes, ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      // svg/emf/eps need an <svg> the tool may not have; raster/pdf/capture need the
      // browser tier (Chromium / built web shell) that a given machine may not have set
      // up. For a BULK export, fall back to HTML (always renderable) so every member
      // still produces a file rather than failing — interactive doExport surfaces the
      // actionable "run install:browser" message instead.
      if (/<svg>|requires an|browser engine|install:browser|build:web|Chromium|web shell/i.test(msg) && fmt !== 'html') {
        const htmlPath = `${relNoExt}.html`;
        const bytes = await exportToFile(runtime, dom, manifest, 'html', join(stage, htmlPath), dims);
        return { slot: session.slot, label, zipPath: htmlPath, format: 'html', bytes, ok: true };
      }
      throw e;
    }
  } catch (e) {
    return { slot: session.slot, label, zipPath: `${relNoExt}.${want}`, format: want, bytes: 0, ok: false, reason: (e as Error).message };
  }
}

export interface BatchRunOpts {
  onProgress?: (done: number, total: number, label: string) => void;
  zipPassword?: string;
  zipTier?: ZipTier;
  outDir?: string;
  name?: string;          // zip base name (default 'batch' / 'selection')
  format?: string;        // for the session-set path (rows carry their own format)
  unit?: string;
  dpi?: number;
}

/**
 * CSV/data batch — render an array of BatchRow (engine parseBatchCsv output) to one zip.
 * The "TUI way" of a data-driven batch: each row is a tool + params + optional per-row
 * format/size, rendered through the SAME engine path as a single export and packed like a
 * folder export. Zip-to-Desktop is the TUI idiom (the CLI writes a directory instead).
 */
export async function exportBatchRows(
  host: HostV1, dom: JSDOM, rows: BatchRow[], opts: BatchRunOpts = {},
): Promise<ExportFolderResult> {
  if (!rows.length) throw new Error('No rows to render.');
  const stage = await mkdtemp(join(tmpdir(), 'lolly-batch-'));
  const members: BatchMember[] = [];
  const pad = Math.max(2, String(rows.length).length);
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const base = row.filename ? slug(row.filename.replace(/\.[^.]+$/, '')) : slug(row.toolId);
      const relNoExt = `${String(i + 1).padStart(pad, '0')}-${base || 'row'}`;
      const member = await renderRowTo(host, dom, row, relNoExt, stage);
      members.push(member);
      opts.onProgress?.(i + 1, rows.length, `${member.ok ? '✓' : '✗'} ${member.zipPath}`);
    }
    return packMembersToZip(stage, members, {
      zipName: `${slug(opts.name ?? 'batch') || 'batch'}.zip`,
      folderName: opts.name ?? 'CSV batch',
      zipPassword: opts.zipPassword, zipTier: opts.zipTier, outDir: opts.outDir,
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Render one CSV batch row (its params become the mount query; per-row format/size honoured). */
async function renderRowTo(
  host: HostV1, dom: JSDOM, row: BatchRow, relNoExt: string, stage: string,
): Promise<BatchMember> {
  const query = new URLSearchParams(row.params).toString();
  const want = row.format ?? 'svg';
  const dims = { width: row.width, height: row.height, unit: row.unit ?? 'px', dpi: row.dpi ?? 300 };
  try {
    const { runtime, manifest } = await mountTool(row.toolId, host, query);
    const avail = exportableFormats(manifest);
    const fmt = avail.includes(want) ? want : (avail[0] ?? 'html');
    const zipPath = `${relNoExt}.${fmt}`;
    try {
      const bytes = await exportToFile(runtime, dom, manifest, fmt, join(stage, zipPath), dims);
      return { slot: relNoExt, label: row.toolId, zipPath, format: fmt, bytes, ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      if (/<svg>|requires an|browser engine|install:browser|build:web|Chromium|web shell/i.test(msg) && fmt !== 'html') {
        const htmlPath = `${relNoExt}.html`;
        const bytes = await exportToFile(runtime, dom, manifest, 'html', join(stage, htmlPath), dims);
        return { slot: relNoExt, label: row.toolId, zipPath: htmlPath, format: 'html', bytes, ok: true };
      }
      throw e;
    }
  } catch (e) {
    return { slot: relNoExt, label: row.toolId, zipPath: `${relNoExt}.${want}`, format: want, bytes: 0, ok: false, reason: (e as Error).message };
  }
}

/**
 * Saved-session multiselect — render an ad-hoc set of ticked sessions (across folders)
 * to one zip. Same packaging as a folder export; the difference is the source is a
 * hand-picked list rather than a folder subtree.
 */
export async function exportSessions(
  host: HostV1, dom: JSDOM, sessions: SavedSession[], opts: BatchRunOpts = {},
): Promise<ExportFolderResult> {
  if (!sessions.length) throw new Error('Nothing selected to export.');
  const stage = await mkdtemp(join(tmpdir(), 'lolly-batch-'));
  const members: BatchMember[] = [];
  const used = new Set<string>();
  const dims = { unit: opts.unit ?? 'px', dpi: opts.dpi ?? 300 };
  try {
    let done = 0;
    for (const session of sessions) {
      let base = slug(session.label) || slug(session.toolId);
      if (used.has(base)) {
        let n = 2;
        while (used.has(`${base}-${String(n).padStart(2, '0')}`)) n++;
        base = `${base}-${String(n).padStart(2, '0')}`;
      }
      used.add(base);
      const member = await renderSessionTo(host, dom, session, base, stage, opts.format ?? 'svg', dims);
      members.push(member);
      done++;
      opts.onProgress?.(done, sessions.length, `${member.ok ? '✓' : '✗'} ${member.zipPath}`);
    }
    return packMembersToZip(stage, members, {
      zipName: `${slug(opts.name ?? 'selection') || 'selection'}.zip`,
      folderName: opts.name ?? 'Selected sessions',
      zipPassword: opts.zipPassword, zipTier: opts.zipTier, outDir: opts.outDir,
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
