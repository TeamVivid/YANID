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

const CHUNK_SIZE = 10 * 1024 * 1024;

export async function fetchStreamBlob(url, approxTotal, onProgress, abortSignal) {
  const parts = [];
  let received = 0;
  let total = approxTotal || 0;
  let mimeType = 'video/mp4';

  for (;;) {
    const size = CHUNK_SIZE;
    let chunk = [];
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, { headers: { Range: `bytes=${received}-${received + size - 1}` }, signal: abortSignal });
        if (res.status === 416) return new Blob(parts, { type: mimeType });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        chunk = [];
        let chunkBytes = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunk.push(value);
          chunkBytes += value.length;
          if (onProgress) onProgress(received + chunkBytes, total);
        }
        break;
      } catch (e) {
        if (e.name === 'AbortError' || attempt >= 3) throw e;
        await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
      }
    }

    const got = chunk.reduce((n, c) => n + c.length, 0);
    parts.push(...chunk);
    received += got;
    if (received === got) mimeType = res.headers.get('content-type') || mimeType;

    const rangeTotal = res.headers.get('content-range')?.match(/\/(\d+)$/);
    if (rangeTotal) total = Number(rangeTotal[1]);

    const finished = res.status !== 206 || got < size || (rangeTotal && received >= total);
    if (finished) return new Blob(parts, { type: mimeType });
  }
}
