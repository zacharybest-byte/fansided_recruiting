'use strict';
// Regenerates src/lib/assets.generated.js from public/: style.css, app.js and favicon.svg as text, and the binary
// files (logo.png, fonts/*.woff2, fonts/*.ttf) as base64 under the "__binary" key.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const out = {};
for (const name of ['style.css', 'app.js', 'favicon.svg']) out[name] = fs.readFileSync(path.join(pub, name), 'utf8');
const binary = {};
const BINARY_FILES = ['logo.png'];
const fontDir = path.join(pub, 'fonts');
if (fs.existsSync(fontDir)) {
  for (const f of fs.readdirSync(fontDir).sort()) if (/\.(woff2|ttf)$/.test(f)) BINARY_FILES.push(`fonts/${f}`);
}
for (const name of BINARY_FILES) binary[name] = fs.readFileSync(path.join(pub, name)).toString('base64');
out.__binary = binary;
fs.writeFileSync(
  path.join(root, 'src', 'lib', 'assets.generated.js'),
  "'use strict';\n// GENERATED copy of the files in public/ (test/vercel.test.js fails if it is out of date;\n// regenerate with: node scripts/embed-assets.js). Used when the files are not bundled with the function.\n// Text files are strings; __binary holds base64 for the logo and fonts.\nmodule.exports = " + JSON.stringify(out, null, 0) + ';\n',
);
