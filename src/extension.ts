import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { fetchImage, parseImageUrl } from './imageClient';

function passwordKey(url: string, username: string): string {
  return `explorerImage.basic:${JSON.stringify([parseImageUrl(url).origin, username])}`;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ImageViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('explorerImage.view', provider),
    vscode.commands.registerCommand('explorerImage.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('explorerImage.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'explorerImage')),
    vscode.commands.registerCommand('explorerImage.setPassword', async () => {
      const config = vscode.workspace.getConfiguration('explorerImage');
      let key: string;
      try {
        key = passwordKey(config.get<string>('url', '').trim(), config.get<string>('username', ''));
      } catch {
        void vscode.window.showErrorMessage('Configurez d’abord une URL HTTP(S) valide dans les réglages Image.');
        return;
      }
      const password = await vscode.window.showInputBox({
        title: 'Mot de passe HTTP Basic',
        prompt: 'Enregistré dans le coffre VS Code pour ce serveur et cet identifiant.',
        password: true,
        ignoreFocusOut: true,
      });
      if (password !== undefined) {
        await context.secrets.store(key, password);
        void vscode.window.showInformationMessage('Mot de passe HTTP Basic enregistré.');
      }
    }),
    vscode.commands.registerCommand('explorerImage.clearPassword', async () => {
      const config = vscode.workspace.getConfiguration('explorerImage');
      try {
        const key = passwordKey(config.get<string>('url', '').trim(), config.get<string>('username', ''));
        await context.secrets.delete(key);
        void vscode.window.showInformationMessage('Mot de passe supprimé du coffre. Le réglage password reste applicable s’il est renseigné.');
      } catch {
        void vscode.window.showErrorMessage('Configurez d’abord une URL HTTP(S) valide dans les réglages Image.');
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('explorerImage')) {
        void provider.refresh();
      }
    }),
    context.secrets.onDidChange(event => {
      if (event.key.startsWith('explorerImage.basic:')) {
        void provider.refresh();
      }
    }),
  );
}

class ImageViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private viewSubscriptions: vscode.Disposable[] = [];
  private generation = 0;
  private nextFrameId = 0;
  private frameInFlight?: number;
  private pendingFrame?: string;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.stop();
    this.viewSubscriptions.forEach(subscription => subscription.dispose());
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage(message => {
        if (message?.type === 'ready' || message?.type === 'refresh') {
          void this.refresh();
        } else if (message?.type === 'settings') {
          void vscode.commands.executeCommand('explorerImage.openSettings');
        } else if (message?.type === 'frameDisplayed' && message.frameId === this.frameInFlight) {
          this.frameInFlight = undefined;
          if (this.pendingFrame) {
            this.queueFrame(this.pendingFrame);
          }
        }
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          void this.refresh();
        } else {
          this.stop();
        }
      }),
      view.onDidDispose(() => {
        this.stop();
        this.view = undefined;
      }),
    ];
  }

  async refresh(): Promise<void> {
    this.stop();
    const view = this.view;
    if (this.disposed || !view?.visible) {
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.request = controller;
    const config = vscode.workspace.getConfiguration('explorerImage');
    const url = config.get<string>('url', '').trim();
    if (!url) {
      this.request = undefined;
      this.post({ type: 'empty' });
      return;
    }
    this.post({ type: 'loading' });
    try {
      const username = config.get<string>('username', '');
      const storedPassword = await this.context.secrets.get(passwordKey(url, username));
      if (controller.signal.aborted) {
        return;
      }
      const image = await fetchImage({
        url, username,
        password: storedPassword ?? config.get<string>('password', ''),
        signal: controller.signal,
        onFrame: image => {
          if (generation === this.generation) {
            this.queueFrame(image);
          }
        },
      });
      if (generation === this.generation) {
        this.post({ type: 'image', image, updatedAt: Date.now() });
      }
    } catch (error) {
      if (generation === this.generation) {
        this.post({
          type: 'error',
          message: error instanceof Error ? error.message : 'Impossible de charger l’image.',
        });
      }
    } finally {
      if (generation === this.generation && !this.disposed && view.visible) {
        this.request = undefined;
        const configured = config.get<number>('refreshInterval', 60);
        const seconds = config.get<boolean>('autoRefresh', true)
          ? (Number.isFinite(configured) ? Math.max(0, Math.min(86400, Math.floor(configured))) : 60)
          : 0;
        this.post({ type: 'schedule', nextRefreshAt: seconds > 0 ? Date.now() + seconds * 1000 : null });
        if (seconds > 0) {
          this.timer = setTimeout(() => void this.refresh(), seconds * 1000);
        }
      }
    }
  }

  private post(message: unknown): void {
    if (this.view && !this.disposed) {
      void this.view.webview.postMessage(message);
    }
  }

  private queueFrame(image: string): void {
    // Keep one frame being decoded and only the latest waiting frame.
    if (this.frameInFlight !== undefined) {
      this.pendingFrame = image;
      return;
    }
    this.pendingFrame = undefined;
    this.frameInFlight = ++this.nextFrameId;
    this.post({ type: 'image', image, frameId: this.frameInFlight, updatedAt: Date.now() });
  }

  private stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
    this.frameInFlight = undefined;
    this.pendingFrame = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.viewSubscriptions.forEach(subscription => subscription.dispose());
    this.viewSubscriptions = [];
    this.view = undefined;
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const resource = (name: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', name),
    );
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${resource('view.css')}">
  <title>Image distante</title>
</head>
<body>
  <div id="frame" aria-busy="false">
    <img id="image" alt="Image distante configurée" hidden>
    <p id="placeholder" role="status" aria-live="polite">Configurez l’URL d’une image via l’engrenage du panneau.</p>
  </div>
  <script nonce="${nonce}" src="${resource('view.js')}"></script>
</body>
</html>`;
  }
}
