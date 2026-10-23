const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { pathToFileURL } = require('node:url');

const sourceDir = path.resolve(__dirname, '..');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readState(file, fallback, validate) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let data;
  try {
    data = text === undefined ? fallback : JSON.parse(text);
  } catch {
    throw new Error(`Le fichier ${file} contient un JSON invalide. L’installation n’a pas été modifiée.`);
  }
  if (!validate(data)) {
    throw new Error(`Le format de ${file} est invalide. L’installation n’a pas été modifiée.`);
  }
  return { file, text, data };
}

function registerExtension(entries, manifest, target) {
  const id = `${manifest.publisher}.${manifest.name}`;
  const sameExtension = entry => entry.identifier.id.toLowerCase() === id.toLowerCase();
  const previous = entries.find(sameExtension);
  const uri = pathToFileURL(target);
  return [...entries.filter(entry => !sameExtension(entry)), {
    ...previous,
    identifier: { ...previous?.identifier, id },
    version: manifest.version,
    location: { $mid: 1, scheme: 'file', path: decodeURIComponent(uri.pathname), ...(uri.hostname ? { authority: uri.hostname } : {}) },
    relativeLocation: path.basename(target),
  }];
}

async function installLocal(projectDir, extensionsDir) {
  const project = await fs.realpath(projectDir);
  const manifest = await readJson(path.join(project, 'package.json'));
  const id = `${manifest.publisher}.${manifest.name}`;
  if (!/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(id)) {
    throw new Error('Identifiant d’extension invalide dans package.json.');
  }
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    throw new Error('L’installation locale doit être adaptée aux nouvelles dépendances de production.');
  }

  await fs.mkdir(extensionsDir, { recursive: true });
  const extensions = await fs.realpath(extensionsDir);
  const target = path.join(extensions, id);
  if (contains(project, extensions) || contains(target, project)) {
    throw new Error('Le dossier d’extensions doit être distinct du dépôt et de ses sous-dossiers.');
  }

  // A fixed folder name lets Git updates replace the installed version, even
  // when package.json gains a new version. Never follow an existing symlink.
  const current = await exists(target);
  if (current) {
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`La destination existe et n’est pas un dossier d’extension : ${target}`);
    }
    const installed = await readJson(path.join(target, 'package.json'));
    if (`${installed.publisher}.${installed.name}` !== id) {
      throw new Error(`La destination appartient à une autre extension : ${target}`);
    }
  }

  const obsoleteState = await readState(path.join(extensions, '.obsolete'), {},
    data => data !== null && typeof data === 'object' && !Array.isArray(data));
  const obsolete = obsoleteState.data;
  const profileState = await readState(path.join(extensions, 'extensions.json'), [],
    data => Array.isArray(data) && data.every(entry => typeof entry?.identifier?.id === 'string'));
  // VSIX installations use versioned folder names. Require their normal
  // uninstallation rather than deleting another installation or its metadata.
  for (const entry of await fs.readdir(extensions, { withFileTypes: true })) {
    if (entry.name === id || entry.name.startsWith('.') || obsolete[entry.name]) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let other;
    try {
      other = await readJson(path.join(extensions, entry.name, 'package.json'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (`${other.publisher}.${other.name}`.toLowerCase() === id.toLowerCase()) {
      throw new Error(`Une autre installation de ${id} existe (${entry.name}). Désinstallez-la dans VS Code, fermez toutes ses fenêtres, puis relancez cette commande.`);
    }
  }

  const stateChanges = [];
  // An existing default profile is authoritative: copying a folder alone does
  // not register an extension. If it does not exist yet, VS Code initializes
  // it from all installed folders on first launch; do not hide those folders
  // by creating an incomplete registry containing only this extension.
  if (profileState.text !== undefined) {
    stateChanges.push({ ...profileState, data: registerExtension(profileState.data, manifest, target) });
  }
  const obsoleteKey = `${id}-${manifest.version}`.toLowerCase();
  const retainedObsolete = Object.fromEntries(Object.entries(obsolete).filter(([key]) =>
    key.toLowerCase() !== id.toLowerCase() && key.toLowerCase() !== obsoleteKey));
  if (Object.keys(retainedObsolete).length !== Object.keys(obsolete).length) {
    stateChanges.push({ ...obsoleteState, data: retainedObsolete });
  }

  const staging = await fs.mkdtemp(path.join(extensions, `.${id}-install-`));
  const payload = path.join(staging, 'extension');
  const backup = path.join(staging, 'previous');
  let backedUp = false;
  let replaced = false;
  let preserveBackup = false;
  const appliedChanges = [];
  try {
    await fs.mkdir(payload);
    for (const file of ['package.json', 'README.md', 'LICENSE']) {
      await fs.copyFile(path.join(project, file), path.join(payload, file));
    }
    for (const dir of ['out', 'media']) {
      await fs.cp(path.join(project, dir), path.join(payload, dir), {
        recursive: true,
        filter: file => !file.endsWith('.map'),
      });
    }
    const main = path.resolve(payload, manifest.main);
    if (!contains(payload, main) || !(await fs.stat(main)).isFile()) {
      throw new Error('Le point d’entrée compilé de l’extension est invalide.');
    }
    for (const [index, change] of stateChanges.entries()) {
      change.prepared = path.join(staging, `state-${index}.json`);
      change.backup = path.join(staging, `state-${index}.previous`);
      await fs.writeFile(change.prepared, JSON.stringify(change.data));
      await fs.writeFile(change.backup, change.text);
      if (await fs.readFile(change.file, 'utf8') !== change.text) {
        throw new Error('Le registre d’extensions a changé. Fermez toutes les fenêtres de VS Code, puis relancez l’installation.');
      }
    }
    try {
      if (current) {
        await fs.rename(target, backup);
        backedUp = true;
      }
      await fs.rename(payload, target);
      replaced = true;
      for (const change of stateChanges) {
        await fs.rename(change.prepared, change.file);
        appliedChanges.push(change);
      }
    } catch (error) {
      try {
        for (const change of appliedChanges.reverse()) {
          await fs.rename(change.backup, change.file);
        }
        if (replaced) await fs.rm(target, { recursive: true, force: true });
        if (backedUp) await fs.rename(backup, target);
      } catch (restoreError) {
        preserveBackup = true;
        throw new Error(`Restauration impossible. Les sauvegardes de l’installation sont conservées dans ${staging}.`, { cause: restoreError });
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) await fs.rm(staging, { recursive: true, force: true });
  }
  return { id, version: manifest.version, target };
}

async function main() {
  const { values } = parseArgs({
    options: {
      insiders: { type: 'boolean', default: false },
      'extensions-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage : npm run install:local -- [--insiders | --extensions-dir CHEMIN]');
    console.log('Par défaut : VSCODE_EXTENSIONS ou ~/.vscode/extensions. --insiders utilise ~/.vscode-insiders/extensions.');
    return;
  }
  if (values.insiders && values['extensions-dir'] !== undefined) {
    throw new Error('Utilisez --insiders ou --extensions-dir, séparément.');
  }
  if (values['extensions-dir'] !== undefined && !values['extensions-dir'].trim()) {
    throw new Error('--extensions-dir nécessite un chemin non vide.');
  }
  const extensionsDir = values['extensions-dir'] ?? (values.insiders
    ? path.join(os.homedir(), '.vscode-insiders', 'extensions')
    : process.env.VSCODE_EXTENSIONS || path.join(os.homedir(), '.vscode', 'extensions'));
  const installed = await installLocal(sourceDir, path.resolve(extensionsDir));
  console.log(`${installed.id} ${installed.version} installée dans ${installed.target}`);
  console.log('Fermez toutes les fenêtres de VS Code, puis relancez-le pour charger cette version.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Installation impossible : ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { installLocal };
