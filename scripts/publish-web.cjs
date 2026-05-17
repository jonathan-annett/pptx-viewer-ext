// Publish the extension's built files + latest .vsix to a GitHub Pages repo,
// in a single atomic commit via the GitHub git data API. No clone required.
//
// Config (in package.json):
//   "webPublish": {
//     "repo":   "owner/repo",                       // required
//     "branch": "main",                             // default: "main"
//     "folder": "vscode-ext-dev/<extension-name>"   // required — where package.json + dist/ land
//                                                   // vsix lands at the PARENT of this folder
//   }
//
// What it uploads:
//   <folder>/package.json
//   <folder>/dist/extension.js
//   <folder>/dist/extension.js.map    (if present)
//   <vsixParent>/<name>-<version>.vsix
//
// Cleanup: deletes any *other* <name>-*.vsix sitting next to the new one
// (i.e. previous versions) so the parent folder doesn't accumulate cruft.
//
// Requires: `gh` CLI authenticated with `repo` scope. Auth is reused — no
// token handling here.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const cfg = pkg.webPublish;
if (!cfg || !cfg.repo || !cfg.folder) {
  console.error('package.json is missing webPublish.{repo, folder}');
  process.exit(1);
}
const REPO = cfg.repo;
const BRANCH = cfg.branch ?? 'main';
const FOLDER = stripTrailingSlash(cfg.folder);
const PARENT = path.posix.dirname(FOLDER); // for the .vsix
const NAME = pkg.name;
const VERSION = pkg.version;
const VSIX_NAME = `${NAME}-${VERSION}.vsix`;

// --- helpers --------------------------------------------------------------

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function api(args, body) {
  const opts = { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 };
  if (body !== undefined) {
    const out = execFileSync(
      'gh',
      ['api', ...args, '--input', '-'],
      { ...opts, input: JSON.stringify(body) },
    );
    return out.trim() ? JSON.parse(out) : null;
  }
  const out = execFileSync('gh', ['api', ...args], opts);
  return JSON.parse(out);
}

function apiSilent(args) {
  // Returns null on 404 (e.g. listing a non-existent directory) instead of throwing.
  try {
    return api(args);
  } catch (err) {
    const msg = String(err.stderr ?? err.message ?? '');
    if (/HTTP 404/i.test(msg) || /Not Found/i.test(msg)) return null;
    throw err;
  }
}

function mkBlob(localPath) {
  const content = fs.readFileSync(localPath).toString('base64');
  const blob = api(
    ['-X', 'POST', `repos/${REPO}/git/blobs`],
    { content, encoding: 'base64' },
  );
  console.log(`  blob ${blob.sha.slice(0, 7)}  <- ${localPath}`);
  return blob.sha;
}

// --- preflight ------------------------------------------------------------

const required = ['package.json', 'dist/extension.js', VSIX_NAME];
for (const f of required) {
  if (!fs.existsSync(f)) {
    console.error(`missing: ${f}`);
    console.error(`  run \`npm run compile-web && npm run package\` first`);
    process.exit(1);
  }
}
const hasMap = fs.existsSync('dist/extension.js.map');

// --- find old vsixes to delete -------------------------------------------

const parentListing = apiSilent([`repos/${REPO}/contents/${PARENT}?ref=${BRANCH}`]) ?? [];
const oldVsixes = parentListing
  .filter((e) => e.type === 'file' && e.name.startsWith(`${NAME}-`) && e.name.endsWith('.vsix') && e.name !== VSIX_NAME)
  .map((e) => e.path);
if (oldVsixes.length) {
  console.log(`will remove: ${oldVsixes.join(', ')}`);
}

// --- assemble commit ------------------------------------------------------

console.log(`target: ${REPO}@${BRANCH}`);
console.log(`folder: ${FOLDER}/`);
console.log(`vsix:   ${PARENT}/${VSIX_NAME}`);

const ref = api([`repos/${REPO}/git/ref/heads/${BRANCH}`]);
const head = ref.object.sha;
const baseCommit = api([`repos/${REPO}/git/commits/${head}`]);
const baseTree = baseCommit.tree.sha;
console.log(`base: ${head.slice(0, 7)} (tree ${baseTree.slice(0, 7)})`);

const additions = [
  { repoPath: `${FOLDER}/package.json`,        local: 'package.json' },
  { repoPath: `${FOLDER}/dist/extension.js`,   local: 'dist/extension.js' },
  ...(hasMap ? [{ repoPath: `${FOLDER}/dist/extension.js.map`, local: 'dist/extension.js.map' }] : []),
  { repoPath: `${PARENT}/${VSIX_NAME}`,        local: VSIX_NAME },
];

const tree = additions.map((a) => ({
  path: a.repoPath,
  mode: '100644',
  type: 'blob',
  sha: mkBlob(a.local),
}));
// Drop old vsix(es) by setting their tree entry SHA to null.
for (const p of oldVsixes) {
  tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
}

const newTree = api(
  ['-X', 'POST', `repos/${REPO}/git/trees`],
  { base_tree: baseTree, tree },
);
console.log(`new tree: ${newTree.sha.slice(0, 7)}`);

const newCommit = api(
  ['-X', 'POST', `repos/${REPO}/git/commits`],
  {
    message: `Publish ${NAME}@${VERSION} to ${FOLDER}/`,
    tree: newTree.sha,
    parents: [head],
  },
);
console.log(`new commit: ${newCommit.sha.slice(0, 7)}`);

const updated = api(
  ['-X', 'PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`],
  { sha: newCommit.sha },
);
console.log(`refs/heads/${BRANCH} -> ${updated.object.sha.slice(0, 7)}`);

// Best-effort URL hints (works for github.io repos)
const m = REPO.match(/^([^/]+)\/([^/]+)$/);
if (m && m[2].endsWith('.github.io')) {
  const base = `https://${m[2]}`;
  console.log('');
  console.log('public URLs (GitHub Pages may take a minute to refresh):');
  console.log(`  ${base}/${FOLDER}/package.json`);
  console.log(`  ${base}/${FOLDER}/dist/extension.js`);
  console.log(`  ${base}/${PARENT}/${VSIX_NAME}`);
}
