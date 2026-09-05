import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startWebServer} from '../src/server.js';

test('an explicit deployment origin preserves exact Host, mutation and SSE guards', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'openppt-origin-'));
  const origin = 'http://studio.example:7357';
  const ctx = startWebServer({port: 0, dataDir, publicOrigin: origin});
  const url = `http://127.0.0.1:${ctx.port}`;
  const headers = {Host: 'studio.example:7357', Origin: origin};
  try {
    const healthy = await fetch(url + '/api/health', {headers});
    expect(healthy.status).toBe(200); await healthy.text();
    for (const Host of ['evil.example:7357', 'studio.example', `127.0.0.1:${ctx.port}`]) {
      const r = await fetch(url + '/api/health', {headers: {Host}});
      expect(r.status).toBe(403); await r.text();
    }
    for (const Origin of ['null', 'https://evil.example', origin + '.evil']) {
      const r = await fetch(url + '/api/projects', {method: 'POST', headers: {...headers, Origin, 'Content-Type': 'application/json'}, body: '{}'});
      expect(r.status).toBe(403); await r.text();
    }
    const created = await fetch(url + '/api/projects', {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify({title: 'Deployment smoke', mode: 'blank'})});
    expect(created.status).toBe(201);
    const {project} = await created.json();
    for (const extra of [{Origin: 'null'}, {Origin: 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}]) {
      const r = await fetch(url + `/api/projects/${project.id}/events`, {headers: {...headers, ...extra}});
      expect(r.status).toBe(403); await r.text();
    }
    const events = await fetch(url + `/api/projects/${project.id}/events`, {headers});
    expect(events.status).toBe(200);
    await events.body.cancel();
    expect(ctx.url).toBe(origin + '/');
  } finally {ctx.stop(); rmSync(dataDir, {recursive: true, force: true});}
});

test('deployment origin rejects credentials, paths, queries and noncanonical or non-HTTP values', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'openppt-invalid-origin-'));
  try {
    for (const publicOrigin of ['*', '', 'ftp://host', 'http://user:pass@host', 'http://host/path', 'http://host?x=1', 'http://host#x', 'http://host/', 'null']) {
      let ctx;
      try {expect(() => {ctx = startWebServer({port: 0, dataDir, publicOrigin});}).toThrow();}
      finally {ctx?.stop();}
    }
  } finally {rmSync(dataDir, {recursive: true, force: true});}
});
