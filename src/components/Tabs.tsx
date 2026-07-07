// SPDX-License-Identifier: MPL-2.0
// Top navigation, mirroring the web shell's Tools | Projects | Catalog toggle. Number
// keys 1/2/3 switch sections (handled by each top-level view so it can honour its own
// editing/search state). Shows the active section highlighted.
import { Box, Text } from 'ink';
import { theme } from '../theme.ts';
import type { NavTarget } from '../nav.ts';

const TABS: Array<{ key: string; label: string; id: NavTarget }> = [
  { key: '1', label: 'Tools', id: 'tools' },
  { key: '2', label: 'Projects', id: 'projects' },
  { key: '3', label: 'Profile', id: 'profile' },
  { key: '4', label: 'Catalog', id: 'catalog' },
];

export function Tabs({ active }: { active: NavTarget }) {
  return (
    <Box paddingX={1}>
      <Text bold color={theme.accentName}>Lolly  </Text>
      {TABS.map(t => (
        <Text key={t.id}>
          <Text color={theme.dim}>{t.key} </Text>
          <Text bold={active === t.id} color={active === t.id ? theme.accentName : undefined}>{t.label}</Text>
          <Text color={theme.dim}>{'    '}</Text>
        </Text>
      ))}
    </Box>
  );
}
