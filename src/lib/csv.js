'use strict';
// RFC 4180 CSV writing with spreadsheet formula-injection protection.

const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { csvCell, toCsv };
