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

var LANG3 = { en: 'eng', de: 'deu', es: 'spa', fr: 'fra', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho', ar: 'ara', hi: 'hin', nl: 'nld', pl: 'pol', tr: 'tur', sv: 'swe', uk: 'ukr', id: 'ind', vi: 'vie', th: 'tha', cs: 'ces', el: 'ell', he: 'heb', hu: 'hun', ro: 'ron', da: 'dan', fi: 'fin', no: 'nor' };

function tsec(x) {
  var p = x.replace(',', '.').split(':').map(Number);
  var h = p.length === 3 ? p[0] : 0;
  return h * 3600 + p[p.length - 2] * 60 + p[p.length - 1];
}
function parseVtt(text) {
  var cues = [];
  var blocks = String(text || '').replace(/\r/g, '').replace(/^\uFEFF/, '').split(/\n\n+/);
  blocks.forEach(function (b) {
    var lines = b.split('\n');
    var i = lines.findIndex(function (l) { return l.indexOf('-->') >= 0; });
    if (i < 0) return;
    var m = lines[i].match(/((?:\d+:)?\d+:\d+[.,]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[.,]\d+)/);
    if (!m) return;
    var t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    if (!t) return;
    cues.push({ s: tsec(m[1]), e: tsec(m[2]), t: t });
  });
  return cues;
}
function clipCues(cues, t0, t1) {
  return cues.filter(function (c) { return c.e > t0 && c.s < t1; }).map(function (c) {
    return { s: Math.max(c.s, t0) - t0, e: Math.min(c.e, t1) - t0, t: c.t };
  });
}
function stamp(sec, sep) {
  var ms = Math.round(sec * 1000);
  var h = Math.floor(ms / 3600000); ms -= h * 3600000;
  var m = Math.floor(ms / 60000); ms -= m * 60000;
  var s = Math.floor(ms / 1000); ms -= s * 1000;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + sep + String(ms).padStart(3, '0');
}
function toSrt(cues) { return cues.map(function (c, i) { return (i + 1) + '\n' + stamp(c.s, ',') + ' --> ' + stamp(c.e, ',') + '\n' + c.t + '\n'; }).join('\n'); }
function toVtt(cues) { return 'WEBVTT\n\n' + cues.map(function (c) { return stamp(c.s, '.') + ' --> ' + stamp(c.e, '.') + '\n' + c.t + '\n'; }).join('\n'); }

export { LANG3, tsec, parseVtt, clipCues, stamp, toSrt, toVtt };
