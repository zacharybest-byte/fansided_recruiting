'use strict';
// Vercel entry point. The app is created once per function instance; the database is opened and migrated
// lazily inside the first request, so a cold start never fails at require time.
// vercel.json rewrites every path to this function (assets under /public/* included).
const { createApp } = require('../src/app');

const app = createApp();

module.exports = (req, res) => app.handler(req, res);
