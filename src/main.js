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

import './style.css';
import { $, sleep, enc, dec, fmtBytes, fmtSize, fmtTime, parseTime, sanitize } from './util.js';
import { DEFAULTS, SETTING_IDS, S, saveSettings, resetSettings, applyTheme, base, API, proxyStream, getJson } from './settings.js';
import { parseVtt, clipCues, toSrt, toVtt } from './subs.js';
import { buildArgs, makeVariants, muxAll, terminateFF } from './ffmpeg.js';
import { fetchStreamBlob } from './stream.js';
import { SabrDownloader } from './sabr.js';


var CN = { h264: 'H.264', vp9: 'VP9', av1: 'AV1', h265: 'H.265', aac: 'AAC', opus: 'Opus', ac3: 'AC-3', vorbis: 'Vorbis', other: '?' };
function vc(s) {
  var m = String(s.mimeType || '').toLowerCase();
  if (/avc1|h264/.test(m)) return 'h264';
  if (/av01/.test(m)) return 'av1';
  if (/vp0?9/.test(m)) return 'vp9';
  if (/hev1|hvc1|hevc/.test(m)) return 'h265';
  return 'other';
}
function ac(s) {
  var m = String(s.mimeType || '').toLowerCase();
  if (/mp4a|aac/.test(m)) return 'aac';
  if (/opus/.test(m)) return 'opus';
  if (/ec-3|ac-3/.test(m)) return 'ac3';
  if (/vorbis/.test(m)) return 'vorbis';
  return 'other';
}
function box(s) {
  var m = String(s.mimeType || '').toLowerCase().split(';')[0];
  if (/webm/.test(m)) return 'webm';
  if (/mp4|m4a/.test(m)) return 'mp4';
  return '';
}
function heightOf(v) { return v.height || parseInt(v.qualityLabel, 10) || 0; }
function streamBytes(s) {
  if (!s) return 0;
  var n = Number(s.contentLength);
  if (n > 0) return n;
  return V && V.dur && s.bitrate ? Math.round(s.bitrate * V.dur / 8) : 0;
}


var V = null;
var Q = [];
var plan = null;
var running = false;
var ctrl = null;
var curFF = null;
var curSabr = null;

function srcOrder() {
  if (S.source === 'sabr') return ['sabr'];
  if (S.source === 'direct') return ['direct'];
  return ['direct', 'sabr'];
}
function dataOf(src) { return V ? (src === 'direct' ? V.direct : V.sabr) : null; }

function byQuality(pool, key) {
  var sorted = pool.slice().sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
  var n = sorted.length;
  if (!n) return null;
  var idx = { best: 0, high: Math.round((n - 1) / 3), medium: Math.round((n - 1) * 2 / 3), low: n - 1 }[key];
  return sorted[idx == null ? 0 : idx];
}

function pickAudio(src, fmt, aqKey, kind) {
  var d = dataOf(src);
  if (!d) return null;
  var pool = d.audioStreams.slice();
  var tr = $('track').value;
  if (tr) pool = pool.filter(function (a) { return (a.audioTrackId || '') === tr; });
  else {
    var def = pool.filter(function (a) { return a.isDefault; });
    var org = pool.filter(function (a) { return a.isOriginal; });
    pool = def.length ? def : (org.length ? org : pool);
  }
  var want = null;
  if (kind === 'video') want = fmt === 'mp4' ? 'mp4' : fmt === 'webm' ? 'webm' : null;
  else want = fmt === 'm4a' ? 'mp4' : fmt === 'opus' ? 'webm' : null;
  if (want) {
    var f = pool.filter(function (a) { return box(a) === want; });
    if (f.length) pool = f;
    else if (kind === 'video' && fmt === 'webm') return null;
  }
  if (S.acodec !== 'auto' && (kind === 'video' || fmt === 'mp3')) {
    var g = pool.filter(function (a) { return ac(a) === S.acodec; });
    if (g.length) pool = g;
  }
  return byQuality(pool, aqKey);
}

function fitsVideo(v, fmt) { return fmt === 'mkv' ? true : box(v) === fmt; }

function codecRank(c) {
  if (S.vcodec !== 'auto' && c === S.vcodec) return -1;
  return ['h264', 'vp9', 'av1', 'h265', 'other'].indexOf(c);
}
function better(x, y) {
  if (!!x.a !== !!y.a) return !!x.a;
  var rx = codecRank(x.c), ry = codecRank(y.c);
  if (rx !== ry) return rx < ry;
  if (x.si !== y.si) return x.si < y.si;
  return (x.v.bitrate || 0) > (y.v.bitrate || 0);
}

function buildVideoList(fmt) {
  var cand = [];
  srcOrder().forEach(function (src, si) {
    var d = dataOf(src);
    if (!d) return;
    var a = pickAudio(src, fmt, $('aq').value, 'video');
    d.videoStreams.forEach(function (v) {
      if (!fitsVideo(v, fmt)) return;
      var c = vc(v);
      if (S.vcodec !== 'auto' && S.strict && c !== S.vcodec) return;
      cand.push({ src: src, si: si, v: v, a: a, c: c, h: heightOf(v), key: v.qualityLabel || (heightOf(v) + 'p') });
    });
  });
  var map = new Map();
  cand.forEach(function (x) {
    var cur = map.get(x.key);
    if (!cur || better(x, cur)) map.set(x.key, x);
  });
  return Array.from(map.values()).sort(function (a, b) { return (b.h - a.h) || ((b.v.fps || 0) - (a.v.fps || 0)); });
}

function makePlan() {
  var type = $('type').value, fmt = $('fmt').value;
  if (type === 'video') {
    var it = Q.find(function (x) { return x.key === $('q').value; }) || Q[0];
    if (!it) return null;
    return { type: 'video', fmt: fmt, ext: fmt, src: it.src, v: it.v, a: it.a, label: it.key, codec: it.c };
  }
  var order = srcOrder();
  for (var i = 0; i < order.length; i++) {
    var a = pickAudio(order[i], fmt, $('aq').value, 'audio');
    if (a) return { type: 'audio', fmt: fmt, ext: fmt, src: order[i], v: null, a: a, label: 'Audio', codec: ac(a) };
  }
  return null;
}

var MP3_KBPS = { best: 245, high: 190, medium: 165, low: 115 };
var MP3_Q = { best: 2, high: 3, medium: 4, low: 6 };

function estimate() {
  if (!plan || !V) return 0;
  var est;
  if (plan.type === 'video') est = streamBytes(plan.v) + streamBytes(plan.a);
  else if (plan.fmt === 'mp3') est = (V.dur || 0) * MP3_KBPS[$('aq').value] * 125;
  else est = streamBytes(plan.a);
  if ($('trim').checked && V.dur) {
    var a = parseTime($('t1').value), b = parseTime($('t2').value);
    if (b > a && a >= 0) est *= Math.min(1, (b - a) / V.dur);
  }
  return est;
}

function dateFromText(t) {
  if (!t) return '';
  var d = new Date(String(t).replace(/^(premiered|streamed live on|published on|uploaded on|started streaming on)\s*/i, ''));
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fileBase() {
  var title = sanitize($('fn').value) || sanitize(V.title) || 'video';
  var p = plan || {};
  var name = String(S.pattern || DEFAULTS.pattern)
    .replace(/\{title\}/g, title)
    .replace(/\{id\}/g, V.id)
    .replace(/\{quality\}/g, p.label || '')
    .replace(/\{author\}/g, sanitize(V.author))
    .replace(/\{codec\}/g, CN[p.codec] || '');
  return sanitize(name) || 'video';
}

async function fetchSubCues(optValue, signal) {
  var caps = V.caps, baseUrl, tlang = '';
  if (optValue.indexOf('b:') === 0) baseUrl = caps.baseLanguages[Number(optValue.slice(2))].baseUrl;
  else {
    var src = caps.baseLanguages.find(function (b) { return b.isTranslatable; }) || caps.baseLanguages[0];
    baseUrl = src.baseUrl; tlang = optValue.slice(2);
  }
  var url = API('/proxy/captions?url=' + encodeURIComponent(baseUrl) + (tlang ? '&tlang=' + encodeURIComponent(tlang) : ''));
  var r = await fetch(url, { signal: signal });
  if (!r.ok) throw new Error('Subtitle request failed (' + r.status + ')');
  var cues = parseVtt(await r.text());
  if (!cues.length) throw new Error('Subtitle track is empty');
  return cues;
}

function parseId(u) {
  u = String(u || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(u)) return u;
  var m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function showErr(t) { var e = $('err'); e.textContent = t; e.style.display = t ? 'block' : 'none'; }
function msg(text, cls) { var m = $('dmsg'); m.className = 'smsg' + (cls ? ' ' + cls : ''); m.textContent = text; m.style.display = text ? 'block' : 'none'; }

function normDirect(d) {
  if (!d || d.error) return null;
  var vs = (d.videoStreams || []).filter(function (s) { return s.url && !s.isSabr; });
  var as = (d.audioStreams || []).filter(function (s) { return s.url && !s.isSabr; });
  var cs = (d.combinedStreams || []).filter(function (s) { return s.url; });
  if (!vs.length && !as.length) return null;
  return { videoStreams: vs, audioStreams: as, combinedStreams: cs };
}
function normSabr(d) {
  if (!d || d.error || !d.sabr || !d.sabr.available) return null;
  var vs = (d.videoStreams || []).filter(function (s) { return s.itag; });
  var as = (d.audioStreams || []).filter(function (s) { return s.itag; });
  if (!vs.length && !as.length) return null;
  return { info: Object.assign({}, d.sabr), videoStreams: vs, audioStreams: as };
}

async function analyze(forceId) {
  showErr('');
  $('panel').style.display = 'none';
  var id = forceId || parseId($('url').value);
  if (!id) { showErr('That doesn\u2019t look like a valid YouTube link.'); return; }
  $('loading').style.display = 'flex'; $('go').disabled = true;
  var want = { direct: S.source !== 'sabr', sabr: S.source !== 'direct' };
  var none = Promise.resolve(null);
  var ok = function (v) { return { status: 'fulfilled', value: v }; };
  var res = null;
  try {
    var full = await getJson(API('/fullvideo/' + id + (want.sabr ? '?include_and_try_sabr=true' : '')));
    var fs = full && !full.error && full.streams && typeof full.streams === 'object' ? full.streams : null;
    if (fs && (normDirect(fs) || normSabr(fs))) {
      var extra = null;
      if (want.direct && !normDirect(fs)) { try { extra = await getJson(API('/streams/' + id)); } catch (e) {} }
      res = [ok(full.video || {}), ok(want.direct ? (normDirect(fs) ? fs : extra) : null), ok(want.sabr ? fs : null), ok(full.captions || {})];
    }
  } catch (e) {}
  if (!res) res = await Promise.allSettled([
    getJson(API('/videos/' + id)),
    want.direct ? getJson(API('/streams/' + id)) : none,
    want.sabr ? getJson(API('/streams/' + id + '?include_and_try_sabr=true')) : none,
    getJson(API('/captions/' + id))
  ]);
  $('loading').style.display = 'none'; $('go').disabled = false;
  var det = res[0], dir = res[1], sab = res[2], cap = res[3];

  var ds = dir.status === 'fulfilled' ? dir.value : null;
  var ss = sab.status === 'fulfilled' ? sab.value : null;
  if (!ds && !ss && (dir.status === 'rejected' || sab.status === 'rejected')) {
    var why = (dir.reason || sab.reason || {}).message || 'unknown error';
    showErr('Could not get streams from ' + base() + ' (' + why + '). Check the instance in Settings.');
    return;
  }
  var direct = normDirect(ds), sabr = normSabr(ss);
  if (!direct && !sabr) {
    var live = (ds && ds.isLivestream) || (ss && ss.isLivestream);
    var reason = live ? 'Livestreams can\u2019t be downloaded.' : ((ds && (ds.playabilityReason || ds.error)) || (ss && (ss.playabilityReason || ss.error)) || 'No downloadable streams found for this video.');
    showErr(reason);
    return;
  }
  var d = det.status === 'fulfilled' && det.value ? det.value : {};
  var any = ds || ss || {};
  var dur = Number(any.duration) > 0 ? Math.round(any.duration / 1000) : 0;
  if (!dur && typeof d.duration === 'number') dur = d.duration;
  if (!dur && typeof d.duration === 'string') dur = parseTime(d.duration) || 0;
  var cv = cap.status === 'fulfilled' && cap.value ? cap.value : {};
  V = {
    id: id,
    title: d.title || ('YouTube video ' + id),
    author: (d.author && typeof d.author === 'object' ? d.author.name : d.author) || '',
    views: d.views || '', publishDate: d.publishDate || '',
    thumb: d.thumbnailUrl || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
    dur: dur, direct: direct, sabr: sabr,
    tried: { direct: want.direct, sabr: want.sabr },
    caps: { baseLanguages: (cv.baseLanguages || []).filter(function (b) { return b.baseUrl; }), translationLanguages: cv.translationLanguages || [] }
  };

  $('vtitle').textContent = V.title;
  $('vauthor').textContent = V.author;
  $('vmeta').textContent = [V.views, V.publishDate].filter(Boolean).join(' · ');
  $('vdur').textContent = dur ? fmtTime(dur) : '';
  var img = $('vimg');
  img.style.display = 'none';
  img.onload = function () { img.style.display = 'block'; };
  img.onerror = function () { img.style.display = 'none'; };
  img.src = API('/proxy/image?url=' + encodeURIComponent('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'));

  toConfig();
  initControls();
  showTab('dl');
  msg('');
  $('panel').style.display = 'block';
  $('panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

var VFMTS = [['mkv', 'MKV'], ['mp4', 'MP4'], ['webm', 'WebM']];
var AFMTS = [['mp3', 'MP3'], ['m4a', 'M4A (AAC)'], ['opus', 'Opus']];

function fillSelect(sel, items, value) {
  sel.innerHTML = '';
  items.forEach(function (it) { var o = document.createElement('option'); o.value = it[0]; o.textContent = it[1]; sel.appendChild(o); });
  if (value != null && items.some(function (i) { return i[0] === value; })) sel.value = value;
}
function fillFormats(useDefault) {
  var audio = $('type').value === 'audio';
  var items = audio ? AFMTS : VFMTS;
  var prev = $('fmt').value;
  var want = useDefault || !items.some(function (i) { return i[0] === prev; }) ? (audio ? S.afmt : S.vfmt) : prev;
  fillSelect($('fmt'), items, want);
}
function fillTracks() {
  var seen = new Map();
  ['direct', 'sabr'].forEach(function (src) {
    var d = dataOf(src);
    if (d) d.audioStreams.forEach(function (a) { var id = a.audioTrackId || ''; if (id && !seen.has(id)) seen.set(id, a.displayName || id); });
  });
  var f = $('trackf');
  if (seen.size > 1) {
    var items = [['', 'Default / original']];
    seen.forEach(function (name, id) { items.push([id, name]); });
    fillSelect($('track'), items, '');
    f.classList.remove('hidden');
  } else {
    fillSelect($('track'), [['', 'Default']], '');
    f.classList.add('hidden');
  }
}
function fillQualities() {
  Q = $('type').value === 'video' ? buildVideoList($('fmt').value) : [];
  var sel = $('q'), prev = sel.value;
  sel.innerHTML = '';
  Q.forEach(function (it) {
    var o = document.createElement('option');
    o.value = it.key; o.textContent = it.key + ' \u00b7 ' + (CN[it.c] || it.c);
    sel.appendChild(o);
  });
  var pick = Q.find(function (x) { return x.key === prev; });
  if (!pick && Q.length) {
    var lim = Number(S.maxQ) || 0;
    pick = lim ? (Q.find(function (x) { return x.h <= lim; }) || Q[Q.length - 1]) : Q[0];
  }
  if (pick) sel.value = pick.key;
}
function fillAudioLabels() {
  var kind = $('type').value === 'video' ? 'video' : 'audio', fmt = $('fmt').value;
  var order = srcOrder();
  ['best', 'high', 'medium', 'low'].forEach(function (k) {
    var a = null;
    for (var i = 0; i < order.length && !a; i++) a = pickAudio(order[i], fmt, k, kind);
    var opt = $('aq').querySelector('option[value="' + k + '"]');
    var name = k.charAt(0).toUpperCase() + k.slice(1);
    opt.textContent = a && a.bitrate ? name + ' (\u2248' + Math.round(a.bitrate / 1000) + ' kbps)' : name;
  });
}
function fillSubs() {
  var sel = $('sublang'), items = [];
  V.caps.baseLanguages.forEach(function (b, i) { items.push({ v: 'b:' + i, t: b.name || b.languageCode, code: b.languageCode, g: 'Available' }); });
  if (V.caps.baseLanguages.some(function (b) { return b.isTranslatable; })) {
    V.caps.translationLanguages.forEach(function (t) { items.push({ v: 't:' + t.languageCode, t: t.name || t.languageCode, code: t.languageCode, g: 'Auto-translate' }); });
  }
  sel.innerHTML = '';
  var groups = {};
  items.forEach(function (it) {
    var g = groups[it.g];
    if (!g) { g = groups[it.g] = document.createElement('optgroup'); g.label = it.g; sel.appendChild(g); }
    var o = document.createElement('option'); o.value = it.v; o.textContent = it.t; g.appendChild(o);
  });
  var pref = items.find(function (i) { return i.g === 'Available' && String(i.code).toLowerCase().split('-')[0] === S.subLang; })
    || items.find(function (i) { return String(i.code).toLowerCase().split('-')[0] === S.subLang; })
    || items[0];
  if (pref) sel.value = pref.v;
  var has = items.length > 0;
  $('subs').disabled = !has;
  $('subs').checked = has && S.subs;
  $('subsnote').textContent = has ? 'Embed a subtitle track or save it as a file' : 'No subtitles available for this video';
  $('subfmt').value = S.subFmt;
}
function initControls() {
  $('type').value = S.type;
  fillTracks();
  fillFormats(true);
  $('aq').value = S.aq;
  fillAudioLabels();
  fillQualities();
  fillSubs();
  $('trim').checked = false;
  $('t1').value = '0:00'; $('t2').value = V.dur ? fmtTime(V.dur) : '';
  $('thumb').checked = S.thumb; $('meta').checked = S.meta;
  $('fn').value = sanitize(V.title);
  conditional();
  refresh();
}
function conditional() {
  var audio = $('type').value === 'audio';
  $('qf').style.display = audio ? 'none' : 'block';
  var ext = $('fmt').value;
  var thumbOk = ['mp4', 'mkv', 'mp3', 'm4a'].indexOf(ext) >= 0;
  $('thumb').disabled = !thumbOk;
  $('thumbnote').textContent = thumbOk ? 'Use the cover as file artwork' : 'Not supported for ' + (ext === 'webm' ? 'WebM' : 'Opus') + ' files';
  var embedOpt = $('subfmt').querySelector('option[value="embed"]');
  embedOpt.disabled = audio;
  if (audio && $('subfmt').value === 'embed') $('subfmt').value = 'srt';
  $('sublang').disabled = $('subfmt').disabled = !$('subs').checked || $('subs').disabled;
  $('t1').disabled = $('t2').disabled = !$('trim').checked;
}
function renderBasic() {
  var audio = $('type').value === 'audio';
  [].forEach.call($('btype').children, function (b) { b.classList.toggle('active', b.dataset.v === $('type').value); });
  $('bqwrap').style.display = audio ? 'none' : 'block';
  var bq = $('bq'); bq.innerHTML = '';
  if (!audio) Q.forEach(function (it) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (it.key === $('q').value ? ' active' : ''); b.textContent = it.key;
    b.onclick = function () { $('q').value = it.key; refresh(); };
    bq.appendChild(b);
  });
  var f = $('fmt').value.toUpperCase();
  $('bsum').textContent = audio ? 'Audio as ' + f : (Q.length && $('q').value ? $('q').value + ' as ' + f : '');
}
function refresh() {
  renderBasic();
  plan = makePlan();
  $('start').disabled = !plan;
  var info = $('pickinfo');
  if (!plan) {
    info.textContent = $('type').value === 'video' ? 'No streams available for this format' + (S.vcodec !== 'auto' && S.strict ? ' and codec' : '') + '. Try another format.' : 'No audio stream available for this format.';
    info.classList.add('warn');
    $('size').textContent = '–';
    $('fnprev').textContent = '';
    $('direct').classList.add('hidden');
    return;
  }
  info.classList.remove('warn');
  var bits = [];
  if (plan.v) bits.push(CN[vc(plan.v)] || '?');
  if (plan.a) bits.push(CN[ac(plan.a)] || '?');
  var txt = bits.join(' + ') + ' \u00b7 ' + (plan.src === 'sabr' ? 'SABR' : 'direct stream');
  if (plan.type === 'video' && !plan.a) { txt += ' \u00b7 no compatible audio stream'; info.classList.add('warn'); }
  if (plan.type === 'video' && S.vcodec !== 'auto' && vc(plan.v) !== S.vcodec) txt += ' \u00b7 preferred codec unavailable at this quality';
  info.textContent = txt;
  var e = estimate();
  $('size').textContent = e ? '\u2248 ' + fmtSize(e) : '–';
  $('fnprev').textContent = 'Saved as: ' + fileBase() + '.' + plan.ext;
  var comb = V.direct && V.direct.combinedStreams && (V.direct.combinedStreams.find(function (s) { return s.itag === 18; }) || V.direct.combinedStreams[0]);
  var is360 = plan.type === 'video' && plan.v && heightOf(plan.v) === 360;
  $('direct').classList.toggle('hidden', !(comb && plan.type === 'video' && plan.fmt === 'mp4' && is360));
  if (comb) $('direct').textContent = 'Direct Download (' + (comb.qualityLabel || (comb.height + 'p')) + ')';
}

function applyMode() {
  var adv = S.mode === 'advanced';
  $('cfg').classList.toggle('basic', !adv);
  [].forEach.call($('modetog').children, function (b) { b.classList.toggle('active', (b.dataset.m === 'advanced') === adv); });
  if (!adv) showTab('dl');
}
function showTab(t) {
  [].forEach.call($('tabs').children, function (b) { b.classList.toggle('active', b.dataset.t === t); });
  ['dl', 'subs', 'trim', 'out'].forEach(function (n) { $('pane-' + n).classList.toggle('active', n === t); });
}
function toConfig() { $('run').style.display = 'none'; $('cfg').style.display = 'block'; }

function setP(pct, label, o) {
  $('pbar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  $('ppct').textContent = Math.round(pct) + '%';
  if (label) $('plabel').textContent = label;
  if (o) {
    if (o.bytes != null) $('s-mb').textContent = fmtBytes(o.bytes);
    if (o.speed != null) $('s-sp').textContent = o.speed;
    if (o.eta != null) $('s-eta').textContent = o.eta;
  }
}
function triggerSave(blob, filename) {
  var url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

async function startDownload() {
  if (running || !plan) return;
  var p = plan;
  var trimOn = $('trim').checked, t0 = 0, t1 = V.dur || Infinity;
  if (trimOn) {
    t0 = parseTime($('t1').value); t1 = parseTime($('t2').value);
    if (!(t0 >= 0) || !(t1 > t0) || (V.dur && t1 > V.dur + 1)) { msg('Invalid trim range. Use m:ss or h:mm:ss within the video length.', 'err'); showTab('trim'); return; }
    if (V.dur && t1 > V.dur) t1 = V.dur;
  }
  var trimmed = trimOn && !(t0 <= 0.5 && V.dur && t1 >= V.dur - 0.5);
  var subsOn = $('subs').checked && !$('subs').disabled;
  var subFmt = $('subfmt').value;
  var coverOn = $('thumb').checked && !$('thumb').disabled;
  var metaOn = $('meta').checked;
  var filename = fileBase() + '.' + p.ext;

  running = true; ctrl = new AbortController();
  var signal = ctrl.signal, notes = [];
  $('cfg').style.display = 'none'; $('run').style.display = 'block';
  $('cancel').style.display = 'inline-flex'; $('done').style.display = 'none';
  var sm = $('smsg'); sm.style.display = 'none'; sm.className = 'smsg';
  $('s-mb').textContent = '0 MB'; $('s-sp').textContent = '–'; $('s-eta').textContent = '–';
  setP(0, 'Fetching stream info...');

  try {
    var cues = null, cover = null;
    if (subsOn) {
      try { cues = await fetchSubCues($('sublang').value, signal); }
      catch (e) { if (e.name === 'AbortError') throw e; notes.push('Subtitles unavailable (' + e.message + ')'); subsOn = false; }
    }
    if (coverOn) {
      try {
        var urls = ['maxresdefault', 'hqdefault'];
        for (var i = 0; i < urls.length && !cover; i++) {
          var r = await fetch(API('/proxy/image?url=' + encodeURIComponent('https://i.ytimg.com/vi/' + V.id + '/' + urls[i] + '.jpg')), { signal: signal });
          if (r.ok) { var b = await r.blob(); if (b.size > 2000) cover = b; }
        }
        if (!cover) notes.push('Thumbnail could not be downloaded');
      } catch (e) { if (e.name === 'AbortError') throw e; notes.push('Thumbnail could not be downloaded'); }
    }

    var dlStart = Date.now(), vBlob = null, aBlob = null;
    var progress = function (bytes, pct, label) {
      var el = (Date.now() - dlStart) / 1000;
      setP(pct * 0.85, label, {
        bytes: bytes,
        speed: el > 0.5 ? fmtBytes(bytes / el) + '/s' : '–',
        eta: pct > 2 && el > 1 ? fmtTime(el / pct * (100 - pct)) : '–'
      });
    };
    if (p.src === 'direct') {
      var vB = 0, aB = 0, vT = streamBytes(p.v), aT = streamBytes(p.a);
      var upd = function () {
        var exp = (vT || 0) + (aT || 0), got = vB + aB;
        progress(got, exp > 0 ? Math.min(100, got / exp * 100) : 0, p.v && p.a ? 'Downloading video & audio streams...' : p.v ? 'Downloading video stream...' : 'Downloading audio track...');
      };
      var pv = p.v ? fetchStreamBlob(proxyStream(p.v.url), vT, function (r, t) { vB = r; if (t > 0) vT = t; upd(); }, signal) : Promise.resolve(null);
      var pa = p.a ? fetchStreamBlob(proxyStream(p.a.url), aT, function (r, t) { aB = r; if (t > 0) aT = t; upd(); }, signal) : Promise.resolve(null);
      var got2 = await Promise.all([pv, pa]);
      vBlob = got2[0]; aBlob = got2[1];
    } else {
      var sd = new SabrDownloader({ videoId: V.id, sabrInfo: Object.assign({}, V.sabr.info, { videoId: V.id }), videoFmt: p.v ? Object.assign({}, p.v) : null, audioFmt: p.a ? Object.assign({}, p.a) : null, durationS: V.dur });
      curSabr = sd;
      var out = await sd.download(function (pr) { progress(pr.bytes, pr.percent, 'Downloading streams via SABR...'); }, signal);
      vBlob = out.videoBlob; aBlob = out.audioBlob;
      curSabr = null;
    }
    if (!vBlob && !aBlob) throw new Error('No media data received');

    setP(85, 'Loading ffmpeg (first run downloads ~30 MB)...', { speed: '–', eta: '–' });
    var aMode = 'copy';
    if (p.ext === 'mp3') aMode = 'mp3';
    else if (p.ext === 'm4a' && ac(p.a) !== 'aac') aMode = 'aac';
    else if (p.ext === 'opus' && ac(p.a) !== 'opus') aMode = 'opus';
    var mergeLabel = p.type === 'audio' ? 'Converting to ' + p.ext.toUpperCase() + ' in browser...' : 'Merging streams into ' + p.ext.toUpperCase() + ' in browser...';
    var srt = null, subLang = '';
    var subFile = null;
    if (subsOn && cues) {
      var use = trimmed ? clipCues(cues, t0, t1) : cues;
      if (use.length) {
        var sv = $('sublang').value;
        subLang = sv.indexOf('b:') === 0 ? ((V.caps.baseLanguages[Number(sv.slice(2))] || {}).languageCode || '') : sv.slice(2);
        if (subFmt === 'embed') srt = toSrt(use);
        else subFile = { text: subFmt === 'srt' ? toSrt(use) : toVtt(use), ext: subFmt };
      } else notes.push('No subtitle lines inside the trimmed range');
    }
    var meta = null;
    if (metaOn) {
      meta = { title: V.title, artist: V.author, date: dateFromText(V.publishDate), comment: 'https://www.youtube.com/watch?v=' + V.id };
    }
    var res = await muxAll({
      ext: p.ext, type: p.type, hasV: !!vBlob, hasA: !!aBlob, aMode: aMode, mp3q: MP3_Q[$('aq').value],
      trim: trimmed ? { t0: t0, dur: t1 - t0 } : null,
      sub: srt ? { lang: subLang } : null, meta: meta,
      vBlob: vBlob, aBlob: aBlob, srt: srt, cover: cover
    }, function (r) { setP(87 + r * 12, mergeLabel, { speed: 'Muxing...', eta: '–' }); });
    if (res.dropped.length) notes.push('Could not include: ' + res.dropped.join(', '));

    triggerSave(res.blob, filename);
    if (subFile) { await sleep(400); triggerSave(new Blob([subFile.text], { type: 'text/plain;charset=utf-8' }), fileBase() + (subLang ? '.' + subLang : '') + '.' + subFile.ext); }

    setP(100, 'Complete!', { bytes: res.blob.size, speed: '–', eta: '0 s' });
    sm.className = 'smsg ok';
    sm.textContent = 'Saved ' + filename + ' (' + fmtBytes(res.blob.size) + ').' + (notes.length ? ' ' + notes.join('. ') + '.' : '');
    sm.style.display = 'block';
    $('cancel').style.display = 'none'; $('done').style.display = 'inline-flex';
  } catch (err) {
    var cancelled = err && (err.name === 'AbortError' || signal.aborted);
    toConfig();
    msg(cancelled ? 'Download cancelled.' : 'Download error: ' + (err && err.message ? err.message : err), cancelled ? '' : 'err');
  } finally {
    running = false; curSabr = null;
  }
}

function cancelDownload() {
  if (ctrl) ctrl.abort();
  if (curSabr) curSabr.cancel();
  terminateFF();
}

function syncSettingsUI() {
  Object.keys(SETTING_IDS).forEach(function (id) {
    var el = $(id), key = SETTING_IDS[id];
    if (el.type === 'checkbox') el.checked = !!S[key]; else el.value = S[key];
  });
}
var savedTimer = null;
function flashSaved() {
  var el = $('s-saved'); el.textContent = 'Saved.';
  clearTimeout(savedTimer); savedTimer = setTimeout(function () { el.textContent = ''; }, 1200);
}
function onSettingChanged(key) {
  saveSettings(); flashSaved();
  if (key === 'theme') { applyTheme(); return; }
  if (key === 'instance') { $('s-testres').textContent = ''; }
  if (!V || running) return;
  if (key === 'instance') return;
  if (key === 'pattern') { refresh(); return; }
  if (key === 'source') {
    var needD = S.source !== 'sabr' && !V.tried.direct, needS = S.source !== 'direct' && !V.tried.sabr;
    if (needD || needS) { analyze(V.id); return; }
  }
  initControls();
}
async function testInstance() {
  var out = $('s-testres'); out.className = 'test-res'; out.textContent = 'Testing…';
  try {
    var r = await fetch(API(''), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    out.className = 'test-res ok';
    out.textContent = 'Connected: ' + (j.name || 'Vivid API') + (j.version ? ' ' + j.version : '');
  } catch (e) {
    out.className = 'test-res bad';
    out.textContent = 'Could not reach ' + base() + ' (' + (e.message || 'network error') + ')';
  }
}
function openSettings() { syncSettingsUI(); $('settings').classList.add('open'); }
function closeSettings() { $('settings').classList.remove('open'); }

applyTheme();

$('theme').onclick = function () {
  var themes = ['ember', 'midnight', 'forest', 'paper'];
  S.theme = themes[(themes.indexOf(S.theme) + 1) % themes.length];
  saveSettings(); applyTheme(); syncSettingsUI();
};
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = closeSettings;
$('settings').addEventListener('click', function (e) { if (e.target === $('settings')) closeSettings(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSettings(); });
[].forEach.call($('mtabs').children, function (b) {
  b.onclick = function () {
    [].forEach.call($('mtabs').children, function (x) { x.classList.toggle('active', x === b); });
    document.querySelectorAll('.mpane').forEach(function (p) { p.classList.toggle('active', p.id === 'mp-' + b.dataset.p); });
  };
});
Object.keys(SETTING_IDS).forEach(function (id) {
  var el = $(id), key = SETTING_IDS[id];
  el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', function () {
    if (el.type === 'checkbox') S[key] = el.checked;
    else if (key === 'maxQ') S[key] = Number(el.value);
    else S[key] = el.value;
    if (key === 'pattern' && !S.pattern.trim()) S.pattern = DEFAULTS.pattern;
    onSettingChanged(key);
  });
});
$('s-test').onclick = testInstance;
$('s-done').onclick = closeSettings;
$('s-reset').onclick = function () { resetSettings(); saveSettings(); applyTheme(); applyMode(); syncSettingsUI(); flashSaved(); if (V && !running) analyze(V.id); };

[].forEach.call($('tabs').children, function (b) { b.onclick = function () { showTab(b.dataset.t); }; });
$('type').onchange = function () { fillFormats(true); fillAudioLabels(); fillQualities(); conditional(); refresh(); };
$('fmt').onchange = function () { fillAudioLabels(); fillQualities(); conditional(); refresh(); };
$('aq').onchange = function () { fillQualities(); refresh(); };
$('track').onchange = function () { fillAudioLabels(); fillQualities(); refresh(); };
$('q').onchange = refresh;
$('fn').oninput = refresh;
$('subs').onchange = function () { conditional(); refresh(); };
$('sublang').onchange = refresh;
$('subfmt').onchange = refresh;
$('trim').onchange = function () { conditional(); refresh(); };
$('t1').oninput = $('t2').oninput = refresh;
$('thumb').onchange = $('meta').onchange = refresh;

$('go').onclick = function () { analyze(); };
$('url').addEventListener('keydown', function (e) { if (e.key === 'Enter') analyze(); });
[].forEach.call($('modetog').children, function (b) {
  b.onclick = function () { S.mode = b.dataset.m; saveSettings(); applyMode(); };
});
applyMode();
[].forEach.call($('btype').children, function (b) {
  b.onclick = function () { $('type').value = b.dataset.v; $('type').onchange(); };
});
$('start').onclick = startDownload;
$('cancel').onclick = cancelDownload;
$('done').onclick = function () { toConfig(); msg(''); };
$('direct').onclick = function () {
  var comb = V && V.direct && V.direct.combinedStreams && (V.direct.combinedStreams.find(function (s) { return s.itag === 18; }) || V.direct.combinedStreams[0]);
  if (!comb) return;
  var a = document.createElement('a');
  a.href = proxyStream(comb.url, sanitize(V.title) + ' [' + V.id + '] (' + (comb.qualityLabel || '360p') + ').mp4');
  a.target = '_blank'; a.rel = 'noopener'; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  msg('Direct download started in a new tab.');
};
