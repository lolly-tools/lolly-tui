// SPDX-License-Identifier: MPL-2.0
/**
 * The TUI's export panel must open with Content Credentials ON, reading the engine's
 * one policy rather than a default of its own.
 *
 * This is a SOURCE scan, not a behaviour test, because the panel lives in a .tsx view
 * and this suite runs under Node type-stripping, which does not transform JSX (see
 * tests/README.md). What it pins is the thing that actually regressed: the panel used
 * to seed `c2paIdx` to 0 unconditionally, so "nobody said" resolved to OFF and the TUI
 * was the only surface exporting unattributed by default. The policy itself
 * (render.c2pa:false and privacy:'on-device' opting a tool out) is covered against the
 * real implementation in tests/cli-ga-contract.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./views/ToolView.tsx', import.meta.url)), 'utf8');

test('the export panel resolves its C2PA default from the engine policy', () => {
  assert.match(SRC, /import \{[^}]*\bc2paDefaultOn\b[^}]*\} from '@lolly\/engine'/,
    'the shared policy must be imported, never re-derived: three surfaces reading one function is what keeps them from drifting');
  assert.match(SRC, /c2paDefaultOn\(manifest\)/,
    'c2paIndexFromSetting must consult the policy for the absent case');
});

test('an absent ?c2pa= is the policy case, not an off case', () => {
  // The regression shape: `if (!c || !c.on) return 0` collapsed "nobody said" and
  // "explicitly off" into the same answer. They must stay separate branches.
  const fn = SRC.slice(SRC.indexOf('function c2paIndexFromSetting'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.doesNotMatch(body, /if \(!c \|\| !c\.on\) return 0/,
    'absent and explicitly-off must not share a branch');
  assert.match(body, /if \(!c\)/, 'the absent case is handled on its own');
});

test('the panel is seeded with the manifest, so the policy can see the opt-outs', () => {
  assert.match(SRC, /c2paIndexFromSetting\(rv\.c2pa, m\.manifest[^)]*\)/,
    'without the manifest argument the policy cannot honour render.c2pa:false or privacy:on-device');
});
