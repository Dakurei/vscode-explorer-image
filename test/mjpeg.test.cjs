const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchImage } = require('../out/imageClient');
const { readMjpeg } = require('../out/mjpeg');

// The multipart reader treats JPEG payloads as binary; decoding belongs to the webview.
const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9]);
const secondJpeg = Buffer.from([0xff, 0xd8, 0x01, 0x81, 0xff, 0xd9]);
const contentType = 'multipart/x-mixed-replace; boundary="camera-frame"';

function part(image = jpeg, withLength = true, headers = 'Content-Type: image/jpeg\r\n') {
  return Buffer.concat([
    Buffer.from(`--camera-frame\r\n${headers}${withLength ? `Content-Length: ${image.length}\r\n` : ''}\r\n`),
    image, Buffer.from('\r\n'),
  ]);
}

function multipart(parts) {
  return Buffer.concat([...parts, Buffer.from('--camera-frame--\r\n')]);
}

function stream(bytes, chunkSize = bytes.length) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
      } else {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        offset = Math.min(bytes.length, offset + chunkSize);
      }
    },
  });
}

async function collect(bytes, { chunkSize, type = contentType, maxBytes = 1024 } = {}) {
  return Array.fromAsync(readMjpeg(stream(bytes, chunkSize), type, maxBytes));
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('parses multiple JPEGs with every multipart field split across single-byte chunks', async () => {
  const bytes = multipart([part(), part(secondJpeg)]);
  assert.deepEqual(await collect(bytes, { chunkSize: 1 }), [jpeg, secondJpeg]);
});

test('supports parts without Content-Length or Content-Type, MIME preambles and a final boundary without CRLF', async () => {
  const bytes = Buffer.concat([
    Buffer.from('Camera stream\r\n\r\n'), part(jpeg, false), part(secondJpeg, false, ''),
    Buffer.from('--camera-frame--'),
  ]);
  assert.deepEqual(await collect(bytes, { chunkSize: 3 }), [jpeg, secondJpeg]);
});

test('preserves binary payloads containing a partial boundary and ignores unrelated MIME parameters', async () => {
  const image = Buffer.concat([jpeg.subarray(0, 2), Buffer.from('\r\n--camera-frameX\r\n'), jpeg.subarray(2)]);
  assert.deepEqual(await collect(multipart([part(image, false)]), {
    chunkSize: 2, type: 'Multipart/X-Mixed-Replace; charset=binary; BOUNDARY=camera-frame',
  }), [image]);
});

test('applies the size limit per image rather than to the whole stream', async () => {
  const bytes = multipart(Array.from({ length: 20 }, () => part()));
  assert.equal((await collect(bytes, { maxBytes: jpeg.length })).length, 20);
  await assert.rejects(collect(multipart([part()]), { maxBytes: jpeg.length - 1 }), /taille maximale/);
  await assert.rejects(collect(multipart([part(jpeg, false)]), { chunkSize: 1, maxBytes: jpeg.length - 1 }), /taille maximale/);
});

test('rejects missing boundaries, unsupported part types, bad lengths and invalid JPEGs', async () => {
  await assert.rejects(collect(part(), { type: 'multipart/x-mixed-replace' }), /boundary/);
  await assert.rejects(collect(part(), { type: `multipart/x-mixed-replace; boundary=${'x'.repeat(71)}` }), /boundary/);
  await assert.rejects(collect(part(jpeg, false, 'Content-Type: text/html\r\n')), /Content-Type image\/jpeg/);
  for (const length of ['-1', '1.5', 'abc', '9007199254740992']) {
    await assert.rejects(collect(part(jpeg, false, `Content-Length: ${length}\r\n`)), /Content-Length/);
  }
  await assert.rejects(collect(multipart([part(Buffer.from('not a JPEG'))])), /JPEG vide ou invalide/);
  await assert.rejects(collect(multipart([part(Buffer.alloc(0))])), /JPEG vide ou invalide/);
});

test('bounds preambles and part headers and rejects truncated responses', async () => {
  await assert.rejects(collect(Buffer.from('x'.repeat(20_000))), /trop long/);
  await assert.rejects(collect(Buffer.from(`${' '.repeat(8_000)}\r\n`.repeat(3))), /trop long/);
  await assert.rejects(collect(Buffer.from(`--camera-frame\r\nX: ${'x'.repeat(20_000)}`)), /trop long/);
  await assert.rejects(collect(part().subarray(0, -4)), /interrompu|incomplet/);
  await assert.rejects(collect(part(jpeg, false)), /interrompu|incomplet/);
});

test('detects a live MJPEG response on any URL, sends Basic auth and resets the timeout per frame', async t => {
  const controller = new AbortController();
  let received;
  const base = await serve(t, (req, res) => {
    received = req;
    res.writeHead(200, { 'Content-Type': contentType });
    res.write(part());
    const timer = setInterval(() => res.write(part()), 25);
    res.on('close', () => clearInterval(timer));
  });
  const frames = [];
  const start = Date.now();
  await assert.rejects(fetchImage({
    url: `${base}/camera?token=keep`, username: 'alice', password: 'secret', timeoutMs: 200,
    signal: controller.signal,
    onFrame(image) {
      frames.push(image);
      if (frames.length === 12) controller.abort();
    },
  }), /annulé/);
  assert.equal(frames.length, 12);
  assert.ok(Date.now() - start > 200, 'an active stream must outlive its initial timeout');
  assert.ok(frames.every(image => image === `data:image/jpeg;base64,${jpeg.toString('base64')}`));
  assert.equal(received.url, '/camera?token=keep');
  assert.equal(received.headers.authorization, `Basic ${Buffer.from('alice:secret').toString('base64')}`);
  assert.match(received.headers.accept, /multipart\/x-mixed-replace/);
});

test('displays a length-delimited frame immediately and times out a stalled live stream', async t => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType });
    // The connection stays open without sending another boundary or frame.
    res.write(part());
  });
  const frames = [];
  await assert.rejects(fetchImage({ url: base, timeoutMs: 100, onFrame: frame => frames.push(frame) }), /délai imparti/);
  assert.equal(frames.length, 1);
});

test('snapshot callers receive only the first frame and close the live response', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const base = await serve(t, (_req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'Content-Type': contentType });
    res.write(part());
  });
  assert.equal(await fetchImage({ url: base }), `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  await disconnected;
});

test('delivers complete frames before reporting the end of a finite MJPEG response', async t => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType }).end(multipart([part(), part(secondJpeg, false)]));
  });
  const frames = [];
  await assert.rejects(fetchImage({ url: base, onFrame: frame => frames.push(frame) }), /flux MJPEG est terminé/);
  assert.equal(frames.length, 2);
});

test('keeps Basic auth on a same-origin MJPEG redirect and strips it on a different origin', async t => {
  const received = [];
  const target = await serve(t, (req, res) => {
    received.push(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': contentType }).end(multipart([part()]));
  });
  const source = await serve(t, (req, res) => {
    if (req.url === '/same') {
      res.writeHead(302, { Location: '/stream' }).end();
    } else if (req.url === '/other') {
      res.writeHead(302, { Location: target }).end();
    } else {
      received.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': contentType }).end(multipart([part()]));
    }
  });
  const options = { username: 'alice', password: 'secret' };
  await fetchImage({ ...options, url: `${source}/same` });
  await fetchImage({ ...options, url: `${source}/other` });
  assert.deepEqual(received, [`Basic ${Buffer.from('alice:secret').toString('base64')}`, undefined]);
});
