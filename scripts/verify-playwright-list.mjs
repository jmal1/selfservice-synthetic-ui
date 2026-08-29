#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  PUSHGATEWAY_URL: 'skip',
  SYNTHETIC_LIFECYCLE_ENABLED: 'false',
  SYNTHETIC_EXPECT_MAINTENANCE: 'false'
};

const command = process.platform === 'win32'
  ? 'cmd.exe'
  : '/bin/sh';
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npx playwright test --list']
  : ['-lc', 'npx playwright test --list'];

const result = spawnSync(command, args, {
  env,
  stdio: 'inherit',
  shell: false
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
