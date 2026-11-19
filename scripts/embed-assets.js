'use strict';
// Regenerates src/lib/assets.generated.js from public/style.css and public/app.js.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const out = {};
for (const name of ['style.css', 'app.js']) out[name] = fs.readFileSync(path.join(root, 'public', name), 'utf8');
fs.writeFileSync(
  path.join(root, 'src', 'lib', 'assets.generated.js'),
  "'use strict';\n// GENERATED copy of public/style.css and public/app.js (test/vercel.test.js fails if it is out of date;\n// regenerate with: node scripts/embed-assets.js). Used when the files are not bundled with the function.\nmodule.exports = " + JSON.stringify(out, null, 0) + ';\n',
);
