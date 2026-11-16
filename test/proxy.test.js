import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createProxyServer } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';

const silentLogger = { info: () => {}, error: () => {} };

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('proxy-server', () => {
  let upstreamServer;
  let upstreamPort;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      if (req.url === '/slow') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200);
            res.end('finally');
          }
        }, 300);
        return;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
          })
        );
      });
    });

    upstreamPort = await listen(upstreamServer);
  });

  after(async () => {
    await close(upstreamServer);
  });

  it('responds to GET /health with mode info', async () => {
    const config = loadConfig({
      PORT: '0',
      TARGET_URL: `http://127.0.0.1:${upstreamPort}`,
      ENABLE_FORWARD_PROXY: 'false',
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, {
        status: 'ok',
        mode: { reverseProxy: true, forwardProxy: false },
      });
    } finally {
      await close(proxy);
    }
  });

  it('reverse-proxies GET and POST requests with X-Forwarded-* headers and base path', async () => {
    const config = loadConfig({
      PORT: '0',
      TARGET_URL: `http://127.0.0.1:${upstreamPort}/api`,
      CORS_ORIGIN: 'https://app.example.com',
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/users?active=true`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-custom': 'hello',
        },
        body: JSON.stringify({ name: 'Ada' }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');

      const echoed = await res.json();
      assert.equal(echoed.method, 'POST');
      assert.equal(echoed.url, '/api/users?active=true');
      assert.equal(echoed.headers['x-custom'], 'hello');
      assert.equal(echoed.headers['x-forwarded-proto'], 'http');
      assert.ok(echoed.headers['x-forwarded-for']);
      assert.equal(echoed.headers['x-forwarded-host'], `127.0.0.1:${proxyPort}`);
      assert.equal(echoed.body, JSON.stringify({ name: 'Ada' }));

      const preflight = await fetch(`http://127.0.0.1:${proxyPort}/users`, {
        method: 'OPTIONS',
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example.com');
    } finally {
      await close(proxy);
    }
  });

  it('returns 502 Bad Gateway when upstream is unreachable', async () => {
    const deadServer = http.createServer();
    const deadPort = await listen(deadServer);
    await close(deadServer);

    const config = loadConfig({
      PORT: '0',
      TARGET_URL: `http://127.0.0.1:${deadPort}`,
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/anything`);
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.equal(data.error, 'Bad Gateway');
    } finally {
      await close(proxy);
    }
  });

  it('returns 504 Gateway Timeout when upstream exceeds REQUEST_TIMEOUT_MS', async () => {
    const config = loadConfig({
      PORT: '0',
      TARGET_URL: `http://127.0.0.1:${upstreamPort}`,
      REQUEST_TIMEOUT_MS: '50',
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/slow`);
      assert.equal(res.status, 504);
      const data = await res.json();
      assert.equal(data.error, 'Gateway Timeout');
    } finally {
      await close(proxy);
    }
  });

  it('handles forward HTTP proxy and CONNECT tunneling when enabled', async () => {
    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      // Forward HTTP request using raw http.request with absolute URL
      const httpResult = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://127.0.0.1:${upstreamPort}/forwarded?ok=1`,
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
            });
          }
        );
        req.on('error', reject);
        req.end();
      });

      assert.equal(httpResult.status, 200);
      assert.equal(httpResult.body.url, '/forwarded?ok=1');

      // CONNECT tunnel to upstreamServer
      const tunnelResponse = await new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
          socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
        });

        let established = false;
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (!established && buffer.includes('\r\n\r\n')) {
            established = true;
            assert.match(buffer, /^HTTP\/1\.1 200 Connection Established/);
            buffer = '';
            socket.write(
              `GET /tunneled HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`
            );
          } else if (established && buffer.includes('"url":"/tunneled"')) {
            socket.end();
            resolve(buffer);
          }
        });

        socket.on('error', reject);
      });

      assert.match(tunnelResponse, /"url":"\/tunneled"/);
    } finally {
      await close(proxy);
    }
  });

  it('rejects forward proxy requests when ENABLE_FORWARD_PROXY=false', async () => {
    const config = loadConfig({
      PORT: '0',
      TARGET_URL: `http://127.0.0.1:${upstreamPort}`,
      ENABLE_FORWARD_PROXY: 'false',
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://127.0.0.1:${upstreamPort}/blocked`,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on('error', reject);
        req.end();
      });

      assert.equal(status, 403);
    } finally {
      await close(proxy);
    }
  });

  it('defaults to forward proxy mode when no TARGET_URL or ENABLE_FORWARD_PROXY is set', () => {
    const config = loadConfig({});
    assert.equal(config.targetUrl, null);
    assert.equal(config.enableForwardProxy, true);

    assert.throws(
      () => loadConfig({ ENABLE_FORWARD_PROXY: 'false' }),
      /Configure TARGET_URL/
    );
  });

  it('enforces Basic auth on forward HTTP and CONNECT requests when configured', async () => {
    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
      PROXY_USERNAME: 'alice',
      PROXY_PASSWORD: 'secret-password',
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      // Unauthenticated HTTP forward request -> 407
      const unauthStatus = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://127.0.0.1:${upstreamPort}/protected`,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(unauthStatus, 407);

      // Authenticated HTTP forward request -> 200
      const authToken = Buffer.from('alice:secret-password').toString('base64');
      const authStatus = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://127.0.0.1:${upstreamPort}/protected`,
            headers: {
              'proxy-authorization': `Basic ${authToken}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(authStatus, 200);

      // Unauthenticated CONNECT -> 407
      const connectStatus = await new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
          socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
        });
        socket.on('data', (chunk) => {
          const line = chunk.toString('utf8').split('\r\n')[0];
          socket.destroy();
          resolve(line);
        });
        socket.on('error', reject);
      });
      assert.match(connectStatus, /407 Proxy Authentication Required/);
    } finally {
      await close(proxy);
    }
  });

  it('blocks access to cloud metadata endpoints by default', async () => {
    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: 'http://169.254.169.254/computeMetadata/v1/',
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);
    } finally {
      await close(proxy);
    }
  });

  it('redirects GET / to /config and persists live config updates via /api/config', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'proxy-cfg-'));
    const configPath = join(tempDir, 'config.json');

    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
    });
    const proxy = createProxyServer(config, silentLogger, { configPath });
    const proxyPort = await listen(proxy);

    try {
      // GET / redirects to /config when no TARGET_URL is configured
      const rootRes = await fetch(`http://127.0.0.1:${proxyPort}/`, { redirect: 'manual' });
      assert.equal(rootRes.status, 302);
      assert.equal(rootRes.headers.get('location'), '/config');

      // GET /config serves the HTML UI
      const uiRes = await fetch(`http://127.0.0.1:${proxyPort}/config`);
      assert.equal(uiRes.status, 200);
      const html = await uiRes.text();
      assert.match(html, /Proxy Server Configuration/);

      // POST /api/config saves credentials & adminPassword and applies them live
      const saveRes = await fetch(`http://127.0.0.1:${proxyPort}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enableForwardProxy: true,
          targetUrl: '',
          proxyUsername: 'client1',
          proxyPassword: 'pw1',
          blockMetadata: true,
          requestTimeoutMs: 15000,
          host: '0.0.0.0',
          port: 0,
          adminPassword: 'admin-secret',
        }),
      });
      assert.equal(saveRes.status, 200);
      const saved = await saveRes.json();
      assert.equal(saved.config.hasProxyPassword, true);
      assert.equal(saved.config.hasAdminPassword, true);

      // /config now requires adminPassword
      const lockedRes = await fetch(`http://127.0.0.1:${proxyPort}/api/config`);
      assert.equal(lockedRes.status, 401);

      const adminToken = Buffer.from('admin:admin-secret').toString('base64');
      const unlockedRes = await fetch(`http://127.0.0.1:${proxyPort}/api/config`, {
        headers: { authorization: `Basic ${adminToken}` },
      });
      assert.equal(unlockedRes.status, 200);

      // Reloading from configPath restores saved values
      const reloaded = loadConfig({}, { configPath });
      assert.equal(reloaded.proxyAuth?.username, 'client1');
      assert.equal(reloaded.proxyAuth?.password, 'pw1');
      assert.equal(reloaded.adminPassword, 'admin-secret');
    } finally {
      await close(proxy);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('chains forward HTTP and CONNECT requests round-robin through upstreamProxies', async () => {
    const hits = [];

    function createMockUpstreamProxy(name) {
      const s = http.createServer((req, res) => {
        hits.push({ proxy: name, type: 'http', url: req.url });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ via: name, url: req.url }));
      });
      s.on('connect', (req, clientSocket) => {
        hits.push({ proxy: name, type: 'connect', url: req.url });
        const [host, port] = req.url.split(':');
        const targetSocket = net.connect(Number(port), host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => clientSocket.destroy());
      });
      return s;
    }

    const up1 = createMockUpstreamProxy('up1');
    const up2 = createMockUpstreamProxy('up2');
    const up1Port = await listen(up1);
    const up2Port = await listen(up2);

    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
      UPSTREAM_PROXIES: `127.0.0.1:${up1Port},127.0.0.1:${up2Port}`,
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    const sendViaProxy = (targetPath) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://example.test${targetPath}`,
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
          }
        );
        req.on('error', reject);
        req.end();
      });

    try {
      const r1 = await sendViaProxy('/one');
      const r2 = await sendViaProxy('/two');
      assert.equal(r1.via, 'up1');
      assert.equal(r2.via, 'up2');

      // CONNECT tunnel should chain through up1 (round-robin) to upstreamServer
      const tunnelOut = await new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
          socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
        });
        let established = false;
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (!established && buf.includes('\r\n\r\n')) {
            established = true;
            buf = '';
            socket.write(`GET /chained HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`);
          } else if (established && buf.includes('"url":"/chained"')) {
            socket.end();
            resolve(buf);
          }
        });
        socket.on('error', reject);
      });

      assert.match(tunnelOut, /"url":"\/chained"/);
      assert.equal(hits.some((h) => h.proxy === 'up1' && h.type === 'connect'), true);
    } finally {
      await close(proxy);
      await close(up1);
      await close(up2);
    }
  });

  it('forwards upstream Proxy-Authorization, expands {country}/{session}, and routes by X-Proxy-Country', async () => {
    const observed = [];

    function createAuthUpstream(name) {
      const s = http.createServer((req, res) => {
        observed.push({
          name,
          type: 'http',
          auth: req.headers['proxy-authorization'] ?? null,
          leakedCountryHeader: req.headers['x-proxy-country'] ?? null,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ via: name, auth: req.headers['proxy-authorization'] ?? null }));
      });
      s.on('connect', (req, clientSocket) => {
        observed.push({
          name,
          type: 'connect',
          auth: req.headers['proxy-authorization'] ?? null,
        });
        const [host, port] = req.url.split(':');
        const targetSocket = net.connect(Number(port), host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => clientSocket.destroy());
      });
      return s;
    }

    const usProxy = createAuthUpstream('us');
    const gbGateway = createAuthUpstream('gb-gate');
    const usPort = await listen(usProxy);
    const gbPort = await listen(gbGateway);

    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
      UPSTREAM_PROXIES: [
        `http://ususer:uspass@127.0.0.1:${usPort}#US`,
        `http://user-{country}-{session}:secret@127.0.0.1:${gbPort}`,
      ].join(','),
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    const sendHttp = (headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: 'http://example.test/check',
            headers,
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
          }
        );
        req.on('error', reject);
        req.end();
      });

    try {
      // Request targeting US should hit usProxy with Basic ususer:uspass and strip X-Proxy-Country
      const usRes = await sendHttp({ 'x-proxy-country': 'US' });
      assert.equal(usRes.status, 200);
      assert.equal(usRes.body.via, 'us');
      assert.equal(
        usRes.body.auth,
        `Basic ${Buffer.from('ususer:uspass').toString('base64')}`
      );
      assert.equal(observed[0].leakedCountryHeader, null);

      // Request targeting DE matches the untagged {country}/{session} gateway template
      const deRes = await sendHttp({ 'x-proxy-country': 'DE' });
      assert.equal(deRes.status, 200);
      assert.equal(deRes.body.via, 'gb-gate');
      const decodedDeAuth = Buffer.from(deRes.body.auth.replace('Basic ', ''), 'base64').toString('utf8');
      assert.match(decodedDeAuth, /^user-de-[0-9a-f]{8}:secret$/);

      // CONNECT targeting US should also send Proxy-Authorization to usProxy
      const tunnelOut = await new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
          socket.write(
            `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nX-Proxy-Country: US\r\n\r\n`
          );
        });
        let established = false;
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (!established && buf.includes('\r\n\r\n')) {
            established = true;
            buf = '';
            socket.write(`GET /us-tunnel HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`);
          } else if (established && buf.includes('"url":"/us-tunnel"')) {
            socket.end();
            resolve(buf);
          }
        });
        socket.on('error', reject);
      });

      assert.match(tunnelOut, /"url":"\/us-tunnel"/);
      const connectHit = observed.find((o) => o.name === 'us' && o.type === 'connect');
      assert.equal(connectHit?.auth, `Basic ${Buffer.from('ususer:uspass').toString('base64')}`);
    } finally {
      await close(proxy);
      await close(usProxy);
      await close(gbGateway);
    }
  });

  it('masks upstream proxy passwords in /api/config and preserves them when saved back masked', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'proxy-upstream-mask-'));
    const configPath = join(tempDir, 'config.json');
    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
      UPSTREAM_PROXIES: 'https://alice:topsecret@gate.example.com:443#US',
    });
    const proxy = createProxyServer(config, silentLogger, { configPath });
    const port = await listen(proxy);

    try {
      const getRes = await fetch(`http://127.0.0.1:${port}/api/config`);
      assert.equal(getRes.status, 200);
      const uiCfg = await getRes.json();
      assert.deepEqual(uiCfg.upstreamProxies, ['https://alice:***@gate.example.com:443#US']);

      const postRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...uiCfg,
          upstreamProxies: uiCfg.upstreamProxies.join('\n'),
        }),
      });
      assert.equal(postRes.status, 200);

      const reloaded = loadConfig(process.env, { configPath });
      assert.equal(reloaded.upstreamProxies[0].protocol, 'https:');
      assert.equal(reloaded.upstreamProxies[0].username, 'alice');
      assert.equal(reloaded.upstreamProxies[0].password, 'topsecret');
      assert.equal(reloaded.upstreamProxies[0].country, 'US');
    } finally {
      await close(proxy);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails over across upstreamProxies on HTTP 407/connection errors and tracks cooldown in /health', async () => {
    // Get an unused port to simulate a dead upstream proxy
    const deadServer = http.createServer();
    const deadPort = await listen(deadServer);
    await close(deadServer);

    let healthyHits = 0;
    const healthyProxy = http.createServer((req, res) => {
      healthyHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hit: healthyHits }));
    });
    healthyProxy.on('connect', (req, clientSocket) => {
      healthyHits++;
      const [host, port] = req.url.split(':');
      const targetSocket = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });
      targetSocket.on('error', () => clientSocket.destroy());
    });
    const healthyPort = await listen(healthyProxy);

    const rejectingProxy = http.createServer((req, res) => {
      res.writeHead(407, { 'content-type': 'text/plain' });
      res.end('Proxy Auth Required');
    });
    rejectingProxy.on('connect', (req, clientSocket) => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });
    const rejectingPort = await listen(rejectingProxy);

    const config = loadConfig({
      PORT: '0',
      ENABLE_FORWARD_PROXY: 'true',
      UPSTREAM_PROXIES: `127.0.0.1:${deadPort},127.0.0.1:${rejectingPort},127.0.0.1:${healthyPort}`,
    });
    const proxy = createProxyServer(config, silentLogger);
    const proxyPort = await listen(proxy);

    const sendHttp = () =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: 'http://example.test/failover',
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
          }
        );
        req.on('error', reject);
        req.end();
      });

    try {
      const r1 = await sendHttp();
      assert.equal(r1.status, 200);
      assert.equal(r1.body.ok, true);

      const healthRes = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      const health = await healthRes.json();
      assert.equal(health.upstreamHealth.total, 3);
      assert.equal(health.upstreamHealth.coolingDown, 2);
      assert.equal(health.upstreamHealth.healthy, 1);

      // CONNECT should also fail over to healthyProxy
      const tunnelOut = await new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
          socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
        });
        let established = false;
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (!established && buf.includes('\r\n\r\n')) {
            established = true;
            buf = '';
            socket.write(`GET /failover-tunnel HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`);
          } else if (established && buf.includes('"url":"/failover-tunnel"')) {
            socket.end();
            resolve(buf);
          }
        });
        socket.on('error', reject);
      });
      assert.match(tunnelOut, /"url":"\/failover-tunnel"/);
      assert.equal(healthyHits, 2);
    } finally {
      await close(proxy);
      await close(healthyProxy);
      await close(rejectingProxy);
    }
  });
});

