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

import { enc, dec, sleep } from './util.js';
import { API } from './settings.js';

var UMP = { MEDIA_HEADER: 20, MEDIA: 21, NEXT_REQUEST_POLICY: 35, FORMAT_INIT_METADATA: 42, SABR_REDIRECT: 43, SABR_ERROR: 44, RELOAD_PLAYER_RESPONSE: 46, SABR_CONTEXT_UPDATE: 57, STREAM_PROTECTION_STATUS: 58, SABR_CONTEXT_SENDING_POLICY: 59 };
var CPN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function generateCpn() { var s = ''; for (var i = 0; i < 16; i++) s += CPN_ALPHABET[Math.floor(Math.random() * 64)]; return s; }
function varint(n) { var out = []; while (n > 127) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); } out.push(n); return Uint8Array.from(out); }
function concat(bufs) {
  var out = new Uint8Array(bufs.reduce(function (a, b) { return a + b.length; }, 0)), off = 0;
  bufs.forEach(function (b) { out.set(b, off); off += b.length; });
  return out;
}
var pbInt = function (f, v) { return concat([varint(f * 8), varint(v)]); };
var pbBytes = function (f, d) { return concat([varint(f * 8 + 2), varint(d.length), d]); };
var pbStr = function (f, s) { return pbBytes(f, enc.encode(s)); };
function readVarint(buf, pos) {
  var result = 0, mul = 1;
  while (pos < buf.length) {
    var b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [result, pos];
    mul *= 128;
  }
  return [0, pos];
}
function pbParse(data) {
  var out = {}, pos = 0;
  while (pos < data.length) {
    var t = readVarint(data, pos); var tag = t[0]; pos = t[1];
    var f = Math.floor(tag / 8), wt = tag % 8, v;
    if (wt === 0) { var r = readVarint(data, pos); v = r[0]; pos = r[1]; }
    else if (wt === 2) {
      var l = readVarint(data, pos); var len = l[0]; pos = l[1];
      if (pos + len > data.length) break;
      v = data.subarray(pos, pos + len); pos += len;
    } else if (wt === 1) { pos += 8; continue; }
    else if (wt === 5) { pos += 4; continue; }
    else break;
    (out[f] = out[f] || []).push(v);
  }
  return out;
}
var gInt = function (d, f, def) { return typeof (d[f] && d[f][0]) === 'number' ? d[f][0] : (def || 0); };
var gBytes = function (d, f) { return d[f] && d[f][0] instanceof Uint8Array ? d[f][0] : new Uint8Array(0); };
var gStr = function (d, f) { return dec.decode(gBytes(d, f)); };
var gMsg = function (d, f) { return pbParse(gBytes(d, f)); };
function gInts(d, f) {
  var out = [];
  (d[f] || []).forEach(function (v) {
    if (typeof v === 'number') out.push(v);
    else { var p = 0; while (p < v.length) { var r = readVarint(v, p); out.push(r[0]); p = r[1]; } }
  });
  return out;
}
function readUmpVarint(buf, pos) {
  if (pos >= buf.length) return [-1, pos];
  var b0 = buf[pos];
  var len = b0 < 128 ? 1 : b0 < 192 ? 2 : b0 < 224 ? 3 : b0 < 240 ? 4 : 5;
  if (pos + len > buf.length) return [-1, pos];
  var v;
  if (len === 1) v = b0;
  else if (len === 2) v = (b0 & 0x3f) | (buf[pos + 1] << 6);
  else if (len === 3) v = (b0 & 0x1f) | (buf[pos + 1] << 5) | (buf[pos + 2] << 13);
  else if (len === 4) v = (b0 & 0x0f) | (buf[pos + 1] << 4) | (buf[pos + 2] << 12) | (buf[pos + 3] << 20);
  else v = new DataView(buf.buffer, buf.byteOffset + pos + 1, 4).getUint32(0, true);
  return [v, pos + len];
}
function iterUmpParts(buf) {
  var parts = [], pos = 0;
  while (pos < buf.length) {
    var a = readUmpVarint(buf, pos); if (a[0] < 0) break;
    var b = readUmpVarint(buf, a[1]); if (b[0] < 0 || b[1] + b[0] > buf.length) break;
    parts.push([a[0], buf.subarray(b[1], b[1] + b[0])]);
    pos = b[1] + b[0];
  }
  return parts;
}
async function gunzip(data) {
  var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function b64ToBytes(b64) {
  if (!b64) return new Uint8Array(0);
  var s = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
}
function formatId(f) {
  return concat([pbInt(1, f.itag), f.lmt ? pbInt(2, f.lmt) : new Uint8Array(0), f.xtags ? pbStr(3, f.xtags) : new Uint8Array(0)]);
}
function clientInfo(visitor, name, ver) {
  name = name || 'ANDROID_VR';
  if (name === 'MWEB') return concat([pbStr(1, 'en_US'), pbInt(16, 2), pbStr(17, ver || '2.20261016.01.00'), pbStr(12, 'google'), pbStr(13, 'pixel tablet'), pbStr(18, 'Android'), pbStr(19, '16')]);
  if (name === 'TVHTML5' || name === 'TV') return concat([pbStr(1, 'en_US'), pbInt(16, 31), pbStr(17, ver || '7.20261014.18.00'), pbStr(12, 'Sony'), pbStr(13, 'Sony_ATV_sdm845_13140765'), pbStr(18, 'Android'), pbStr(19, '10')]);
  if (name === 'TVHTML5_SIMPLY') return concat([pbStr(1, 'en_US'), pbInt(16, 74), pbStr(17, ver || '1.0'), pbStr(12, 'Sony'), pbStr(13, 'PlayStation 4'), pbStr(18, 'PlayStation 4'), pbStr(19, '5.55')]);
  if (name === 'WEB') return concat([pbStr(1, 'en_US'), pbInt(16, 1), pbStr(17, ver || '2.20261016.01.00'), pbStr(18, 'X11')]);
  return concat([pbStr(12, 'Pico'), pbStr(13, 'A8110'), visitor ? pbStr(14, visitor) : new Uint8Array(0), pbInt(16, 28), pbStr(17, ver || '1.73.21'), pbStr(18, 'Android'), pbStr(19, '10'), pbStr(21, 'en'), pbStr(22, 'US'), pbInt(67, -new Date().getTimezoneOffset()), pbStr(80, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')]);
}

function SabrTrack(kind, fmt) {
  this.kind = kind; this.fmt = fmt; this.itag = Number(fmt.itag);
  this.chunks = []; this.initDone = false; this.pending = new Map(); this.nextNum = null;
  this.endMs = 0; this.totalEndMs = 0; this.bytes = 0; this.roundHeaders = [];
}
SabrTrack.prototype.addInit = function (data) { if (!this.initDone) { this.chunks.push(data); this.bytes += data.length; this.initDone = true; } };
SabrTrack.prototype.addSegment = function (seq, s, e, data) {
  if (this.pending.has(seq) || (this.nextNum !== null && seq < this.nextNum)) return false;
  this.pending.set(seq, { startMs: s, endMs: e, data: data });
  return true;
};
SabrTrack.prototype.flush = function () {
  if (!this.initDone) return;
  if (this.nextNum === null) {
    if (this.pending.size === 0) return;
    this.nextNum = Math.min.apply(null, Array.from(this.pending.keys()));
  }
  while (this.pending.has(this.nextNum)) {
    var seg = this.pending.get(this.nextNum);
    this.pending.delete(this.nextNum);
    this.chunks.push(seg.data); this.bytes += seg.data.length; this.endMs = seg.endMs; this.nextNum++;
  }
};

function SabrDownloader(o) {
  var info = o.sabrInfo;
  this.videoId = o.videoId || info.videoId || '';
  this.sabrUrl = info.sabrUrl;
  this.visitor = info.visitorData || '';
  this.poToken = info.poToken || '';
  this.clientName = info.clientName || 'WEB';
  this.clientVersion = info.clientVersion || '2.20261016.01.00';
  this.userAgent = info.userAgent || '';
  this.cpn = info.cpn || generateCpn();
  this.ustreamer = b64ToBytes(info.ustreamerConfig);
  this.durationMs = (o.durationS || info.duration || 0) * 1000;
  this.videoFmt = o.videoFmt || null;
  this.audioFmt = o.audioFmt || null;
  this.tracks = {};
  if (this.videoFmt) this.tracks[Number(this.videoFmt.itag)] = new SabrTrack('video', this.videoFmt);
  if (this.audioFmt) this.tracks[Number(this.audioFmt.itag)] = new SabrTrack('audio', this.audioFmt);
  this.cookie = null; this.contexts = new Map(); this.activeCtx = new Set();
  this.rounds = 1; this.cancelled = false;
}
SabrDownloader.prototype.cancel = function () { this.cancelled = true; };
SabrDownloader.prototype.tlist = function () { return Object.keys(this.tracks).map(function (k) { return this.tracks[k]; }, this); };
SabrDownloader.prototype.playerTimeMs = function () { var l = this.tlist(); return l.length ? Math.min.apply(null, l.map(function (t) { return t.endMs; })) : 0; };
SabrDownloader.prototype.refMs = function (t) { return t.totalEndMs || this.durationMs; };
SabrDownloader.prototype.finished = function () {
  var l = this.tlist(); if (!l.length) return false;
  for (var i = 0; i < l.length; i++) { var t = l[i]; if (!t.initDone || !t.totalEndMs) return false; if (t.endMs < t.totalEndMs - 250) return false; }
  return true;
};
SabrDownloader.prototype.nearEnd = function () {
  var l = this.tlist(); if (!l.length) return false;
  var self = this; return l.every(function (t) { return t.endMs >= self.refMs(t) - 5000; });
};
SabrDownloader.prototype.renewPoToken = async function () {
  if (!this.videoId) return;
  try {
    var r = await fetch(API('/stream/' + encodeURIComponent(this.videoId) + '/pot?client=' + encodeURIComponent(this.clientName || 'web') + '&visitorData=' + encodeURIComponent(this.visitor || '')));
    if (r.ok) { var d = await r.json(); if (d.poToken) this.poToken = d.poToken; }
  } catch (e) {}
};
SabrDownloader.prototype.refreshPlayer = async function () {
  if (!this.videoId) return;
  try {
    var r = await fetch(API('/stream/' + encodeURIComponent(this.videoId) + '?client=' + encodeURIComponent(this.clientName || 'web') + '&include_and_try_sabr=true&force_refresh=true'));
    if (r.ok) {
      var d = await r.json();
      if (d.sabr && d.sabr.sabrUrl) {
        this.sabrUrl = d.sabr.sabrUrl;
        if (d.sabr.poToken) this.poToken = d.sabr.poToken;
        if (d.sabr.ustreamerConfig) this.ustreamer = b64ToBytes(d.sabr.ustreamerConfig);
        this.cookie = null; this.rounds = 0; this.contexts.clear(); this.activeCtx.clear();
        this.tlist().forEach(function (t) { t.roundHeaders = []; });
      }
    }
  } catch (e) {}
};
SabrDownloader.prototype.buildRequest = function () {
  var t = this.playerTimeMs();
  var abr = concat([pbInt(18, 1280), pbInt(19, 720), pbInt(28, t), pbInt(40, 0), pbInt(46, 1)]);
  var client = clientInfo(this.visitor, this.clientName, this.clientVersion);
  var ctxParts = [pbBytes(1, client)];
  if (this.poToken) ctxParts.push(pbBytes(2, b64ToBytes(this.poToken)));
  if (this.cookie) ctxParts.push(pbBytes(3, this.cookie));
  var self = this;
  Array.from(this.activeCtx).sort(function (a, b) { return a - b; }).forEach(function (typ) {
    if (self.contexts.has(typ)) ctxParts.push(pbBytes(5, concat([pbInt(1, typ), pbBytes(2, self.contexts.get(typ))])));
    else ctxParts.push(pbInt(6, typ));
  });
  var parts = [pbBytes(1, abr)];
  this.tlist().forEach(function (t) { if (t.initDone) parts.push(pbBytes(2, formatId(t.fmt))); });
  this.tlist().forEach(function (t) {
    if (t.roundHeaders.length) {
      t.roundHeaders.sort(function (a, b) { return a.seq - b.seq; });
      t.roundHeaders.forEach(function (h) {
        parts.push(pbBytes(3, concat([pbBytes(1, formatId(t.fmt)), pbInt(2, h.start), pbInt(3, h.dur), pbInt(4, h.seq), pbInt(5, h.seq)])));
      });
      t.roundHeaders = [];
    }
  });
  if (this.ustreamer && this.ustreamer.length) parts.push(pbBytes(5, this.ustreamer));
  if (this.audioFmt) parts.push(pbBytes(16, formatId(this.audioFmt)));
  if (this.videoFmt) parts.push(pbBytes(17, formatId(this.videoFmt)));
  parts.push(pbBytes(19, concat(ctxParts)));
  return concat(parts);
};
SabrDownloader.prototype.requestUrl = function () {
  return this.sabrUrl + (this.sabrUrl.indexOf('?') >= 0 ? '&' : '?') + 'rn=' + (this.rounds++);
};
SabrDownloader.prototype.download = async function (onProgress, signal) {
  var idle = 0, reloads = 0, redirects = 0, self = this;
  while (!this.finished() && !this.cancelled && (!signal || !signal.aborted)) {
    var headers = { 'Content-Type': 'application/x-protobuf', 'Accept': 'application/vnd.yt-ump' };
    if (this.visitor) headers['X-Goog-Visitor-Id'] = this.visitor;
    if (this.userAgent) headers['X-Client-User-Agent'] = this.userAgent;
    if (this.clientName) headers['X-Client-Name'] = this.clientName;
    if (this.clientVersion) headers['X-Client-Version'] = this.clientVersion;

    var res = await fetch(API('/proxy/sabr?sabr_url=' + encodeURIComponent(this.requestUrl())), { method: 'POST', headers: headers, body: this.buildRequest(), signal: signal });
    if (!res.ok) {
      if (res.status === 403 && idle < 3) { idle++; await this.renewPoToken(); await sleep(600); continue; }
      throw new Error('SABR request failed (' + res.status + ')');
    }
    var body = new Uint8Array(await res.arrayBuffer());
    if (dec.decode(body.subarray(0, 4)) === 'http') {
      if (++redirects > 20) throw new Error('Too many SABR redirects');
      this.sabrUrl = dec.decode(body).trim();
      continue;
    }

    var hdrs = new Map(), reload = false, protection = 0, backoffMs = 0, sabrError = null, redirectUrl = null;
    var parts = iterUmpParts(body);
    for (var pi = 0; pi < parts.length; pi++) {
      var ptype = parts[pi][0], payload = parts[pi][1], d;
      if (ptype === UMP.MEDIA_HEADER) {
        d = pbParse(payload);
        var hid = gInt(d, 1), fid = gMsg(d, 13), tr = gMsg(d, 15);
        var start = gInt(d, 11, -1), dur = gInt(d, 12, -1);
        if ((start < 0 || dur < 0) && d[15]) {
          var ts = gInt(tr, 3) || 1000;
          start = Math.floor(gInt(tr, 1) * 1000 / ts);
          dur = Math.floor(gInt(tr, 2) * 1000 / ts);
        }
        hdrs.set(hid, { itag: gInt(d, 3) || gInt(fid, 1), xtags: gStr(d, 5) || gStr(fid, 3), init: !!gInt(d, 8), seq: gInt(d, 9), start: Math.max(start, 0), dur: Math.max(dur, 0), len: gInt(d, 14), comp: gInt(d, 7), chunks: [] });
      } else if (ptype === UMP.MEDIA && payload.length) {
        var vr = readVarint(payload, 0), h = hdrs.get(vr[0]);
        if (h) h.chunks.push(payload.subarray(vr[1]));
      } else if (ptype === UMP.FORMAT_INIT_METADATA) {
        d = pbParse(payload);
        var itag = gInt(gMsg(d, 2), 1), end = gInt(d, 3);
        if (end > 0) {
          if (this.tracks[itag]) this.tracks[itag].totalEndMs = end;
          else {
            var tl = this.tlist();
            for (var ti = 0; ti < tl.length; ti++) if (!tl[ti].initDone && !tl[ti].totalEndMs) { tl[ti].totalEndMs = end; break; }
          }
        }
      } else if (ptype === UMP.NEXT_REQUEST_POLICY) {
        d = pbParse(payload);
        backoffMs = gInt(d, 4);
        var ck = gBytes(d, 7); if (ck.length) this.cookie = ck;
      } else if (ptype === UMP.SABR_REDIRECT) { redirectUrl = gStr(pbParse(payload), 1); }
      else if (ptype === UMP.SABR_ERROR) { d = pbParse(payload); sabrError = gStr(d, 1) + ' (code ' + gInt(d, 2) + ')'; }
      else if (ptype === UMP.RELOAD_PLAYER_RESPONSE) { reload = true; }
      else if (ptype === UMP.STREAM_PROTECTION_STATUS) { protection = gInt(pbParse(payload), 1); }
      else if (ptype === UMP.SABR_CONTEXT_UPDATE) {
        d = pbParse(payload);
        var typ = gInt(d, 1);
        if (!(this.contexts.has(typ) && gInt(d, 5) === 2)) {
          this.contexts.set(typ, gBytes(d, 3));
          if (gInt(d, 4)) this.activeCtx.add(typ);
        }
      } else if (ptype === UMP.SABR_CONTEXT_SENDING_POLICY) {
        d = pbParse(payload);
        gInts(d, 1).forEach(function (t) { self.activeCtx.add(t); });
        gInts(d, 2).forEach(function (t) { self.activeCtx.delete(t); });
        gInts(d, 3).forEach(function (t) { self.contexts.delete(t); self.activeCtx.delete(t); });
      }
    }

    if (sabrError) throw new Error('SABR error: ' + sabrError);
    if (redirectUrl) { if (++redirects > 20) throw new Error('Too many SABR redirects'); this.sabrUrl = redirectUrl; }
    if (protection === 2 || protection === 3) await this.renewPoToken();
    if (reload) {
      if (++reloads > 4) throw new Error('Too many SABR player reloads');
      await this.refreshPlayer();
      continue;
    }

    var newSegments = 0, sawMedia = false, hv = Array.from(hdrs.values());
    for (var hi = 0; hi < hv.length; hi++) {
      var hh = hv[hi], track = this.tracks[hh.itag];
      if (!track) {
        var tl2 = this.tlist();
        for (var k = 0; k < tl2.length; k++) {
          if (tl2[k].bytes === 0 && !tl2[k].initDone) {
            this.tracks[hh.itag] = tl2[k]; tl2[k].itag = hh.itag; if (tl2[k].fmt) tl2[k].fmt.itag = hh.itag; track = tl2[k]; break;
          }
        }
      }
      if (!track) continue;
      var data = concat(hh.chunks);
      if (hh.comp === 1) data = await gunzip(data);
      sawMedia = true;
      if (hh.init) track.addInit(data);
      else {
        if (track.addSegment(hh.seq, hh.start, hh.start + hh.dur, data)) newSegments++;
        track.roundHeaders.push(hh);
      }
    }
    this.tlist().forEach(function (t) { t.flush(); });

    var tl3 = this.tlist(), totalBytes = tl3.reduce(function (acc, t) { return acc + t.bytes; }, 0), pct = 0;
    if (tl3.length && tl3.every(function (t) { return t.totalEndMs > 0; })) {
      pct = Math.min.apply(null, tl3.map(function (t) { return Math.min(100, Math.round(t.endMs / t.totalEndMs * 100)); }));
    } else if (this.durationMs > 0) {
      pct = Math.min(100, Math.round(this.playerTimeMs() / this.durationMs * 100));
    }
    if (onProgress) onProgress({ bytes: totalBytes, percent: pct });

    if (newSegments > 0) { idle = 0; reloads = 0; }
    else {
      if (this.nearEnd()) break;
      if (!(backoffMs > 0)) {
        idle++;
        if (idle >= 6) {
          if (sawMedia || tl3.some(function (t) { return t.chunks.length > 0; })) break;
          throw new Error('SABR stream returned no media chunks');
        }
        if (idle === 3) await this.refreshPlayer();
      }
    }
    await sleep(backoffMs > 0 ? Math.max(100, Math.min(backoffMs, 5000)) : 100);
  }
  if (this.cancelled || (signal && signal.aborted)) { var ae = new Error('Aborted'); ae.name = 'AbortError'; throw ae; }
  this.tlist().forEach(function (t) { t.flush(); if (!t.initDone) throw new Error('No init segment received for itag ' + t.itag); });
  var vt = this.videoFmt ? this.tracks[this.videoFmt.itag] : null;
  var at = this.audioFmt ? this.tracks[this.audioFmt.itag] : null;
  return {
    videoBlob: vt && vt.chunks.length ? new Blob(vt.chunks, { type: this.videoFmt.mimeType || 'video/mp4' }) : null,
    audioBlob: at && at.chunks.length ? new Blob(at.chunks, { type: this.audioFmt.mimeType || 'audio/mp4' }) : null
  };
};

export { SabrDownloader };
