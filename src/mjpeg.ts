const maxHeaderBytes = 16 * 1024;

function interrupted(): Error {
  return new Error('Le flux MJPEG est interrompu ou incomplet.');
}

function tooLarge(): Error {
  return new Error('Une image du flux MJPEG dépasse la taille maximale autorisée (10 Mo par défaut).');
}

/** Incremental multipart reader. Only the current JPEG and a small delimiter tail are retained. */
class MultipartReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async readMore(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done) {
      return false;
    }
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, value]) : Buffer.from(value);
    return true;
  }

  async line(limit: number, allowEnd = false): Promise<string> {
    while (true) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        if (end > limit) {
          throw new Error('Les en-têtes du flux MJPEG sont trop longs.');
        }
        const line = this.buffer.subarray(0, end).toString('latin1');
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      if (this.buffer.length > limit + 1) {
        throw new Error('Les en-têtes du flux MJPEG sont trop longs.');
      }
      if (!await this.readMore()) {
        if (allowEnd && this.buffer.length && this.buffer.length <= limit) {
          const line = this.buffer.toString('latin1');
          this.buffer = Buffer.alloc(0);
          return line;
        }
        throw interrupted();
      }
    }
  }

  async frame(length: number | undefined, delimiter: Buffer, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    const append = (bytes: Buffer): void => {
      size += bytes.length;
      if (size > maxBytes) {
        throw tooLarge();
      }
      if (bytes.length) {
        chunks.push(bytes);
      }
    };
    while (true) {
      if (length !== undefined) {
        const count = Math.min(length - size, this.buffer.length);
        append(this.buffer.subarray(0, count));
        this.buffer = this.buffer.subarray(count);
        if (size === length) {
          return Buffer.concat(chunks, size);
        }
      } else {
        // A boundary must begin a line and be followed by CRLF, '--', or transport padding.
        let from = 0;
        let boundary = -1;
        while (true) {
          const candidate = this.buffer.indexOf(delimiter, from);
          if (candidate < 0 || candidate + delimiter.length + 2 > this.buffer.length) {
            break;
          }
          const first = this.buffer[candidate + delimiter.length];
          const second = this.buffer[candidate + delimiter.length + 1];
          if ((first === 13 && second === 10) || (first === 45 && second === 45)
            || first === 32 || first === 9) {
            boundary = candidate;
            break;
          }
          from = candidate + 1;
        }
        if (boundary >= 0) {
          append(this.buffer.subarray(0, boundary));
          // Keep the boundary line for line(), without its preceding CRLF.
          this.buffer = this.buffer.subarray(boundary + 2);
          return Buffer.concat(chunks, size);
        }
        const count = Math.max(0, this.buffer.length - delimiter.length - 2);
        append(this.buffer.subarray(0, count));
        this.buffer = this.buffer.subarray(count);
      }
      if (!await this.readMore()) {
        throw interrupted();
      }
    }
  }
}

export async function* readMjpeg(
  body: ReadableStream<Uint8Array>, contentType: string, maxBytes: number,
): AsyncGenerator<Buffer> {
  const match = /;\s*boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70 || !/^[\x20-\x7e]+$/.test(boundary) || boundary.endsWith(' ')) {
    throw new Error('Le flux MJPEG doit préciser une boundary multipart valide dans son Content-Type.');
  }
  const marker = `--${boundary}`;
  const delimiter = Buffer.from(`\r\n${marker}`, 'latin1');
  const reader = body.getReader();
  const input = new MultipartReader(reader);
  try {
    // A MIME preamble is allowed before the first boundary, but must stay bounded.
    let preambleSize = 0;
    let line: string;
    do {
      const preamble = await input.line(maxHeaderBytes - preambleSize, true);
      preambleSize += preamble.length + 2;
      line = preamble.trimEnd();
      if (preambleSize > maxHeaderBytes) {
        throw new Error('Le préambule du flux MJPEG est trop long.');
      }
    } while (line !== marker && line !== `${marker}--`);

    while (line !== `${marker}--`) {
      let headerSize = 0;
      const headers = new Map<string, string>();
      while (true) {
        const header = await input.line(maxHeaderBytes - headerSize);
        headerSize += header.length + 2;
        if (headerSize > maxHeaderBytes) {
          throw new Error('Les en-têtes du flux MJPEG sont trop longs.');
        }
        if (!header) {
          break;
        }
        const colon = header.indexOf(':');
        const key = header.slice(0, colon).trim().toLowerCase();
        if (colon <= 0 || headers.has(key)) {
          throw new Error('Les en-têtes du flux MJPEG sont invalides.');
        }
        headers.set(key, header.slice(colon + 1).trim());
      }
      const type = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type && type !== 'image/jpeg') {
        throw new Error('Le flux MJPEG doit contenir des images JPEG (Content-Type image/jpeg).');
      }
      const rawLength = headers.get('content-length');
      let length: number | undefined;
      if (rawLength !== undefined) {
        if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
          throw new Error('Le Content-Length d’une image du flux MJPEG est invalide.');
        }
        length = Number(rawLength);
        if (length > maxBytes) {
          throw tooLarge();
        }
      }
      const image = await input.frame(length, delimiter, maxBytes);
      if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8
        || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) {
        throw new Error('Le flux MJPEG contient une image JPEG vide ou invalide.');
      }
      yield image;
      if (length !== undefined) {
        // Consume the CRLF separating a length-delimited JPEG from its boundary.
        await input.line(0);
      }
      line = (await input.line(maxHeaderBytes, true)).trimEnd();
      if (line !== marker && line !== `${marker}--`) {
        throw interrupted();
      }
    }
  } finally {
    // Also closes a live response when the caller only needs the first frame.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
