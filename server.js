// server.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import NodeCache from 'node-cache';
import { fetch } from 'undici';
import pLimit from 'p-limit';

const app = express();
app.use(express.json());
app.use(morgan('tiny'));

const NZTABASE = process.env.NZTABASE ?? 'https://trafficnz.info/service/traffic/rest/4';
const CACHETTL = Number(process.env.CACHETTL ?? 30); // seconds
const REQUESTTIMEOUTMS = Number(process.env.REQUESTTIMEOUTMS ?? 8000);
const cache = new NodeCache({ stdTTL: CACHETTL, checkperiod: CACHETTL / 2 });

const limit = pLimit(Number(process.env.CONCURRENCY ?? 6));

function timeoutSignal(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

function isSafeResource(name) {
  // Whitelist common resources to avoid arbitrary proxying
  const allowed = new Set([
    'findCamerasAll','findCamerasWithinBounds','findCamerasByRegion','findCamerasByJourney',
    'findRoadEventsAll','findRoadEventsWithinBounds','findRoadEventsByRegion','findRoadEventsByJourney',
    'findVmsSignsAll','findVmsSignsWithinBounds','findVmsSignsByRegion','findVmsSignsByJourney',
    'findTimSignsAll','findTimSignsWithinBounds','findTimSignsByRegion','findTimSignsByJourney',
    'findRegionsAll','findRegionsWithinBounds',
    'findWaysAll','findWaysWithinBounds',
    'findJourneysAll','findJourneysWithinBounds'
  ]);
  return allowed.has(name);
}

app.get('/api/traffic/:resource', async (req, res) => {
  try {
    const { resource } = req.params;
    if (!isSafeResource(resource)) {
      return res.status(400).json({ error: 'Unsupported resource' });
    }

    // Build NZTA URL (query string passes through)
    const qs = new URLSearchParams(req.query).toString();
    const target = `${NZTABASE}/${resource}${qs ? `?${qs}` : ''}`;

    // Cache key
    const key = `traffic:${resource}:${qs}`;
    const cached = cache.get(key);
    if (cached) {
      return res.set('X-Cache', 'HIT').json(cached);
    }

    const { signal, cancel } = timeoutSignal(REQUESTTIMEOUTMS);
    const job = limit(async () => {
      const resp = await fetch(target, { signal, headers: { Accept: 'application/json' } });
      cancel();

      if (!resp.ok) {
        // Graceful fallback on 5xx/timeout
        return { error: true, status: resp.status, data: await resp.text() };
      }
      const contentType = resp.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      const data = isJson ? await resp.json() : await resp.text();

      // Normalize to JSON for the client
      const normalized = typeof data === 'string' ? { raw: data } : data;
      return { error: false, status: resp.status, data: normalized };
    });

    const result = await job;

    if (result.error) {
      // Soft failure: return last good cache if present
      const stale = cache.get(key + ':stale');
      if (stale) {
        return res
          .status(200)
          .set('X-Cache', 'STALE')
          .json({ ...stale, meta: { warning: 'Upstream error, served stale cache' } });
      }
      return res.status(result.status || 502).json({ error: 'Upstream error', detail: result.data });
    }

    // Cache fresh and store stale backup
    cache.set(key, result.data);
    cache.set(key + ':stale', result.data, CACHETTL * 10);
    return res.set('X-Cache', 'MISS').json(result.data);
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Upstream timeout' : 'Proxy error';
    return res.status(504).json({ error: message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Traffic proxy listening on :${port}`));
