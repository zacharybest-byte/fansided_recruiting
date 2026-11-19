'use strict';
// Minimal multipart/form-data parser for an already-buffered request body.
// Returns { fields: Map<name, string[]>, files: [{ field, filename, contentType, data }] }.

const MAX_PARTS = 200;

function getBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const b = (m[1] || m[2]).trim();
  return b.length > 0 && b.length <= 200 ? b : null;
}

function parseHeaderParams(value) {
  // e.g. form-data; name="file"; filename="cv.pdf"; filename*=UTF-8''cv%20x.pdf
  const params = {};
  const re = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  let m;
  while ((m = re.exec(value))) {
    const key = m[1].toLowerCase();
    let v = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].trim();
    if (key.endsWith('*')) {
      const ext = /^([^']*)'[^']*'(.*)$/.exec(v);
      if (ext) {
        try {
          v = decodeURIComponent(ext[2]);
        } catch {
          /* keep raw */
        }
      }
      params[key.slice(0, -1)] = v;
    } else if (!(key in params)) {
      params[key] = v;
    }
  }
  return params;
}

function parseMultipart(body, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) throw new Error('Missing multipart boundary');
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map();
  const files = [];

  let pos = body.indexOf(delimiter);
  if (pos < 0) throw new Error('Malformed multipart body');
  let parts = 0;
  while (true) {
    pos += delimiter.length;
    // "--" right after a delimiter marks the end.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    // Skip the CRLF after the delimiter.
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else throw new Error('Malformed multipart body');

    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) throw new Error('Malformed multipart body');
    const headerText = body.subarray(pos, headerEnd).toString('utf8');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headerEnd + 4);
    if (next < 0) throw new Error('Malformed multipart body');
    const data = body.subarray(headerEnd + 4, next);

    if (++parts > MAX_PARTS) throw new Error('Too many multipart parts');

    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const disposition = headers['content-disposition'] || '';
    const params = parseHeaderParams(disposition);
    const name = params.name;
    if (name !== undefined) {
      if (params.filename !== undefined) {
        files.push({
          field: name,
          filename: params.filename,
          contentType: headers['content-type'] || 'application/octet-stream',
          data: Buffer.from(data),
        });
      } else {
        if (!fields.has(name)) fields.set(name, []);
        fields.get(name).push(data.toString('utf8'));
      }
    }
    pos = next + 2; // position of the next delimiter
  }
  return { fields, files };
}

module.exports = { parseMultipart, getBoundary };
