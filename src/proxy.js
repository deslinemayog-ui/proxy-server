import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { formatUpstreamProxy, parseUpstreamProxies, saveConfig, serializeConfigForUi } from './config.js';

const CONFIG_HTML = readFileSync(new URL('./ui/config.html', import.meta.url), 'utf8');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Strip hop-by-hop headers (RFC 7230 Section 6.1) from a header map.
 * @param {http.IncomingHttpHeaders} headers
 */
function stripHopByHopHeaders(headers) {
  const connectionHeader = headers.connection;
  const extraHopHeaders = new Set(
    typeof connectionHeader === 'string'
      ? connectionHeader.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
      : []
  );

  const cleaned = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || extraHopHeaders.has(lower)) {
      continue;
    }
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Build outgoing headers for a reverse-proxied request.
 * @param {http.IncomingMessage} req
 * @param {URL} targetUrl
 */
function buildReverseProxyHeaders(req, targetUrl) {
  const headers = stripHopByHopHeaders(req.headers);
  headers.host = targetUrl.host;

  const clientIp = req.socket.remoteAddress;
  if (clientIp) {
    const existing = headers['x-forwarded-for'];
    headers['x-forwarded-for'] = existing ? `${existing}, ${clientIp}` : clientIp;
  }

  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  if (req.headers.host) {
    headers['x-forwarded-host'] = req.headers.host;
  }

  return headers;
}

/**
 * Resolve the upstream URL for a reverse-proxied request, preserving any base path on targetUrl.
 * @param {string} requestUrl
 * @param {URL} targetUrl
 */
function resolveReverseTarget(requestUrl, targetUrl) {
  const basePath = targetUrl.pathname.replace(/\/+$/, '');
  const incomingPath = requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`;
  return new URL(`${basePath}${incomingPath}`, targetUrl.origin);
}

/**
 * Send a JSON error response if headers have not yet been sent.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {string} message
 */
function sendJsonError(res, statusCode, message) {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  const body = JSON.stringify({ error: message });
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Apply CORS headers when `corsOrigin` is configured.
 * @param {http.ServerResponse} res
 * @param {string | null} corsOrigin
 */
function applyCorsHeaders(res, corsOrigin) {
  if (!corsOrigin) return;
  res.setHeader('access-control-allow-origin', corsOrigin);
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, X-Requested-With');
}

/**
 * Build a `Basic ...` Proxy-Authorization header value for an upstream proxy, if credentials exist.
 * @param {{ username: string | null, password: string | null } | null} upstreamProxy
 */
function buildUpstreamAuthHeader(upstreamProxy) {
  if (!upstreamProxy || upstreamProxy.username === null) return null;
  const token = Buffer.from(`${upstreamProxy.username}:${upstreamProxy.password ?? ''}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Read a request body into a Buffer up to `maxBytes` so failed upstream proxy attempts can be retried.
 * @param {http.IncomingMessage} req
 * @param {number} [maxBytes=1048576]
 */
function readRequestBuffer(req, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large for retry buffering'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Forward an HTTP/HTTPS request through a prioritized list of upstream proxies with automatic failover.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} destinationUrl
 * @param {object} headers
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {{ info: Function, error: Function }} logger
 * @param {Array<{ raw: any, resolved: any }>} candidates
 * @param {{ markFailure: Function, markSuccess: Function }} healthTracker
 */
async function forwardViaUpstreamPool(req, res, destinationUrl, headers, config, logger, candidates, healthTracker) {
  let bodyBuffer = Buffer.alloc(0);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      bodyBuffer = await readRequestBuffer(req);
    } catch (err) {
      sendJsonError(res, 413, err.message);
      return;
    }
  }

  let clientAborted = false;
  req.on('aborted', () => {
    clientAborted = true;
  });

  const maxAttempts = Math.min(candidates.length, 5);
  let lastTimedOut = false;

  for (let i = 0; i < maxAttempts; i++) {
    if (clientAborted || res.writableEnded) return;
    const { raw, resolved: upstreamProxy } = candidates[i];
    const startedAt = Date.now();

    const result = await new Promise((resolveAttempt) => {
      const transport = upstreamProxy.protocol === 'https:' ? https : http;
      const outgoingHeaders = { ...headers };
      const upstreamAuth = buildUpstreamAuthHeader(upstreamProxy);
      if (upstreamAuth) {
        outgoingHeaders['proxy-authorization'] = upstreamAuth;
      }

      let timedOut = false;
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolveAttempt(outcome);
      };

      const proxyReq = transport.request(
        {
          host: upstreamProxy.host,
          port: upstreamProxy.port,
          path: destinationUrl.href,
          method: req.method,
          headers: outgoingHeaders,
          agent: false,
        },
        (proxyRes) => {
          const status = proxyRes.statusCode ?? 502;
          if ((status === 407 || status === 502) && i < maxAttempts - 1) {
            proxyRes.resume();
            healthTracker.markFailure(raw, `HTTP ${status}`);
            logger.error(`Upstream proxy ${upstreamProxy.host}:${upstreamProxy.port} returned ${status}, failing over`);
            finish({ retry: true, timedOut: false });
            return;
          }

          healthTracker.markSuccess(raw);
          const responseHeaders = stripHopByHopHeaders(proxyRes.headers);
          if (config.corsOrigin) {
            responseHeaders['access-control-allow-origin'] = config.corsOrigin;
          }

          res.writeHead(status, proxyRes.statusMessage, responseHeaders);
          proxyRes.pipe(res);
          proxyRes.on('end', () => {
            logger.info(`${req.method} ${req.url} -> ${destinationUrl.href} via ${upstreamProxy.host}:${upstreamProxy.port} [${status}] ${Date.now() - startedAt}ms`);
            finish({ retry: false });
          });
          proxyRes.on('error', () => finish({ retry: false }));
        }
      );

      proxyReq.setTimeout(config.requestTimeoutMs, () => {
        timedOut = true;
        proxyReq.destroy(new Error('Upstream request timed out'));
      });

      proxyReq.on('error', (err) => {
        healthTracker.markFailure(raw, err.message);
        logger.error(`Upstream proxy ${upstreamProxy.host}:${upstreamProxy.port} failed for ${req.method} ${destinationUrl.href}: ${err.message}`);
        finish({ retry: true, timedOut });
      });

      if (bodyBuffer.length > 0) {
        proxyReq.write(bodyBuffer);
      }
      proxyReq.end();
    });

    lastTimedOut = Boolean(result.timedOut);
    if (!result.retry) return;
  }

  if (lastTimedOut) {
    sendJsonError(res, 504, 'Gateway Timeout');
  } else {
    sendJsonError(res, 502, 'Bad Gateway');
  }
}

/**
 * Forward an HTTP/HTTPS request directly to `destinationUrl`.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} destinationUrl
 * @param {object} headers
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {{ info: Function, error: Function }} logger
 * @param {{ protocol: 'http:' | 'https:', host: string, port: number, username: string | null, password: string | null } | null} [upstreamProxy=null]
 */
function forwardRequest(req, res, destinationUrl, headers, config, logger, upstreamProxy = null) {
  const transport = upstreamProxy
    ? (upstreamProxy.protocol === 'https:' ? https : http)
    : (destinationUrl.protocol === 'https:' ? https : http);
  const startedAt = Date.now();
  let timedOut = false;

  const outgoingHeaders = upstreamProxy ? { ...headers } : headers;
  const upstreamAuth = buildUpstreamAuthHeader(upstreamProxy);
  if (upstreamAuth) {
    outgoingHeaders['proxy-authorization'] = upstreamAuth;
  }

  const requestTarget = upstreamProxy
    ? {
        host: upstreamProxy.host,
        port: upstreamProxy.port,
        path: destinationUrl.href,
        method: req.method,
        headers: outgoingHeaders,
        agent: false,
      }
    : destinationUrl;

  const requestOptions = upstreamProxy
    ? requestTarget
    : {
        method: req.method,
        headers: outgoingHeaders,
      };

  const proxyReq = upstreamProxy
    ? transport.request(requestOptions, handleResponse)
    : transport.request(destinationUrl, requestOptions, handleResponse);

  function handleResponse(proxyRes) {
    const responseHeaders = stripHopByHopHeaders(proxyRes.headers);
    if (config.corsOrigin) {
      responseHeaders['access-control-allow-origin'] = config.corsOrigin;
    }

    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, responseHeaders);
    proxyRes.pipe(res);

    proxyRes.on('end', () => {
      const via = upstreamProxy ? ` via ${upstreamProxy.host}:${upstreamProxy.port}` : '';
      logger.info(`${req.method} ${req.url} -> ${destinationUrl.href}${via} [${proxyRes.statusCode}] ${Date.now() - startedAt}ms`);
    });
  }

  proxyReq.setTimeout(config.requestTimeoutMs, () => {
    timedOut = true;
    proxyReq.destroy(new Error('Upstream request timed out'));
  });

  proxyReq.on('error', (err) => {
    logger.error(`Proxy error for ${req.method} ${destinationUrl.href}: ${err.message}`);
    if (timedOut) {
      sendJsonError(res, 504, 'Gateway Timeout');
    } else {
      sendJsonError(res, 502, 'Bad Gateway');
    }
  });

  req.on('aborted', () => {
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
]);

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validate `Proxy-Authorization: Basic ...` when `proxyAuth` is configured.
 * @param {http.IncomingMessage} req
 * @param {{ username: string, password: string } | null} proxyAuth
 */
function isProxyAuthorized(req, proxyAuth) {
  if (!proxyAuth) return true;
  const header = req.headers['proxy-authorization'];
  if (typeof header !== 'string' || !header.startsWith('Basic ')) {
    return false;
  }

  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return false;

  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);
  return safeEqual(user, proxyAuth.username) && safeEqual(pass, proxyAuth.password);
}

/**
 * Check whether a hostname targets the cloud instance metadata service.
 * @param {string} hostname
 * @param {boolean} blockMetadata
 */
function isBlockedMetadataHost(hostname, blockMetadata) {
  if (!blockMetadata) return false;
  return METADATA_HOSTS.has(hostname.toLowerCase());
}

/**
 * Validate `Authorization: Basic ...` against `adminPassword` when configured.
 * @param {http.IncomingMessage} req
 * @param {string | null | undefined} adminPassword
 */
function isAdminAuthorized(req, adminPassword) {
  if (!adminPassword) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) {
    return false;
  }

  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return false;

  const pass = decoded.slice(colonIdx + 1);
  return safeEqual(pass, adminPassword);
}

/**
 * Read a JSON request body up to a safe size limit.
 * @param {http.IncomingMessage} req
 */
function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Parse a `host:port` authority string for HTTP CONNECT tunneling.
 * @param {string} authority
 */
function parseAuthority(authority) {
  if (authority.startsWith('[')) {
    const closingIdx = authority.indexOf(']');
    if (closingIdx === -1) return null;
    const host = authority.slice(1, closingIdx);
    const portPart = authority.slice(closingIdx + 1);
    const port = portPart.startsWith(':') ? Number.parseInt(portPart.slice(1), 10) : 443;
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }

  const [host, portStr] = authority.split(':');
  if (!host) return null;
  const port = portStr ? Number.parseInt(portStr, 10) : 443;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

const UPSTREAM_COOLDOWN_MS = 30000;

/**
 * Establish a CONNECT tunnel through a prioritized list of upstream proxies with automatic failover.
 * @param {{ host: string, port: number }} target
 * @param {net.Socket} clientSocket
 * @param {Buffer} head
 * @param {Array<{ raw: any, resolved: any }>} candidates
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {{ info: Function, error: Function }} log
 * @param {{ markFailure: Function, markSuccess: Function }} healthTracker
 */
function connectViaUpstreamPool(target, clientSocket, head, candidates, config, log, healthTracker) {
  const maxAttempts = Math.min(candidates.length, 5);
  let attempt = 0;

  function tryNext() {
    if (clientSocket.destroyed) return;
    if (attempt >= maxAttempts) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const { raw, resolved: upstreamProxy } = candidates[attempt++];
    const connectTransport = upstreamProxy.protocol === 'https:' ? tls : net;
    const connectOptions = upstreamProxy.protocol === 'https:'
      ? { host: upstreamProxy.host, port: upstreamProxy.port, servername: upstreamProxy.host }
      : { host: upstreamProxy.host, port: upstreamProxy.port };

    let settled = false;
    const upstreamSocket = connectTransport.connect(connectOptions, () => {
      let connectReq = `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n`;
      const upstreamAuth = buildUpstreamAuthHeader(upstreamProxy);
      if (upstreamAuth) {
        connectReq += `Proxy-Authorization: ${upstreamAuth}\r\n`;
      }
      connectReq += '\r\n';
      upstreamSocket.write(connectReq);

      let responseBuffer = Buffer.alloc(0);
      const onUpstreamData = (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        const headerEnd = responseBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        upstreamSocket.removeListener('data', onUpstreamData);
        const headerText = responseBuffer.subarray(0, headerEnd).toString('utf8');
        const statusLine = headerText.split('\r\n')[0] ?? '';
        const statusCode = Number.parseInt(statusLine.split(' ')[1] ?? '0', 10);

        if (statusCode !== 200) {
          settled = true;
          healthTracker.markFailure(raw, statusLine || `HTTP ${statusCode}`);
          log.error(`Upstream proxy ${upstreamProxy.host}:${upstreamProxy.port} rejected CONNECT (${statusLine})`);
          upstreamSocket.destroy();
          tryNext();
          return;
        }

        settled = true;
        healthTracker.markSuccess(raw);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const leftover = responseBuffer.subarray(headerEnd + 4);
        if (leftover.length > 0) {
          clientSocket.write(leftover);
        }
        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        log.info(`CONNECT ${target.host}:${target.port} via ${upstreamProxy.host}:${upstreamProxy.port}`);
      };

      upstreamSocket.on('data', onUpstreamData);
    });

    upstreamSocket.setTimeout(config.requestTimeoutMs, () => {
      upstreamSocket.destroy(new Error('CONNECT tunnel timed out'));
    });

    upstreamSocket.on('error', (err) => {
      if (settled) {
        if (!clientSocket.destroyed) {
          clientSocket.destroy();
        }
        return;
      }
      settled = true;
      healthTracker.markFailure(raw, err.message);
      log.error(`CONNECT error via ${upstreamProxy.host}:${upstreamProxy.port} for ${target.host}:${target.port}: ${err.message}`);
      tryNext();
    });

    clientSocket.once('error', () => {
      upstreamSocket.destroy();
    });
  }

  tryNext();
}

/**
 * Create a configured Node.js HTTP proxy server supporting reverse proxy,
 * optional forward proxy (`ENABLE_FORWARD_PROXY=true`), WebSocket upgrades,
 * and a live web configuration UI at `/config`.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} initialConfig
 * @param {{ info?: Function, error?: Function }} [logger]
 * @param {{ configPath?: string }} [options]
 */
export function createProxyServer(initialConfig, logger = console, options = {}) {
  let activeConfig = initialConfig;
  let upstreamIndex = 0;
  const upstreamHealth = new Map();
  const log = {
    info: logger.info ?? (() => {}),
    error: logger.error ?? (() => {}),
  };

  const healthTracker = {
    markFailure(proxy, reason) {
      const key = formatUpstreamProxy(proxy);
      const prev = upstreamHealth.get(key) ?? { failures: 0, cooldownUntil: 0, lastError: null };
      upstreamHealth.set(key, {
        failures: prev.failures + 1,
        cooldownUntil: Date.now() + UPSTREAM_COOLDOWN_MS,
        lastError: reason,
      });
    },
    markSuccess(proxy) {
      const key = formatUpstreamProxy(proxy);
      if (upstreamHealth.has(key)) {
        upstreamHealth.set(key, { failures: 0, cooldownUntil: 0, lastError: null });
      }
    },
  };

  function resolveProxyTemplate(proxy, country) {
    const countryVal = country ? country.toLowerCase() : '';
    const sessionVal = randomBytes(4).toString('hex');
    const expand = (val) =>
      val === null
        ? null
        : val.replace(/\{country\}/gi, countryVal).replace(/\{session\}/gi, sessionVal);

    return {
      ...proxy,
      username: expand(proxy.username),
      password: expand(proxy.password),
    };
  }

  function pickUpstreamCandidates(country = '') {
    const list = activeConfig.upstreamProxies;
    if (!list || list.length === 0) return [];

    let pool = list;
    const normalizedCountry = country.trim().toUpperCase();
    if (normalizedCountry) {
      const matched = list.filter(
        (p) =>
          p.country === normalizedCountry ||
          p.username?.includes('{country}') ||
          p.password?.includes('{country}')
      );
      pool = matched.length > 0 ? matched : list.filter((p) => !p.country);
      if (pool.length === 0) return [];
    }

    const start = upstreamIndex % pool.length;
    upstreamIndex = (upstreamIndex + 1) % list.length;
    const rotated = [...pool.slice(start), ...pool.slice(0, start)];

    const now = Date.now();
    const healthy = [];
    const cooling = [];
    for (const p of rotated) {
      const state = upstreamHealth.get(formatUpstreamProxy(p));
      if (state && state.cooldownUntil > now) {
        cooling.push(p);
      } else {
        healthy.push(p);
      }
    }

    return [...healthy, ...cooling].map((p) => ({
      raw: p,
      resolved: resolveProxyTemplate(p, normalizedCountry),
    }));
  }

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '/';

    if (req.method === 'GET' && rawUrl === '/health') {
      const now = Date.now();
      const total = activeConfig.upstreamProxies.length;
      let coolingDown = 0;
      for (const p of activeConfig.upstreamProxies) {
        const state = upstreamHealth.get(formatUpstreamProxy(p));
        if (state && state.cooldownUntil > now) coolingDown++;
      }
      const payload = JSON.stringify({
        status: 'ok',
        mode: {
          reverseProxy: Boolean(activeConfig.targetUrl),
          forwardProxy: activeConfig.enableForwardProxy,
        },
        ...(total > 0
          ? {
              upstreamHealth: {
                total,
                healthy: total - coolingDown,
                coolingDown,
              },
            }
          : {}),
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }

    // Redirect root browser visits to /config when no reverse proxy target is set
    if (req.method === 'GET' && rawUrl === '/' && !activeConfig.targetUrl) {
      res.writeHead(302, { location: '/config' });
      res.end();
      return;
    }

    // Web configuration UI & API
    if (rawUrl === '/config' || rawUrl === '/api/config') {
      if (!isAdminAuthorized(req, activeConfig.adminPassword)) {
        res.writeHead(401, {
          'www-authenticate': 'Basic realm="Proxy Admin"',
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end('Unauthorized');
        return;
      }

      if (req.method === 'GET' && rawUrl === '/config') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(CONFIG_HTML),
        });
        res.end(CONFIG_HTML);
        return;
      }

      if (req.method === 'GET' && rawUrl === '/api/config') {
        const payload = JSON.stringify(serializeConfigForUi(activeConfig));
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }

      if (req.method === 'POST' && rawUrl === '/api/config') {
        try {
          const body = await readJsonBody(req);
          const nextProxyPassword = body.clearProxyAuth
            ? ''
            : (body.proxyPassword || activeConfig.proxyAuth?.password || '');
          const nextProxyUsername = body.clearProxyAuth ? '' : body.proxyUsername;
          const nextAdminPassword = body.adminPassword || activeConfig.adminPassword || '';

          const restartRequired =
            Number(body.port ?? activeConfig.port) !== activeConfig.port ||
            String(body.host ?? activeConfig.host) !== activeConfig.host;

          let nextUpstreamProxies = body.upstreamProxies;
          if (nextUpstreamProxies !== undefined) {
            const parsedIncoming = parseUpstreamProxies(nextUpstreamProxies);
            nextUpstreamProxies = parsedIncoming.map((incoming) => {
              if (incoming.password !== '***') {
                return formatUpstreamProxy(incoming);
              }
              const existing = activeConfig.upstreamProxies.find(
                (p) =>
                  p.protocol === incoming.protocol &&
                  p.host === incoming.host &&
                  p.port === incoming.port &&
                  p.username === incoming.username &&
                  p.country === incoming.country
              );
              return formatUpstreamProxy(existing ?? incoming);
            });
          }

          activeConfig = saveConfig(
            {
              ...body,
              proxyUsername: nextProxyUsername,
              proxyPassword: nextProxyPassword,
              adminPassword: nextAdminPassword,
              ...(nextUpstreamProxies !== undefined ? { upstreamProxies: nextUpstreamProxies } : {}),
            },
            { configPath: options.configPath }
          );

          const payload = JSON.stringify({
            config: serializeConfigForUi(activeConfig),
            restartRequired,
          });
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
          });
          res.end(payload);
        } catch (err) {
          sendJsonError(res, 400, err.message);
        }
        return;
      }
    }

    if (activeConfig.corsOrigin && req.method === 'OPTIONS') {
      applyCorsHeaders(res, activeConfig.corsOrigin);
      res.writeHead(204);
      res.end();
      return;
    }

    // Forward proxy request (absolute URI)
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      if (!activeConfig.enableForwardProxy) {
        sendJsonError(res, 403, 'Forward proxy is disabled');
        return;
      }

      if (!isProxyAuthorized(req, activeConfig.proxyAuth)) {
        const body = JSON.stringify({ error: 'Proxy Authentication Required' });
        res.writeHead(407, {
          'proxy-authenticate': 'Basic realm="Proxy"',
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      let destinationUrl;
      try {
        destinationUrl = new URL(rawUrl);
      } catch {
        sendJsonError(res, 400, 'Invalid target URL');
        return;
      }

      if (isBlockedMetadataHost(destinationUrl.hostname, activeConfig.blockMetadata)) {
        sendJsonError(res, 403, 'Access to metadata service is blocked');
        return;
      }

      const requestedCountry = typeof req.headers['x-proxy-country'] === 'string'
        ? req.headers['x-proxy-country'].trim()
        : '';
      const candidates = pickUpstreamCandidates(requestedCountry);
      if (requestedCountry && activeConfig.upstreamProxies.length > 0 && candidates.length === 0) {
        sendJsonError(res, 502, `No upstream proxy available for country: ${requestedCountry}`);
        return;
      }

      const headers = stripHopByHopHeaders(req.headers);
      delete headers['x-proxy-country'];
      headers.host = destinationUrl.host;
      if (candidates.length > 0) {
        forwardViaUpstreamPool(req, res, destinationUrl, headers, activeConfig, log, candidates, healthTracker);
      } else {
        forwardRequest(req, res, destinationUrl, headers, activeConfig, log);
      }
      return;
    }

    // Reverse proxy request
    if (!activeConfig.targetUrl) {
      sendJsonError(res, 400, 'Reverse proxy TARGET_URL is not configured');
      return;
    }

    let destinationUrl;
    try {
      destinationUrl = resolveReverseTarget(rawUrl, activeConfig.targetUrl);
    } catch {
      sendJsonError(res, 400, 'Invalid request URL');
      return;
    }

    const headers = buildReverseProxyHeaders(req, activeConfig.targetUrl);
    forwardRequest(req, res, destinationUrl, headers, activeConfig, log);
  });

  // HTTPS / TCP tunneling via CONNECT for forward proxy mode
  server.on('connect', (req, clientSocket, head) => {
    if (!activeConfig.enableForwardProxy) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    if (!isProxyAuthorized(req, activeConfig.proxyAuth)) {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n'
      );
      clientSocket.destroy();
      return;
    }

    const target = parseAuthority(req.url ?? '');
    if (!target) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    if (isBlockedMetadataHost(target.host, activeConfig.blockMetadata)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const requestedCountry = typeof req.headers['x-proxy-country'] === 'string'
      ? req.headers['x-proxy-country'].trim()
      : '';
    const candidates = pickUpstreamCandidates(requestedCountry);
    if (requestedCountry && activeConfig.upstreamProxies.length > 0 && candidates.length === 0) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    if (candidates.length > 0) {
      connectViaUpstreamPool(target, clientSocket, head, candidates, activeConfig, log, healthTracker);
      return;
    }

    const upstreamSocket = net.connect({ host: target.host, port: target.port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      log.info(`CONNECT ${target.host}:${target.port}`);
    });

    upstreamSocket.setTimeout(activeConfig.requestTimeoutMs, () => {
      upstreamSocket.destroy(new Error('CONNECT tunnel timed out'));
    });

    upstreamSocket.on('error', (err) => {
      log.error(`CONNECT error for ${target.host}:${target.port}: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      }
    });

    clientSocket.on('error', () => {
      upstreamSocket.destroy();
    });
  });

  // WebSocket / HTTP upgrade forwarding for reverse proxy mode
  server.on('upgrade', (req, clientSocket, head) => {
    if (!activeConfig.targetUrl) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const destinationUrl = resolveReverseTarget(req.url ?? '/', activeConfig.targetUrl);
    const isTls = destinationUrl.protocol === 'https:';
    const port = Number(destinationUrl.port) || (isTls ? 443 : 80);

    const connectOptions = {
      host: destinationUrl.hostname,
      port,
      ...(isTls ? { servername: destinationUrl.hostname } : {}),
    };

    const upstreamSocket = (isTls ? tls : net).connect(connectOptions, () => {
      const headers = { ...req.headers, host: destinationUrl.host };
      const headerLines = Object.entries(headers)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);

      const requestHead =
        `${req.method} ${destinationUrl.pathname}${destinationUrl.search} HTTP/${req.httpVersion}\r\n` +
        `${headerLines.join('\r\n')}\r\n\r\n`;

      upstreamSocket.write(requestHead);
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      log.info(`UPGRADE ${req.url} -> ${destinationUrl.href}`);
    });

    upstreamSocket.on('error', (err) => {
      log.error(`Upgrade error for ${destinationUrl.href}: ${err.message}`);
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      upstreamSocket.destroy();
    });
  });

  return server;
}

