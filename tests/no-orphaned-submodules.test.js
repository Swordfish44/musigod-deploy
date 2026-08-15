'use strict';
// tests/no-orphaned-submodules.test.js
//
// Regression test for the orphaned musigod-packet-generator gitlink (mode 160000)
// that caused actions/checkout@v4 post-job to exit 128 in CI.
//
// Root cause: commit 3c15f28 ran `git add .` which swept up a nested git repo
// directory as a gitlink without ever running `git submodule add`. No .gitmodules
// entry was created, so git submodule status could not resolve it → exit 128.
//
// This test catches any future recurrence: a gitlink in the tree without a
// corresponding .gitmodules entry is always a bug.

const { execSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

console.log('=== no-orphaned-submodules.test.js ===');

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// 1. Collect all gitlink entries (mode 160000) currently in the index.
const gitlinks = run('git ls-files --stage')
  .split('\n')
  .filter(line => line.startsWith('160000'))
  .map(line => {
    // format: "160000 <sha> <stage>\t<path>"
    const parts = line.split('\t');
    return parts[1] || '';
  })
  .filter(Boolean);

// 2. Collect all paths declared in .gitmodules (if it exists).
const gitmodulesPath = path.join(__dirname, '..', '.gitmodules');
const declaredSubmodules = new Set();
if (fs.existsSync(gitmodulesPath)) {
  const content = fs.readFileSync(gitmodulesPath, 'utf8');
  for (const match of content.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
    declaredSubmodules.add(match[1].trim());
  }
}

// 3. Every gitlink must have a .gitmodules entry.
if (gitlinks.length === 0) {
  ok(true, 'no gitlink entries (mode 160000) in index — submodule table is clean');
} else {
  for (const link of gitlinks) {
    ok(
      declaredSubmodules.has(link),
      `gitlink '${link}' has a matching .gitmodules entry`
    );
  }
}

// 4. Specific regression: musigod-packet-generator must not be a gitlink.
ok(
  !gitlinks.includes('musigod-packet-generator'),
  'musigod-packet-generator is not registered as a gitlink (regression: 3c15f28)'
);

// 5. musigod-packet-generator must be in .gitignore.
const gitignorePath = path.join(__dirname, '..', '.gitignore');
const gitignoreContent = fs.existsSync(gitignorePath)
  ? fs.readFileSync(gitignorePath, 'utf8')
  : '';
ok(
  gitignoreContent.includes('musigod-packet-generator'),
  'musigod-packet-generator is listed in .gitignore'
);

// 6. git submodule status exits 0 (would exit 128 when an orphaned gitlink exists).
let submoduleStatusOk = false;
try {
  execSync('git submodule status', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  submoduleStatusOk = true;
} catch (e) {
  submoduleStatusOk = false;
}
ok(submoduleStatusOk, 'git submodule status exits 0 (no orphaned gitlinks)');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
