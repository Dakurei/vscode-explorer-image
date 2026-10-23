(() => {
  const vscode = acquireVsCodeApi();
  const image = document.getElementById('image');
  const frame = document.getElementById('frame');
  const placeholder = document.getElementById('placeholder');

  function showError(message) {
    frame.setAttribute('aria-busy', 'false');
    // Keep the last image unobstructed; the error remains available on hover.
    frame.title = message;
    if (image.hidden) {
      placeholder.textContent = message;
      placeholder.hidden = false;
    }
  }

  image.addEventListener('error', () => {
    image.hidden = true;
    showError('Impossible de décoder l’image reçue.');
  });
  image.addEventListener('load', () => {
    image.hidden = false;
    placeholder.hidden = true;
    frame.title = '';
  });

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'empty':
        image.removeAttribute('src');
        image.hidden = true;
        placeholder.hidden = false;
        placeholder.textContent = 'Configurez l’URL d’une image via l’engrenage du panneau.';
        frame.setAttribute('aria-busy', 'false');
        frame.title = '';
        break;
      case 'loading':
        frame.setAttribute('aria-busy', 'true');
        if (image.hidden) {
          placeholder.textContent = 'Chargement…';
        }
        break;
      case 'image':
        frame.setAttribute('aria-busy', 'false');
        frame.title = '';
        // An unchanged data URI does not always emit a new load event.
        if (image.getAttribute('src') === data.image && image.complete && image.naturalWidth > 0) {
          image.hidden = false;
          placeholder.hidden = true;
        } else {
          image.src = data.image;
        }
        break;
      case 'error':
        showError(data.message);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
