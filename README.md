<h1 align="center">VS Code Explorer Image</h1>

<p align="center">
  Une image distante dans votre Explorateur VS Code, toujours à jour.
</p>

<p align="center">
  <a href="https://github.com/Dakurei/vscode-explorer-image/actions/workflows/ci.yml"><img src="https://github.com/Dakurei/vscode-explorer-image/actions/workflows/ci.yml/badge.svg?branch=master" alt="État des tests Linux, macOS et Windows"></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS_Code-1.96%2B-007ACC" alt="VS Code 1.96 ou plus récent"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-5FA04E" alt="Node.js 22 ou plus récent"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Licence-MIT-64748B" alt="Licence MIT"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#configurer">Configuration</a> ·
  <a href="#mise-à-jour">Mise à jour</a> ·
  <a href="https://github.com/Dakurei/vscode-explorer-image/issues">Signaler un problème</a>
</p>

---

Ajoutez une section **Image** à l’Explorateur de VS Code pour garder un visuel distant sous les yeux : webcam, graphique, état d’un service ou toute autre image accessible par URL. Le rafraîchissement est automatique et configurable.

L’image remplit toute la surface du panneau, sans marges, textes ni boutons superposés. Le rafraîchissement manuel et les réglages sont accessibles dans la barre de titre.

## Installation

Prérequis : **VS Code Desktop 1.96 ou plus récent**, **Git** et **Node.js 22 ou plus récent** (avec npm).

L’extension s’installe directement depuis les sources, sans VSIX ni publication sur le Marketplace. Copiez l’URL de ce dépôt depuis le bouton **Code**, puis exécutez :

```bash
git clone <URL_DU_DEPOT> vscode-explorer-image
cd vscode-explorer-image
npm ci
npm run install:local
```

Remplacez `<URL_DU_DEPOT>` par l’URL copiée. Fermez toutes les fenêtres de VS Code avant l’installation, puis relancez-le. La section **Image** apparaît dans l’Explorateur.

Le script compile l’extension et la copie dans le [dossier d’extensions de VS Code](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#your-extension-folder), sous l’identifiant `local-tools.explorer-image`. Les commandes fonctionnent sous Linux, macOS et Windows (PowerShell compris). Conservez le clone pour les prochaines mises à jour.

### VS Code Insiders

Remplacez la commande d’installation par :

```bash
npm run install:local -- --insiders
```

### Dossier d’extensions personnalisé

Pour VSCodium, une installation portable ou un hôte distant, précisez le dossier d’extensions utilisé par votre éditeur :

```bash
npm run install:local -- --extensions-dir "/chemin/vers/les/extensions"
```

Sans option, le script utilise `VSCODE_EXTENSIONS` si cette variable est définie, sinon `~/.vscode/extensions` (`%USERPROFILE%\.vscode\extensions` sous Windows). L’option `--insiders` utilise `~/.vscode-insiders/extensions`.

Pour SSH, WSL ou un conteneur, exécutez l’installation dans l’environnement où l’extension doit tourner. L’installation vise le profil par défaut ; les profils personnalisés ne sont pas gérés par le script. Si une autre copie de l’extension est déjà installée, désinstallez-la depuis VS Code avant de lancer l’installation depuis les sources.

## Mise à jour

Fermez toutes les fenêtres de VS Code, puis exécutez cette commande dans le clone :

```bash
npm run update:local
```

Elle récupère les nouvelles sources avec `git pull --ff-only`, installe les dépendances, recompile et remplace la copie installée. Relancez ensuite VS Code. Vos réglages restent conservés.

Utilisez la même option que lors de l’installation si nécessaire :

```bash
npm run update:local -- --insiders
# Ou, pour un dossier personnalisé :
npm run update:local -- --extensions-dir "/chemin/vers/les/extensions"
```

Les mises à jour sont manuelles. Si vous avez modifié les sources et que Git signale un conflit ou une divergence, résolvez-le avant de relancer la commande.

## Configurer

Dans l’Explorateur, ouvrez la section **Image**, puis cliquez sur l’engrenage de son titre. Les réglages sont également accessibles en recherchant `explorerImage` dans les paramètres VS Code.

Exemple dans les paramètres utilisateur JSON :

```json
{
  "explorerImage.url": "https://example.com/status.png",
  "explorerImage.username": "",
  "explorerImage.autoRefresh": true,
  "explorerImage.refreshInterval": 60
}
```

| Réglage | Valeur par défaut | Fonction |
| --- | --- | --- |
| `explorerImage.url` | `""` | URL HTTP(S) de l’image. Vide : aucun chargement. |
| `explorerImage.username` | `""` | Identifiant HTTP Basic facultatif. |
| `explorerImage.password` | `""` | Mot de passe HTTP Basic facultatif, en clair dans les paramètres utilisateur locaux. |
| `explorerImage.autoRefresh` | `true` | Case à cocher pour activer ou désactiver le rafraîchissement automatique, sans modifier le délai. |
| `explorerImage.refreshInterval` | `60` | Délai en secondes après la fin du chargement, entre 0 et 86400. `0` désactive le rafraîchissement automatique. |

Les modifications s’appliquent immédiatement. Décochez **Auto Refresh** dans les réglages pour désactiver le rafraîchissement automatique : l’image se charge toujours à l’ouverture du panneau, et le délai configuré reste conservé. L’icône **Rafraîchir** dans la barre de titre permet de recharger à tout moment. Vous pouvez redimensionner la section en déplaçant sa séparation dans l’Explorateur. Si elle est masquée, utilisez **Affichage → Ouvrir la vue… → Image**.

### Authentification HTTP Basic

Renseignez d’abord l’URL et l’identifiant. Pour conserver le mot de passe dans le coffre sécurisé de VS Code, utilisez la palette de commandes (`Ctrl+Maj+P` / `Cmd+Maj+P`) :

- **Image : Enregistrer le mot de passe HTTP Basic**
- **Image : Supprimer le mot de passe HTTP Basic enregistré**

Le secret est associé à l’origine du serveur (protocole, hôte et port) et à l’identifiant. Il est prioritaire sur `explorerImage.password`. Si vous changez de serveur ou d’identifiant, enregistrez à nouveau le mot de passe. La suppression concerne le serveur et l’identifiant actuellement configurés ; videz aussi `explorerImage.password` si vous l’aviez utilisé.

Vous pouvez aussi utiliser directement `explorerImage.password` dans les paramètres **utilisateur**. Ce réglage est en clair et exclu de Settings Sync. Les secrets ne sont jamais transmis à la webview. HTTP Basic sur une URL HTTP n’est pas chiffré : utilisez HTTPS pour protéger les identifiants en transit.

## Comportement

- Le téléchargement s’exécute dans l’extension, sans dépendre des autorisations CORS du serveur.
- Formats acceptés : PNG, JPEG, GIF, WebP, SVG, AVIF, BMP et ICO, avec un en-tête `Content-Type` correspondant. Le serveur doit renvoyer l’image directement, pas une page HTML.
- L’image garde ses proportions et remplit le cadre bord à bord. Elle est centrée et recadrée si ses proportions diffèrent de celles du panneau. Les GIF animés restent animés.
- Les requêtes demandent de ne pas utiliser le cache ; l’URL et ses paramètres sont conservés, notamment pour les URL signées.
- Le chargement est limité à 15 secondes et 10 Mo. Sans image, les erreurs s’affichent dans le cadre. Si une image est déjà affichée, elle reste visible sans superposition et l’erreur est disponible au survol. Le prochain rafraîchissement est maintenu.
- Le rafraîchissement et les requêtes en cours s’arrêtent quand la vue est masquée. Une nouvelle requête démarre à sa réouverture.
- Jusqu’à cinq redirections sont suivies. Les identifiants sont retirés lorsque l’origine change, et une redirection HTTPS vers HTTP est refusée.
- L’extension nécessite un espace de travail approuvé. Elle cible VS Code Desktop (y compris un hôte d’extension distant), pas vscode.dev. Le serveur doit être joignable depuis l’hôte de l’extension.
- Les requêtes utilisent le client `fetch` de Node.js : les réglages de proxy et de certificats propres à VS Code ne sont pas repris automatiquement.

## Développer

```bash
npm ci
npm test
```

Ouvrez **ce dossier** dans VS Code, puis appuyez sur `F5`. Une fenêtre **Extension Development Host** s’ouvre avec la section **Image** dans l’Explorateur.

Les tests utilisent des serveurs HTTP locaux pour vérifier les téléchargements, l’authentification, les redirections, les réponses invalides, les limites de taille, le délai et l’annulation. L’installation locale est testée dans des dossiers temporaires, y compris les réinstallations, les conflits et la conservation de la version précédente en cas de préparation incomplète. `npm run watch` permet de recompiler pendant le développement.

L’extension n’a aucune dépendance d’exécution. Les dépendances de développement se limitent à TypeScript et aux types de Node.js et de VS Code.

Documentation officielle : [vues dans l’Explorateur](https://code.visualstudio.com/api/references/contribution-points#contributes.views) et [webviews](https://code.visualstudio.com/api/extension-guides/webview).
