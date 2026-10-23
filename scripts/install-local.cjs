const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

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

  const obsoleteFile = path.join(extensions, '.obsolete');
  const obsolete = await exists(obsoleteFile) ? await readJson(obsoleteFile) : {};
  if (obsolete[id]) {
    throw new Error('Cette installation est en attente de suppression. Fermez puis relancez VS Code avant de réinstaller.');
  }
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

  const staging = await fs.mkdtemp(path.join(extensions, `.${id}-install-`));
  const payload = path.join(staging, 'extension');
  const backup = path.join(staging, 'previous');
  let backedUp = false;
  let preserveBackup = false;
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
    if (current) {
      await fs.rename(target, backup);
      backedUp = true;
    }
    try {
      await fs.rename(payload, target);
    } catch (error) {
      if (backedUp) {
        try {
          await fs.rename(backup, target);
        } catch (restoreError) {
          preserveBackup = true;
          throw new Error(`Restauration impossible. L’ancienne installation est conservée dans ${backup}.`, { cause: restoreError });
        }
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
