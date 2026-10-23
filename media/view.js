(() => {
  const vscode = acquireVsCodeApi();
  const image = document.getElementById('image');
  const frame = document.getElementById('frame');
  const placeholder = document.getElementById('placeholder');
  let frameId;
  let requestError = '';

  function acknowledgeFrame() {
    if (frameId !== undefined) {
      const displayed = frameId;
      frameId = undefined;
      vscode.postMessage({ type: 'frameDisplayed', frameId: displayed });
    }
  }

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
    acknowledgeFrame();
  });
  image.addEventListener('load', () => {
    image.hidden = false;
    placeholder.hidden = true;
    frame.title = requestError;
    acknowledgeFrame();
  });

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'empty':
        frameId = undefined;
        requestError = '';
        image.removeAttribute('src');
        image.hidden = true;
        placeholder.hidden = false;
        placeholder.textContent = 'Configurez l’URL d’une image via l’engrenage du panneau.';
        frame.setAttribute('aria-busy', 'false');
        frame.title = '';
        break;
      case 'loading':
        frameId = undefined;
        requestError = '';
        frame.setAttribute('aria-busy', 'true');
        if (image.hidden) {
          placeholder.textContent = 'Chargement…';
        }
        break;
      case 'image':
        frameId = data.frameId;
        frame.setAttribute('aria-busy', 'false');
        frame.title = requestError;
        // An unchanged data URI does not always emit a new load event.
        if (image.getAttribute('src') === data.image && image.complete && image.naturalWidth > 0) {
          image.hidden = false;
          placeholder.hidden = true;
          acknowledgeFrame();
        } else {
          image.src = data.image;
        }
        break;
      case 'error':
        requestError = data.message;
        showError(data.message);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
