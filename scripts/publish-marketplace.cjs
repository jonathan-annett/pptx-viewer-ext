// Publish the extension to the VS Code Marketplace using a PAT from .pat.env.
//
// The PAT is read directly into the spawned vsce process's environment; it
// never crosses this script's stdout/stderr. Agents (and humans) should
// publish via `npm run publish:marketplace` rather than reading .pat.env
// themselves — tool output goes into Claude Code session transcripts, and
// any stdout-producing command on .pat.env (cat / head / awk / sed / grep)
// is a leak risk. See CLAUDE.md → "Secrets" for the rule.
//
// Usage:
//   npm run publish:marketplace              # publish current package.json version
//   npm run publish:marketplace -- patch     # bump patch, then publish (vsce does the bump)
//   npm run publish:marketplace -- minor     # bump minor, then publish
//
// Pre-flight (caller's responsibility before invoking):
//   - CHANGELOG.md [Unreleased] rolled into a dated [<version>] section
//   - tests + bundle green
//   - .vsix verified locally via `npm run package`

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PAT_FILE = '.pat.env';
const VSCE_REL = path.join('node_modules', '@vscode', 'vsce', 'vsce');

function bail(msg) {
  console.error(`publish-marketplace: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(PAT_FILE)) {
  bail(
    `${PAT_FILE} not found. Create it with an Azure DevOps PAT scoped to ` +
      `Marketplace > Manage. The file should contain the token on a single line.`
  );
}

if (!fs.existsSync(VSCE_REL)) {
  bail(`${VSCE_REL} not found. Run \`npm install\` first.`);
}

const pat = fs.readFileSync(PAT_FILE, 'utf8').trim();
if (!pat) {
  bail(`${PAT_FILE} is empty.`);
}

// Forward any extra CLI args (e.g. `-- patch` to let vsce bump the version
// before publishing, or `--pre-release` to flag as a Marketplace pre-release).
const forwardArgs = process.argv.slice(2);

const args = [
  '--require',
  './scripts/fix-cpus.cjs',
  VSCE_REL,
  'publish',
  '--allow-missing-repository',
  ...forwardArgs,
];

const result = spawnSync('node', args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    VSCE_PAT: pat,
  },
});

if (result.error) {
  bail(`failed to spawn vsce: ${result.error.message}`);
}

process.exit(result.status ?? 1);
