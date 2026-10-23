const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchImage, parseImageUrl } = require('../out/imageClient');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let base;
let otherBase;
let server;
let otherServer;
const received = [];

function listen(handler) {
  return new Promise(resolve => {
    const instance = http.createServer(handler);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

before(async () => {
  otherServer = await listen((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    if (req.url === '/return') {
      res.writeHead(302, { Location: `${base}/image` }).end();
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    }
  });
  otherBase = `http://127.0.0.1:${otherServer.address().port}`;
  server = await listen((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    switch (req.url) {
      case '/auth':
        if (req.headers.authorization !== `Basic ${Buffer.from('alice:sécret').toString('base64')}`) {
          res.writeHead(401).end();
          return;
        }
        break;
      case '/redirect':
        res.writeHead(302, { Location: '/auth' }).end(); return;
      case '/external':
        res.writeHead(302, { Location: `${otherBase}/image` }).end(); return;
      case '/round-trip':
        res.writeHead(302, { Location: `${otherBase}/return` }).end(); return;
      case '/loop':
        res.writeHead(302, { Location: '/loop' }).end(); return;
      case '/bad-redirect':
        res.writeHead(302).end(); return;
      case '/html':
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>Login</p>'); return;
      case '/missing-type':
        res.writeHead(200).end(png); return;
      case '/missing':
        res.writeHead(404).end(); return;
      case '/empty':
        res.writeHead(200, { 'Content-Type': 'image/png' }).end(); return;
      case '/slow':
        // The client aborts this connection; no server timer is left running.
        return;
      case '/large':
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '2048' }).end(Buffer.alloc(2048)); return;
      case '/chunked':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.write(Buffer.alloc(64)); res.end(Buffer.alloc(64)); return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png; charset=binary' }).end(png);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await Promise.all([server, otherServer].map(instance => new Promise(resolve => {
    instance.close(resolve);
    instance.closeAllConnections();
  })));
});

test('downloads image bytes as a data URI without changing the query string', async () => {
  const result = await fetchImage({ url: `${base}/image?token=unchanged` });
  assert.equal(result, `data:image/png;base64,${png.toString('base64')}`);
  const request = received.at(-1);
  assert.equal(request.path, '/image?token=unchanged');
  assert.equal(request.headers.authorization, undefined);
  assert.match(request.headers['cache-control'], /no-cache/);
});

test('supports HTTP Basic including UTF-8 passwords', async () => {
  const result = await fetchImage({ url: `${base}/auth`, username: 'alice', password: 'sécret' });
  assert.match(result, /^data:image\/png;base64,/);
});

test('reports authentication failure without reflecting credentials or the URL', async () => {
  await assert.rejects(fetchImage({ url: `${base}/auth`, username: 'private', password: 'secret' }), error => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /private|secret|127\.0\.0\.1/);
    return true;
  });
});

test('preserves Basic authentication for same-origin redirects', async () => {
  await fetchImage({ url: `${base}/redirect`, username: 'alice', password: 'sécret' });
  assert.ok(received.at(-1).headers.authorization);
});

test('strips Basic authentication on a change of origin', async () => {
  await fetchImage({ url: `${base}/external`, username: 'alice', password: 'sécret' });
  assert.equal(received.at(-1).headers.authorization, undefined);
});

test('does not restore credentials after a redirect back to the original origin', async () => {
  await fetchImage({ url: `${base}/round-trip`, username: 'alice', password: 'sécret' });
  assert.equal(received.at(-1).path, '/image');
  assert.equal(received.at(-1).headers.authorization, undefined);
});

test('rejects redirect loops and redirects without Location', async () => {
  await assert.rejects(fetchImage({ url: `${base}/loop` }), /redirection/i);
  await assert.rejects(fetchImage({ url: `${base}/bad-redirect` }), /redirection/i);
});

test('rejects HTML, missing MIME types, missing resources and empty images', async () => {
  await assert.rejects(fetchImage({ url: `${base}/html` }), /Content-Type/);
  await assert.rejects(fetchImage({ url: `${base}/missing-type` }), /Content-Type/);
  await assert.rejects(fetchImage({ url: `${base}/missing` }), /HTTP 404/);
  await assert.rejects(fetchImage({ url: `${base}/empty` }), /vide/);
});

test('limits downloads with and without a Content-Length header', async () => {
  await assert.rejects(fetchImage({ url: `${base}/large`, maxBytes: 100 }), /taille maximale/);
  await assert.rejects(fetchImage({ url: `${base}/chunked`, maxBytes: 100 }), /taille maximale/);
});

test('times out an unresponsive server', async () => {
  await assert.rejects(fetchImage({ url: `${base}/slow`, timeoutMs: 50 }), /délai imparti/);
});

test('supports cancellation when settings change or the view is hidden', async () => {
  const controller = new AbortController();
  const request = fetchImage({ url: `${base}/slow`, signal: controller.signal });
  controller.abort();
  await assert.rejects(request, /annulé/);
});

test('validates URL schemes, embedded credentials and Basic usernames', async () => {
  assert.throws(() => parseImageUrl('not a URL'), /invalide/);
  assert.throws(() => parseImageUrl('file:///etc/passwd'), /http/);
  assert.throws(() => parseImageUrl('https://alice:secret@example.com/image'), /identifiants/);
  await assert.rejects(fetchImage({ url: `${base}/image`, username: 'alice:admin' }), /deux-points/);
});
