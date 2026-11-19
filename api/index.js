'use strict';
// Vercel entry point. src/app.js exports the request handler itself (one app per function instance; the
// database is opened and migrated lazily inside the first request, so a cold start never fails at require time).
// vercel.json rewrites every path to this function (assets under /public/* included).
module.exports = require('../src/app');
