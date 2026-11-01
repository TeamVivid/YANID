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

import { sleep } from './util.js';

var LS_KEY = 'yanid_settings';
var DEFAULTS = {
  instance: 'https://vivid.errexe.xyz', source: 'auto',
  type: 'video', vfmt: 'mp4', afmt: 'mp3', maxQ: 0, aq: 'best',
  vcodec: 'auto', acodec: 'auto', strict: false,
  thumb: true, meta: true, subs: false, subLang: 'en', subFmt: 'embed',
  pattern: '{title} [{id}] ({quality})', theme: 'ember', mode: 'basic'
};
var SETTING_IDS = {
  's-instance': 'instance', 's-source': 'source', 's-type': 'type', 's-maxq': 'maxQ',
  's-vfmt': 'vfmt', 's-afmt': 'afmt', 's-aq': 'aq', 's-vcodec': 'vcodec', 's-acodec': 'acodec',
  's-strict': 'strict', 's-thumb': 'thumb', 's-meta': 'meta', 's-subs': 'subs',
  's-sublang': 'subLang', 's-subfmt': 'subFmt', 's-pattern': 'pattern', 's-theme': 'theme'
};
var S = loadSettings();
function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }

function applyTheme() { document.documentElement.setAttribute('data-theme', S.theme); }

function base() {
  var u = String(S.instance || DEFAULTS.instance).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}
function API(path) { return base() + '/api/v1' + path; }
function proxyStream(url, title) {
  return API('/proxy/stream?url=' + encodeURIComponent(url) + (title ? '&title=' + encodeURIComponent(title) : ''));
}

async function getJson(url, signal) {
  for (var i = 0; ; i++) {
    try {
      var r = await fetch(url, { signal: signal });
      if (r.status === 403 && i < 2) { await sleep(400 * Math.pow(2, i)); continue; }
      if (!r.ok) { var er = new Error('API error ' + r.status); er.api = true; throw er; }
      return await r.json();
    } catch (e) {
      if (e.name === 'AbortError' || e.api || i >= 2) throw e;
      await sleep(400 * Math.pow(2, i));
    }
  }
}

function resetSettings() {
  Object.keys(S).forEach(function (k) { delete S[k]; });
  Object.assign(S, DEFAULTS);
}

export { LS_KEY, DEFAULTS, SETTING_IDS, S, saveSettings, resetSettings, applyTheme, base, API, proxyStream, getJson };
