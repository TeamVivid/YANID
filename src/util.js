/*
 * YANID - Yet Another Non Intrusive Downloader
 * Copyright (C) 2026  TheErrorExe, zUnpaid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var $ = function (id) { return document.getElementById(id); };
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var enc = new TextEncoder();
var dec = new TextDecoder();

function fmtBytes(x) {
  if (!x || x < 0) return '0 MB';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)) + ' ' + u[i];
}
function fmtSize(x) { return x >= 10 * 1048576 ? Math.round(x / 1048576) + ' MB' : (x / 1048576).toFixed(1) + ' MB'; }
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
}
function parseTime(str) {
  str = String(str || '').trim();
  if (!str) return NaN;
  var p = str.split(':');
  if (p.length > 3) return NaN;
  var total = 0;
  for (var i = 0; i < p.length; i++) {
    if (!/^\d+(\.\d+)?$/.test(p[i])) return NaN;
    total = total * 60 + parseFloat(p[i]);
  }
  return total;
}
function sanitize(s) {
  return String(s || '').replace(/[\/\\?%*:|"<>\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
}

export { $, sleep, enc, dec, fmtBytes, fmtSize, fmtTime, parseTime, sanitize };
