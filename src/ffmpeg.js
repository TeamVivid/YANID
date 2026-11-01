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

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { enc } from './util.js';
import { LANG3 } from './subs.js';

var current = null;

async function getFF() {
  var ff = new FFmpeg();
  await ff.load({ coreURL: coreURL, wasmURL: wasmURL });
  return ff;
}
function terminateFF() {
  if (current) { try { current.terminate(); } catch (e) {} }
}

function buildArgs(o) {
  var a = [], n = 0, idx = {};
  var trimIn = o.trim ? ['-ss', String(o.trim.t0)] : [];
  if (o.hasV) { a.push.apply(a, trimIn.concat(['-i', 'v.in'])); idx.v = n++; }
  if (o.hasA) { a.push.apply(a, trimIn.concat(['-i', 'a.in'])); idx.a = n++; }
  if (o.sub) { a.push('-i', 's.srt'); idx.s = n++; }
  var coverInput = o.cover && (o.ext === 'mp4' || o.ext === 'm4a' || o.ext === 'mp3');
  var coverAttach = o.cover && o.ext === 'mkv';
  if (coverInput) { a.push('-i', 'cover.jpg'); idx.c = n++; }

  if (o.hasV) a.push('-map', idx.v + ':v:0');
  if (o.hasA) a.push('-map', idx.a + ':a:0');
  if (o.sub) a.push('-map', idx.s + ':0');
  if (coverInput) a.push('-map', idx.c + ':v:0');

  if (o.hasV || coverInput) a.push('-c:v', 'copy');
  if (o.hasA) {
    if (o.aMode === 'mp3') a.push('-c:a', 'libmp3lame', '-q:a', String(o.mp3q));
    else if (o.aMode === 'aac') a.push('-c:a', 'aac', '-b:a', '192k');
    else if (o.aMode === 'opus') a.push('-c:a', 'libopus', '-b:a', '160k');
    else a.push('-c:a', 'copy');
  }
  if (o.sub) {
    a.push('-c:s', o.ext === 'mp4' ? 'mov_text' : o.ext === 'webm' ? 'webvtt' : 'srt');
    a.push('-metadata:s:s:0', 'language=' + (LANG3[String(o.sub.lang).split('-')[0]] || 'und'));
  }
  if (coverInput && (o.ext === 'mp4' || o.ext === 'm4a')) a.push('-disposition:v:' + (o.hasV ? 1 : 0), 'attached_pic');
  if (coverInput && o.ext === 'mp3') {
    a.push('-id3v2_version', '3', '-metadata:s:v:0', 'title=Album cover', '-metadata:s:v:0', 'comment=Cover (front)');
  }
  if (coverAttach) a.push('-attach', 'cover.jpg', '-metadata:s:t:0', 'mimetype=image/jpeg', '-metadata:s:t:0', 'filename=cover.jpg');
  if (o.meta) Object.keys(o.meta).forEach(function (k) { if (o.meta[k]) a.push('-metadata', k + '=' + o.meta[k]); });
  if (o.trim) a.push('-t', String(o.trim.dur));
  if (o.ext === 'mp4' || o.ext === 'm4a') a.push('-movflags', '+faststart');
  a.push('out.' + o.ext);
  return a;
}

function makeVariants(o) {
  var dc = !!o.cover, ds = !!o.sub, list = [{ o: o, dropped: [] }];
  if (dc) list.push({ o: Object.assign({}, o, { cover: null }), dropped: ['thumbnail'] });
  if (ds) list.push({ o: Object.assign({}, o, { sub: null }), dropped: ['subtitles'] });
  if (dc && ds) list.push({ o: Object.assign({}, o, { cover: null, sub: null }), dropped: ['thumbnail', 'subtitles'] });
  if (o.meta) list.push({ o: Object.assign({}, o, { cover: null, sub: null, meta: null }), dropped: (dc ? ['thumbnail'] : []).concat(ds ? ['subtitles'] : [], ['metadata']) });
  return list;
}

var MIME = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', opus: 'audio/ogg' };

async function muxAll(o, onProgress) {
  var ff = await getFF();
  current = ff;
  var logs = [];
  ff.on('log', function (e) { logs.push(e.message); if (logs.length > 30) logs.shift(); });
  ff.on('progress', function (e) { onProgress(Math.min(1, Math.max(0, e.progress))); });
  try {
    async function put(name, blob) { await ff.writeFile(name, await fetchFile(blob)); }
    if (o.vBlob) await put('v.in', o.vBlob);
    if (o.aBlob) await put('a.in', o.aBlob);
    if (o.srt) await ff.writeFile('s.srt', enc.encode(o.srt));
    if (o.cover) await put('cover.jpg', o.cover);

    var variants = makeVariants(o), ok = null;
    for (var i = 0; i < variants.length; i++) {
      try { await ff.deleteFile('out.' + o.ext); } catch (e) {}
      var code = await ff.exec(buildArgs(variants[i].o));
      if (code === 0) { ok = variants[i]; break; }
    }
    if (!ok) throw new Error('Muxing to ' + o.ext.toUpperCase() + ' failed' + (logs.length ? ' (' + logs.slice(-2).join(' | ').slice(0, 200) + ')' : ''));
    var data = await ff.readFile('out.' + o.ext);
    return { blob: new Blob([data], { type: MIME[o.ext] }), dropped: ok.dropped };
  } finally {
    try { ff.terminate(); } catch (e) {}
    current = null;
  }
}

export { buildArgs, makeVariants, muxAll, terminateFF, MIME };
