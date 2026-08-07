#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  EXAMPLE verify harness — copy into your repo and rewrite for your stack.
// ─────────────────────────────────────────────────────────────────────────────
//
//  You do NOT need this file. If one command tests your whole project, just set:
//
//      AGENT_LOOP_VERIFY=npm test
//
//  A harness only earns its place on a repo where running everything is too slow
//  to sit inside the verify timeout. Then you want to run only the suites the
//  diff can actually break. That is all this example does.
//
//  Wire it up with:
//      AGENT_LOOP_VERIFY=node /absolute/path/to/agent-loop-verify.mjs
//
//  CONTRACT — the only three things the dispatcher requires:
//    1. It runs with cwd = a detached checkout of the reviewed commit, in a
//       sandbox, NOT your working tree. Never write outside cwd.
//    2. Exit 0 = the commit may land. Any non-zero exit sends the task back to
//       `changes requested` with your output attached.
//    3. It gets NO arguments and no list of changed files. Derive what you need
//       from git, as below.
//
//  Gitignored dependencies (node_modules/, vendor/) do not exist in a fresh
//  checkout. Name them in AGENT_LOOP_VERIFY_SEED_DIRS and they are copied in
//  once, or every run fails on a missing dependency unrelated to the diff.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.env.AGENT_LOOP_BASE || 'main';

// Which suites exist, and which paths make each one relevant. Order matters:
// cheapest and most likely to fail first, so a broken commit is rejected fast.
const SUITES = [
  { name: 'lint',     when: /\.(js|ts|jsx|tsx)$/,        run: 'npm run lint' },
  { name: 'unit',     when: /^src\//,                    run: 'npm test' },
  { name: 'api',      when: /^(server|api)\//,           run: 'npm run test:api' },
  { name: 'frontend', when: /^(web|client|frontend)\//,  run: 'npm run test:web' },
];

function sh(cmd) {
  console.log(`\n$ ${cmd}`);
  return spawnSync(cmd, { shell: true, stdio: 'inherit', encoding: 'utf8' }).status ?? 1;
}

// The reviewed commit is checked out detached, so compare against the base branch
// to see what this task actually changed.
function changedFiles() {
  const r = spawnSync('git', ['diff', '--name-only', `origin/${BASE}...HEAD`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) {
    // Fail OPEN, not closed: if the range cannot be computed (shallow checkout,
    // missing remote ref) run everything rather than silently verifying nothing.
    console.log('verify: could not compute the changed-file set — running every suite');
    return null;
  }
  return r.stdout.trim().split('\n').map(f => f.replaceAll('\\', '/'));
}

const files = changedFiles();
const selected = files === null
  ? SUITES
  : SUITES.filter(s => files.some(f => s.when.test(f)));

if (!selected.length) {
  console.log('verify: nothing in this diff maps to a suite — nothing to prove, passing');
  process.exit(0);
}

console.log(`verify: running ${selected.map(s => s.name).join(', ')}`);

if (existsSync('package.json') && !existsSync('node_modules')) {
  // Only reachable when AGENT_LOOP_VERIFY_SEED_DIRS did not include node_modules.
  if (sh('npm ci --no-audit --no-fund') !== 0) process.exit(1);
}

for (const suite of selected) {
  const code = sh(suite.run);
  if (code !== 0) {
    console.error(`\nverify: ${suite.name} FAILED (exit ${code})`);
    process.exit(code);
  }
}

console.log('\nverify: all selected suites green');
process.exit(0);
