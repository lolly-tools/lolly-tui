// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog access for the TUI — reads the same on-disk registry the CLI does
 * (`catalog/tools/index.json`) and provides the tool-file fetcher `loadTool`
 * needs. No engine coupling: this is pure Node fs, mirroring shells/cli.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A denormalised tool row as the generated catalog index carries it. */
export interface ToolEntry {
  id: string;
  name: string;
  description?: string;
  status?: string;
  category?: string;
  icon?: string;
  formats?: string[];
  capabilities?: string[];
  width?: number;
  height?: number;
  unit?: string;
  exportable?: boolean;
}

/** Repo root holding catalog/ — three levels up from shells/tui/src, or LOLLY_ROOT,
 *  or cwd (mirrors the CLI's resolveRepoRoot so a bundled run still finds it). */
export function repoRoot(): string {
  const marker = (r: string): boolean => existsSync(join(r, 'catalog', 'tools', 'index.json'));
  if (process.env.LOLLY_ROOT && marker(process.env.LOLLY_ROOT)) return process.env.LOLLY_ROOT;
  const rel = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (marker(rel)) return rel;
  if (marker(process.cwd())) return process.cwd();
  return rel;
}

/** All tools from the generated registry, in catalog order. */
export async function loadTools(): Promise<ToolEntry[]> {
  const p = join(repoRoot(), 'catalog', 'tools', 'index.json');
  const idx = JSON.parse(await readFile(p, 'utf8')) as { tools?: ToolEntry[] };
  return idx.tools ?? [];
}

/** The `fetchFile` the engine's `loadTool` calls to read a tool's files from disk. */
export function toolFetchFile(): (path: string) => Promise<string> {
  const root = repoRoot();
  return (path: string) => readFile(join(root, 'tools', path), 'utf8');
}

/** One catalog asset row as the generated asset registry carries it. */
export interface AssetRow {
  id: string;
  name: string;
  description?: string;
  type?: string;                 // vector | raster | lottie | audio | palette | tokens
  tier?: string;
  tags?: string[];
  formats?: Array<{ format: string; url: string; size?: number }>;
}

/** All catalog assets, in registry order (mirrors the web catalog view's source). */
export async function loadAssets(): Promise<AssetRow[]> {
  const p = join(repoRoot(), 'catalog', 'assets', 'index.json');
  const idx = JSON.parse(await readFile(p, 'utf8')) as { assets?: AssetRow[] };
  return idx.assets ?? [];
}
