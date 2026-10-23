const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installLocal } = require('../scripts/install-local.cjs');

const id = 'local-tools.explorer-image';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-image-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'source');
  const extensions = path.join(root, 'extensions');
  const manifest = { publisher: 'local-tools', name: 'explorer-image', version: '0.1.1', main: './out/extension.js' };
  await fs.mkdir(path.join(project, 'out'), { recursive: true });
  await fs.mkdir(path.join(project, 'media'));
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(project, 'README.md'), 'Readme');
  await fs.writeFile(path.join(project, 'LICENSE'), 'MIT');
  await fs.writeFile(path.join(project, 'out', 'extension.js'), 'exports.activate = () => {};');
  await fs.writeFile(path.join(project, 'out', 'extension.js.map'), '{}');
  await fs.writeFile(path.join(project, 'media', 'view.js'), 'console.log("image");');
  await fs.mkdir(path.join(project, 'node_modules'));
  await fs.writeFile(path.join(project, '.env'), 'PRIVATE=true');
  return { root, project, extensions, manifest, target: path.join(extensions, id) };
}

test('local install copies only runtime files and works with spaces in the destination', async t => {
  const { root, project } = await fixture(t);
  const extensions = path.join(root, 'VS Code', 'my extensions');
  const installed = await installLocal(project, extensions);
  assert.equal(installed.id, id);
  assert.deepEqual((await fs.readdir(installed.target)).sort(), ['LICENSE', 'README.md', 'media', 'out', 'package.json']);
  assert.deepEqual(await fs.readdir(path.join(installed.target, 'out')), ['extension.js']);
  assert.equal(await fs.readFile(path.join(installed.target, 'media', 'view.js'), 'utf8'), 'console.log("image");');
  assert.equal(require(path.join(installed.target, 'out', 'extension.js')).activate instanceof Function, true);
  assert.deepEqual(await fs.readdir(extensions), [id]);
});

test('reinstall replaces the whole payload in the same folder when the version changes', async t => {
  const { project, extensions, manifest, target } = await fixture(t);
  await installLocal(project, extensions);
  await fs.writeFile(path.join(target, 'out', 'removed.js'), 'obsolete');
  manifest.version = '0.2.0';
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(project, 'out', 'extension.js'), 'exports.activate = () => "updated";');
  const installed = await installLocal(project, extensions);
  assert.equal(installed.target, target);
  assert.equal(installed.version, '0.2.0');
  assert.match(await fs.readFile(path.join(target, 'out', 'extension.js'), 'utf8'), /updated/);
  assert.deepEqual(await fs.readdir(path.join(target, 'out')), ['extension.js']);
  assert.deepEqual(await fs.readdir(extensions), [id]);
});

test('a missing compiled entry leaves the previous installation intact and cleans staging', async t => {
  const { project, extensions, target } = await fixture(t);
  await installLocal(project, extensions);
  const previous = await fs.readFile(path.join(target, 'out', 'extension.js'), 'utf8');
  await fs.rm(path.join(project, 'out', 'extension.js'));
  await assert.rejects(installLocal(project, extensions), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(target, 'out', 'extension.js'), 'utf8'), previous);
  assert.deepEqual(await fs.readdir(extensions), [id]);
});

test('an active VSIX installation must be uninstalled; obsolete versions can coexist', async t => {
  const { project, extensions, manifest, target } = await fixture(t);
  const oldName = `${id}-0.1.0`;
  const old = path.join(extensions, oldName);
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, 'package.json'), JSON.stringify({ ...manifest, version: '0.1.0' }));
  await assert.rejects(installLocal(project, extensions), /autre installation.*Désinstallez/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const obsolete = JSON.stringify({ [oldName]: true, 'other.extension-1.0.0': true });
  await fs.writeFile(path.join(extensions, '.obsolete'), obsolete);
  await installLocal(project, extensions);
  assert.equal(await fs.readFile(path.join(extensions, '.obsolete'), 'utf8'), obsolete);
  assert.equal((await fs.stat(old)).isDirectory(), true);
});

test('refuses to replace a folder belonging to another extension', async t => {
  const { project, extensions, target } = await fixture(t);
  await fs.mkdir(target, { recursive: true });
  const unrelated = JSON.stringify({ publisher: 'someone', name: 'other' });
  await fs.writeFile(path.join(target, 'package.json'), unrelated);
  await assert.rejects(installLocal(project, extensions), /autre extension/);
  assert.equal(await fs.readFile(path.join(target, 'package.json'), 'utf8'), unrelated);
});

test('refuses a destination that overlaps the source checkout', async t => {
  const { project } = await fixture(t);
  await assert.rejects(installLocal(project, path.join(project, 'media', 'extensions')), /distinct du dépôt/);
  assert.match(await fs.readFile(path.join(project, 'out', 'extension.js'), 'utf8'), /activate/);
});

test('refuses an existing destination symlink', { skip: process.platform === 'win32' }, async t => {
  const { root, project, extensions, target } = await fixture(t);
  const unrelated = path.join(root, 'unrelated');
  await fs.mkdir(unrelated);
  await fs.mkdir(extensions);
  await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep');
  await fs.symlink(unrelated, target);
  await assert.rejects(installLocal(project, extensions), /n’est pas un dossier/);
  assert.equal(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});

test('the CLI installs the real compiled extension without requiring VS Code or a VSIX', async t => {
  const { root } = await fixture(t);
  const extensions = path.join(root, 'CLI extensions');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'install-local.cjs'), '--extensions-dir', extensions,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(await fs.readFile(path.join(extensions, id, 'package.json'), 'utf8'));
  assert.equal(installed.name, 'explorer-image');
  assert.equal(typeof require(path.join(extensions, id, 'out', 'imageClient.js')).fetchImage, 'function');
  assert.match(result.stdout, /Fermez toutes les fenêtres/);
});

test('invalid CLI options fail without installing anything', async t => {
  const { extensions } = await fixture(t);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'install-local.cjs'), '--insiders', '--extensions-dir', extensions,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /séparément/);
  await assert.rejects(fs.stat(extensions), { code: 'ENOENT' });
});

test('update:local pulls from Git and forwards the destination through nested npm commands', async t => {
  if (!process.env.npm_execpath) return t.skip('Run via npm test to locate the npm CLI.');
  const { root, project, extensions, manifest, target } = await fixture(t);
  const realProject = path.join(__dirname, '..');
  const { scripts } = require('../package.json');
  manifest.scripts = {
    compile: 'node --check out/extension.js',
    'install:local': scripts['install:local'],
    'update:local': scripts['update:local'],
  };
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(project, 'package-lock.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': { name: manifest.name, version: manifest.version } },
  }));
  await fs.mkdir(path.join(project, 'scripts'));
  await fs.copyFile(path.join(realProject, 'scripts', 'install-local.cjs'), path.join(project, 'scripts', 'install-local.cjs'));
  const remote = path.join(root, 'remote.git');
  function git(cwd, ...args) {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  git(root, 'init', '--bare', remote);
  git(project, 'init', '-b', 'main');
  git(project, 'add', '.');
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-u', 'origin', 'main');

  const writer = path.join(root, 'writer');
  git(root, 'clone', '--branch', 'main', remote, writer);
  await fs.writeFile(path.join(writer, 'README.md'), 'Updated from Git');
  git(writer, 'add', 'README.md');
  git(writer, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Update');
  git(writer, 'push');

  const result = spawnSync(process.execPath, [
    process.env.npm_execpath, 'run', 'update:local', '--', '--extensions-dir', extensions,
  ], {
    cwd: project, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_cache: path.join(root, 'npm-cache') },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), 'Updated from Git');
  assert.equal(git(project, 'rev-parse', 'HEAD'), git(writer, 'rev-parse', 'HEAD'));
});
