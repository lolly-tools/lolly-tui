// SPDX-License-Identifier: MPL-2.0
/**
 * Profile — your details, persisted on disk (store.ts). They pre-fill tools that
 * declare bindToProfile and, with "embed in exports" on, ride along in export
 * provenance. Edits save immediately.
 */
import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { verifyC2pa } from '@lolly/engine';
import { getProfile, setProfile, backupData, listSessions } from '../store.ts';
import { exportSessions } from '../batch-export.ts';
import { loadFavourites, loadHidden } from '../lib/asset-favourites.ts';
import { loadToolFavourites } from '../lib/tool-favourites.ts';
import type { NavTarget } from '../nav.ts';
import type { TuiBridge } from '../bridge.ts';
import { useTermSize } from '../hooks.ts';
import { theme } from '../theme.ts';
import { Tabs } from '../components/Tabs.tsx';
import { Panel } from '../components/Panel.tsx';
import { Footer } from '../components/Footer.tsx';
import { Progress } from '../components/Progress.tsx';

interface Prog { done: number; total: number; log: string[]; finished: boolean; note?: string }

interface Field { key: string; label: string; type: 'text' | 'bool' }
const FIELDS: Field[] = [
  { key: 'firstname', label: 'First name', type: 'text' },
  { key: 'lastname', label: 'Last name', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'company', label: 'Company', type: 'text' },
  { key: 'useDetails', label: 'Embed my details in exports', type: 'bool' },
];

export function Profile({ bridge, onNav, onQuit }: { bridge: TuiBridge; onNav: (t: NavTarget) => void; onQuit: () => void }) {
  const { cols, rows } = useTermSize();
  const [profile, setP] = useState<Record<string, unknown> | null>(null);
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [verifying, setVerifying] = useState(false);   // 'v' — check a file's Content Credentials
  const [vdraft, setVdraft] = useState('');
  const [prog, setProg] = useState<Prog | null>(null); // 'b' — back up + render every project (live)

  useEffect(() => { void getProfile().then(setP); }, []);

  function persist(next: Record<string, unknown>): void {
    setP(next);
    setProfile(next).then(() => setStatus('✓ Saved')).catch(e => setStatus('Save failed: ' + (e as Error).message));
  }

  useInput((input, key) => {
    if (!profile) return;
    // While rendering everything, the Progress panel owns the screen — only dismiss it once done.
    if (prog) { if (prog.finished && (key.return || key.escape || input.length > 0)) setProg(null); return; }
    if (editing) { if (key.escape) setEditing(false); return; }
    if (verifying) { if (key.escape) setVerifying(false); return; }
    if (input === '1') return onNav('tools');
    if (input === '2') return onNav('projects');
    if (input === '4') return onNav('catalog');
    if (input === 'q') return onQuit();
    if (input === 'b') { renderEverything(); return; }
    if (input === 'v') { setVdraft(''); setStatus(''); setVerifying(true); return; }
    if (key.upArrow || input === 'k') { setSel(s => Math.max(0, s - 1)); return; }
    if (key.downArrow || input === 'j') { setSel(s => Math.min(FIELDS.length - 1, s + 1)); return; }
    const f = FIELDS[sel];
    if (!f) return;
    if (f.type === 'bool' && (input === ' ' || key.return)) { persist({ ...profile, [f.key]: !profile[f.key] }); return; }
    if ((key.return || input === 'e') && f.type === 'text') { setDraft(String(profile[f.key] ?? '')); setEditing(true); }
  });

  function commit(raw: string): void {
    setEditing(false);
    const f = FIELDS[sel];
    if (f && profile) persist({ ...profile, [f.key]: raw });
  }
  // Back up my data AND render everything: the portable JSON backup (quick), then a
  // rendered zip of EVERY saved session to its output file — the terminal twin of the web
  // "Export my data & render everything" button. Heavy but explicit; a live Progress panel
  // shows each render as it lands. (Node renders svg/text + html fallback; raster/pdf/video
  // go through the bundled web shell where available — see engine-render.)
  function renderEverything(): void {
    setStatus('');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    void (async () => {
      const sessions = await listSessions();
      if (!sessions.length) { setStatus('No saved projects to render yet — make something first.'); return; }
      setProg({ done: 0, total: sessions.length, log: ['Backing up your data…'], finished: false });
      let backupNote = '';
      try { const r = await backupData(stamp); backupNote = `data backup → ${r.path}`; } catch (e) { backupNote = 'data backup failed: ' + (e as Error).message; }
      setProg(p => ({ done: 0, total: sessions.length, log: [...(p?.log ?? []), `✓ ${backupNote}`, 'Rendering every project…'], finished: false }));
      const onProgress = (done: number, total: number, label: string): void =>
        setProg(p => ({ done, total, log: [...(p?.log ?? []), label], finished: false }));
      exportSessions(bridge.host, bridge.dom, sessions, { name: 'Lolly', onProgress })
        .then(res => setProg(p => ({
          done: res.count, total: p?.total || res.count, log: p?.log ?? [], finished: true,
          note: `✓ Rendered ${res.count} project${res.count === 1 ? '' : 's'} → ${basename(res.zipPath)} in ${dirname(res.zipPath)}`,
        })))
        .catch(e => setProg(p => ({ done: p?.done ?? 0, total: p?.total ?? 0, log: p?.log ?? [], finished: true, note: `✗ ${(e as Error).message}` })));
    })();
  }
  // Verify a file's Content Credentials (the web /valid view) — same engine verifier the
  // /valid page + `lolly validate` use.
  function doVerify(path: string): void {
    setVerifying(false);
    const p = path.trim(); if (!p) return;
    setStatus('Verifying…');
    (async () => {
      try {
        const abs = p.startsWith('~') && (p.length === 1 || p[1] === '/') ? homedir() + p.slice(1) : p;
        const bytes = new Uint8Array(await readFile(abs));
        const r = await verifyC2pa(bytes) as { found?: boolean; state?: string; trusted?: boolean; madeWithLolly?: boolean };
        if (!r.found) { setStatus(`No Content Credentials found in ${p}.`); return; }
        setStatus(`✓ C2PA ${r.state}${r.madeWithLolly ? ' · made with Lolly' : ''} · ${r.trusted ? 'trusted' : 'untrusted cert'}`);
      } catch (e) { setStatus('Verify failed: ' + (e as Error).message); }
    })();
  }

  const favTools = profile ? loadToolFavourites(profile).size : 0;
  const favAssets = profile ? loadFavourites(profile).size : 0;
  const hidAssets = profile ? loadHidden(profile).size : 0;

  if (prog) {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Tabs active="profile" />
        <Progress
          title="Back up + render everything"
          done={prog.done} total={prog.total} log={prog.log}
          width={cols} height={Math.max(6, rows - 3)}
          active finished={prog.finished} note={prog.note}
        />
        <Footer shortcuts={prog.finished ? [{ key: '⏎', label: 'close' }] : [{ key: '…', label: 'rendering every project — keep the terminal open' }]} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Tabs active="profile" />
      <Box paddingX={1}>
        <Text color={theme.dim} wrap="truncate-end">Pre-fills tools (bindToProfile); optionally embedded in export provenance.</Text>
      </Box>
      <Box paddingX={1}>
        {verifying
          ? (<><Text color={theme.accentName}>Verify file (C2PA): </Text><TextInput value={vdraft} onChange={setVdraft} onSubmit={doVerify} /></>)
          : (
            <Text color={theme.dim} wrap="truncate-end">
              ★ {favTools} tool{favTools === 1 ? '' : 's'}  ·  ★ {favAssets} asset{favAssets === 1 ? '' : 's'}{hidAssets ? `  ·  ${hidAssets} hidden` : ''}  ·  b back up + render all · v verify
            </Text>
          )}
      </Box>
      <Panel title="Your details" width={cols} height={Math.max(FIELDS.length + 2, rows - 6)} active>
        {profile === null ? <Text color={theme.dim}>Loading…</Text> : FIELDS.map((f, i) => {
          const active = i === sel;
          const val = profile[f.key];
          return (
            <Box key={f.key}>
              <Box width={32}><Text color={active ? theme.accentName : undefined} wrap="truncate-end">{active ? '▸ ' : '  '}{f.label}</Text></Box>
              {active && editing && f.type === 'text'
                ? <Box><Text color={theme.accentName}>› </Text><TextInput value={draft} onChange={setDraft} onSubmit={commit} /></Box>
                : <Text color={active ? theme.fg : theme.dim} wrap="truncate-end">{f.type === 'bool' ? (val ? '[x] on' : '[ ] off') : (String(val ?? '') || '—')}</Text>}
            </Box>
          );
        })}
      </Panel>
      <Footer
        note={status || undefined}
        shortcuts={[
          { key: 'j/k', label: 'field' },
          { key: '⏎/e', label: 'edit' },
          { key: 'spc', label: 'toggle' },
          { key: 'b', label: 'back up + render' },
          { key: 'v', label: 'verify' },
          { key: '1/2/4', label: 'tools/proj/catalog' },
          { key: 'q', label: 'quit' },
        ]}
      />
    </Box>
  );
}
