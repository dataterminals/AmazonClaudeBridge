#!/usr/bin/env node
'use strict';
/**
 * skill-drift.js — fail when the repo skill and the plugin skill fall out of step.
 *
 *   node bin/skill-drift.js --check    # CI / pre-commit: nonzero if they have drifted
 *   node bin/skill-drift.js --diff     # what changed in the repo skill since last reconcile
 *   node bin/skill-drift.js --accept   # re-baseline, after porting the change across
 *
 * WHY. There are two skill files and they are DELIBERATELY different (see CLAUDE.md). That is
 * fine right up until one of them gets a fix the other doesn't, at which point the plugin keeps
 * confidently telling a live session something the repo learned was false months ago. That is
 * exactly how the review-filter guidance survived past its expiry, and it was found by a session
 * getting blocked rather than by anything here.
 *
 * Same idea as `bin/vendor.js --check`: a copy that can silently drift is worse than no copy.
 * The difference is that vendor.js can regenerate its output, and this cannot — the plugin
 * variant is hand-adapted, so drift has to be reconciled by a human deciding what carries over.
 * This tool only tells you WHEN, and shows you WHAT; you decide.
 *
 * PRIVACY. The plugin variant carries the operator's real machine names and personal framing.
 * This repo is public. So `plugin/` is gitignored and this baseline records only a HASH of the
 * plugin file — never its content. The repo skill is already public and sanitised, so the
 * baseline may reference it by commit freely.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPO_SKILL = path.join(ROOT, '.claude', 'skills', 'amazon-shopping', 'SKILL.md');
const PLUGIN_SKILL = path.join(ROOT, 'plugin', 'skills', 'amazon-shopping', 'SKILL.md');
const BASELINE = path.join(ROOT, 'skill-sync.json');

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readOr = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

function main() {
  const mode = process.argv.find((a) => /^--(check|diff|accept)$/.test(a)) || '--check';

  const repoText = readOr(REPO_SKILL);
  if (repoText === null) { console.error('missing ' + rel(REPO_SKILL)); process.exit(1); }

  const pluginText = readOr(PLUGIN_SKILL);
  if (pluginText === null) {
    // Expected on a fresh clone, in CI, and for anyone who is not the operator. The plugin
    // variant is personal and deliberately not committed, so its absence is not a failure.
    console.log('no ' + rel(PLUGIN_SKILL) + ' present — nothing to compare, skipping.');
    console.log('(That is normal outside the operator\'s machine. See CLAUDE.md.)');
    process.exit(0);
  }

  const baseline = JSON.parse(readOr(BASELINE) || 'null') || {};
  const now = {
    repoHash: sha256(repoText),
    pluginHash: sha256(pluginText),
    repoCommit: git(['rev-parse', 'HEAD']),
  };

  if (mode === '--accept') {
    fs.writeFileSync(BASELINE, JSON.stringify({
      note: 'Baseline for bin/skill-drift.js. Hashes only — the plugin skill is personal and is '
          + 'never stored or committed here. Run `node bin/skill-drift.js --accept` after porting '
          + 'a change from one skill to the other.',
      repoSkill: rel(REPO_SKILL),
      pluginSkill: rel(PLUGIN_SKILL) + ' (gitignored, local only)',
      repoHash: now.repoHash,
      pluginHash: now.pluginHash,
      repoCommit: now.repoCommit,
    }, null, 2) + '\n', 'utf8');
    console.log('Re-baselined. Both skills recorded as reconciled at ' + (now.repoCommit || 'HEAD').slice(0, 7) + '.');
    return;
  }

  if (!baseline.repoHash) {
    console.error('No baseline yet. Reconcile the two skills, then run:  node bin/skill-drift.js --accept');
    process.exit(1);
  }

  const repoChanged = baseline.repoHash !== now.repoHash;
  const pluginChanged = baseline.pluginHash !== now.pluginHash;

  if (mode === '--diff') {
    if (!repoChanged) { console.log('Repo skill unchanged since baseline — nothing to port.'); return; }
    const since = baseline.repoCommit;
    const d = since && git(['diff', since, '--', rel(REPO_SKILL)]);
    if (d) { console.log('Changes to port into ' + rel(PLUGIN_SKILL) + ':\n'); console.log(d); }
    else console.log('Repo skill changed but no diff available (uncommitted, or baseline commit is gone).');
    return;
  }

  // --check
  if (!repoChanged && !pluginChanged) { console.log('skills are in step.'); return; }

  if (repoChanged && !pluginChanged) {
    console.error('DRIFT: ' + rel(REPO_SKILL) + ' changed and ' + rel(PLUGIN_SKILL) + ' did not.');
    console.error('  The plugin is now serving guidance the repo has moved past.');
    console.error('  See what to carry over:  node bin/skill-drift.js --diff');
    console.error('  Then port it, and:       node bin/skill-drift.js --accept');
    process.exit(1);
  }
  if (pluginChanged && !repoChanged) {
    console.error('DRIFT: ' + rel(PLUGIN_SKILL) + ' changed and ' + rel(REPO_SKILL) + ' did not.');
    console.error('  If that change is generic, it belongs in the repo too. If it is personal');
    console.error('  (machine names, direct address, bundled paths), it correctly stays put —');
    console.error('  in which case just re-baseline:  node bin/skill-drift.js --accept');
    process.exit(1);
  }
  console.log('both skills changed since baseline — assuming a deliberate reconcile.');
  console.log('confirm with:  node bin/skill-drift.js --accept');
}

if (require.main === module) main();

module.exports = { REPO_SKILL, PLUGIN_SKILL, BASELINE, sha256 };
