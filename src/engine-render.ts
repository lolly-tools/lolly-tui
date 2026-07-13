// SPDX-License-Identifier: MPL-2.0
/**
 * Engine glue — the SAME render path the CLI/web use, driven interactively.
 * mountTool → createRuntime; renderSvg turns the current state into an SVG string
 * (for the terminal preview); exportToFile writes a real file via the Node bridge.
 */
import { loadTool, createRuntime, parseUrlState, serializeUrlState, embedC2pa, C2PA_FORMATS } from '@lolly/engine';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
// The DOM-free/raster format split + the resvg fast path + the export C2PA payload,
// shared with the CLI (one implementation, no drift).
import { NODE_FORMATS, pxDims, rasterizeSvgToPng } from '@lolly-tools/node-shell/raster';
import { buildExportC2paOpts } from '@lolly-tools/node-shell/c2pa-opts';
import type { RenderDims } from '@lolly-tools/node-shell/webshell-render';
import { toolFetchFile } from './catalog.ts';
import { getProfile } from './store.ts';
import type { HostV1, Profile } from '../../../engine/src/bridge/host-v1.ts';
import type { JSDOM } from 'jsdom';

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
export type Manifest = Awaited<ReturnType<typeof loadTool>>['manifest'];

/** Mount a tool, optionally seeded from a saved session's URL-state `query`. */
export async function mountTool(
  toolId: string, host: HostV1, query = '',
): Promise<{ runtime: Runtime; manifest: Manifest }> {
  const tool = await loadTool(toolId, toolFetchFile());
  const values = query ? parseUrlState(query, tool.manifest).values : {};
  const runtime = await createRuntime(tool, host, values as Parameters<typeof createRuntime>[2]);
  return { runtime, manifest: tool.manifest };
}

/** The current state as a URL query — what a saved session stores + reopens from. */
export function currentQuery(runtime: Runtime): string {
  return serializeUrlState(runtime.getModel());
}

export function exportableFormats(manifest: Manifest): string[] {
  // Every declared format is now offerable: engine-native ones render DOM-free, the rest
  // via the scoped Chromium (a clear "run npm run install:browser / build:web" error
  // surfaces at export time if it isn't set up). `html` is appended as the universal
  // fallback so even a template with no <svg> and no browser can still write a file.
  const declared = ((manifest as { render?: { formats?: string[] } }).render?.formats ?? [])
    .map(f => f.toLowerCase());
  const ok = [...new Set(declared)];
  if (!ok.includes('html')) ok.push('html');
  return ok;
}

/** True when the tool captures a live URL (url-shot) — routed straight to Chromium. */
export function isCaptureTool(manifest: Manifest): boolean {
  return ((manifest as { capabilities?: string[] }).capabilities ?? []).includes('capture');
}

/** True when the tool is a file-in/file-out transform utility (strip-data, compress-pdf)
 *  — its output is a FILE via the exportFile hook, not a render. */
export function isTransform(manifest: Manifest): boolean {
  return Boolean((manifest as { hooks?: { exportFile?: unknown } }).hooks?.exportFile);
}

function canvasOf(dom: JSDOM): HTMLElement {
  const c = dom.window.document.getElementById('canvas');
  if (!c) throw new Error('render canvas missing');
  return c;
}

/**
 * Render the runtime's CURRENT state to an SVG string, or null when this tool can't
 * produce SVG in a pure-Node shell (HTML-layout tools need a browser engine). Used
 * for the terminal image preview — resvg rasterises the returned SVG.
 */
export async function renderSvg(runtime: Runtime, dom: JSDOM): Promise<string | null> {
  try {
    const canvas = canvasOf(dom);
    canvas.innerHTML = runtime.getHydrated();
    const blob = await runtime.export(canvas, 'svg', {});
    return await blob.text();
  } catch {
    return null;
  }
}

/** Output size options for an export (mirrors the web/CLI: width/height are values in
 *  `unit`; a physical unit qualifies them so the engine converts per format). Extends
 *  the shared render dims (incl. the `password` PDF-lock param) with the TUI's
 *  Content-Credentials window. */
export interface ExportDims extends RenderDims { c2paDays?: number }

/**
 * Export the current state to `outPath` in `format`, honouring optional output
 * dimensions. Supports whatever the Node bridge produces (text/data + svg/emf/eps,
 * plus transform-hook utilities); raster/pdf throw a clear message (they need a browser
 * engine — the desktop app). Returns the number of bytes written.
 */
export async function exportToFile(
  runtime: Runtime, dom: JSDOM, manifest: Manifest, format: string, outPath: string, dims: ExportDims = {},
): Promise<number> {
  await mkdir(dirname(outPath), { recursive: true });   // ensure the target folder exists
  const fmt = format.toLowerCase();
  const transform = isTransform(manifest);
  const write = async (bytes: Uint8Array): Promise<number> => {
    // Optionally stamp Content Credentials (C2PA) as the LAST byte operation — same rule
    // as the CLI/web. NEVER on transform utilities (strip-data's whole job is to REMOVE
    // metadata). Ephemeral on-device cert; a clean warn-and-continue on any failure.
    let out = bytes;
    if (dims.c2paDays && !transform && C2PA_FORMATS.includes(fmt)) {
      try {
        // Match the web/CLI tools.lolly.export enrichment: context + date + output
        // size + the scalar-input digest, so a TUI-made asset inspects as richly.
        // buildExportC2paOpts (shared with the CLI) also attaches the profile author
        // under the `useDetails` opt-in — same gate as every other shell.
        const profile = (await getProfile()) as Profile;
        out = await embedC2pa(bytes, fmt, buildExportC2paOpts({
          surface: 'tui',
          manifest: manifest as { id: string; name?: string },
          model: runtime.getModel(),
          format: fmt, dims, days: dims.c2paDays, profile,
        }));
      } catch { /* non-fatal — write the unstamped bytes */ }
    }
    const buf = Buffer.from(out);
    await writeFile(outPath, buf);
    return buf.length;
  };

  // 1. On-device transform utilities (strip-data, compress-pdf) produce bytes via the
  //    exportFile hook, not a render.
  if (transform) {
    const { bytes } = await runtime.exportFile();
    return write(bytes as Uint8Array);
  }

  // 2. Capture tools (url-shot): drive Chromium straight at the target URL. Produces
  //    png/jpg/pdf(vector)/svg directly — never touches the DOM export path.
  if (isCaptureTool(manifest)) {
    const { captureUrl, captureParamsFrom } = await import('./url-capture.ts');
    const params = captureParamsFrom(runtime.getModel() as Array<{ id: string; value: unknown }>);
    const cdims = pxDims(dims, manifest as { render?: { width?: number; height?: number } });
    const { bytes } = await captureUrl(params, fmt, cdims);
    return write(bytes);
  }

  // 3. Engine-native formats (svg/emf/eps + text/data): the DOM-free path.
  if (NODE_FORMATS.includes(fmt)) {
    const canvas = canvasOf(dom);
    canvas.innerHTML = runtime.getHydrated();
    // Qualify a physical unit onto the value (e.g. 210 + mm → "210mm"); px passes as a
    // number. Blank → the tool's native size. Mirrors shells/cli/src/run.ts.
    const u = dims.unit || 'px';
    const qual = (v: number | undefined): string | number | undefined =>
      (typeof v === 'number' && v > 0 ? (u !== 'px' ? `${v}${u}` : v) : undefined);
    const opts: { width?: string | number; height?: string | number; dpi?: number } = { width: qual(dims.width), height: qual(dims.height) };
    if (u !== 'px' && dims.dpi) opts.dpi = dims.dpi;
    const blob = await runtime.export(canvas, fmt, opts);
    return write(new Uint8Array(await blob.arrayBuffer()));
  }

  // 3b. PNG from an SVG-native tool: rasterise the engine's own SVG via resvg — no
  //     browser and no built web shell needed (the fast, always-available raster path,
  //     mirroring the MCP server's Tier A+resvg). resvg emits PNG only; jpg/webp/pdf
  //     fall through to the web-shell tier below.
  if (fmt === 'png') {
    const svg = await renderSvg(runtime, dom);
    if (svg) {
      const { width, height } = pxDims(dims, manifest as { render?: { width?: number; height?: number } });
      const png = await rasterizeSvgToPng(svg, width, height);
      return write(png);
    }
  }

  // 4. Everything else (jpg/webp/pdf/video, and HTML-layout raster): drive the built web
  //    shell in Chromium so the bytes are identical to a web/desktop Download.
  const { renderViaWebShell } = await import('@lolly-tools/node-shell/webshell-render');
  const id = (manifest as { id: string }).id;
  const { bytes } = await renderViaWebShell(id, currentQuery(runtime), fmt, dims);
  return write(bytes);
}
