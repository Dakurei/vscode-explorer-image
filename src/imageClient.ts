const supportedTypes = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
]);

export interface ImageRequest {
  url: string;
  username?: string;
  password?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export function parseImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('L’URL de l’image est invalide.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('L’URL doit commencer par http:// ou https://.');
  }
  if (url.username || url.password) {
    throw new Error('Renseignez les identifiants dans les réglages HTTP Basic, pas dans l’URL.');
  }
  return url;
}

export async function fetchImage(options: ImageRequest): Promise<string> {
  let url = parseImageUrl(options.url);
  const username = options.username ?? '';
  const password = options.password ?? '';
  if (username.includes(':')) {
    throw new Error('L’identifiant HTTP Basic ne peut pas contenir de deux-points.');
  }
  let authorization = username || password
    ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
    : undefined;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;

  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const headers: Record<string, string> = {
        Accept: 'image/*',
        'Cache-Control': 'no-cache, no-store',
        Pragma: 'no-cache',
      };
      if (authorization) {
        headers.Authorization = authorization;
      }
      const response = await fetch(url, { headers, redirect: 'manual', signal, cache: 'no-store' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) {
          throw new Error('Redirection invalide ou trop de redirections (maximum 5).');
        }
        let resolved: URL;
        try {
          resolved = new URL(location, url);
        } catch {
          throw new Error('La redirection contient une URL invalide.');
        }
        const next = parseImageUrl(resolved.href);
        if (url.protocol === 'https:' && next.protocol === 'http:') {
          throw new Error('La redirection HTTPS vers HTTP a été refusée.');
        }
        // Once removed, credentials stay removed for the rest of this request.
        if (next.origin !== url.origin) {
          authorization = undefined;
        }
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401 || response.status === 403
          ? ' Vérifiez les identifiants HTTP Basic.' : '';
        throw new Error(`Le serveur a répondu HTTP ${response.status}.${hint}`);
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!type || !supportedTypes.has(type)) {
        await response.body?.cancel();
        throw new Error('Le serveur doit renvoyer une image avec un Content-Type image/* pris en charge.');
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('L’image dépasse la taille maximale autorisée (10 Mo par défaut).');
      }
      if (!response.body) {
        throw new Error('Le serveur a renvoyé une image vide.');
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new Error('L’image dépasse la taille maximale autorisée (10 Mo par défaut).');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      if (!size) {
        throw new Error('Le serveur a renvoyé une image vide.');
      }
      return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
    }
    throw new Error('Trop de redirections.');
  } catch (error) {
    if (options.signal?.aborted) {
      throw new Error('Chargement annulé.');
    }
    if (timeout.aborted) {
      throw new Error('Le serveur ne répond pas dans le délai imparti (15 secondes par défaut).');
    }
    // Fetch errors may include URLs, query tokens or low-level credentials.
    if (error instanceof TypeError) {
      throw new Error('Connexion impossible. Vérifiez l’URL, le réseau et le certificat HTTPS.');
    }
    throw error;
  }
}
