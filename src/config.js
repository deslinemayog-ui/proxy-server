import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'config.json');

/**
 * Validate and normalize a raw config object into the runtime config shape.
 * @param {Record<string, any>} raw
 */
export function normalizeConfig(raw) {
  const port = Number.parseInt(String(raw.port ?? '8080'), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw.port}`);
  }

  const host = String(raw.host ?? '0.0.0.0').trim() || '0.0.0.0';

  const rawTarget = typeof raw.targetUrl === 'string' ? raw.targetUrl.trim() : '';
  let targetUrl = null;
  if (rawTarget) {
    targetUrl = new URL(rawTarget);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      throw new Error(`Unsupported TARGET_URL protocol: ${targetUrl.protocol}`);
    }
  }

  let enableForwardProxy;
  if (typeof raw.enableForwardProxy === 'boolean') {
    enableForwardProxy = raw.enableForwardProxy;
  } else if (raw.enableForwardProxy !== undefined && raw.enableForwardProxy !== null && raw.enableForwardProxy !== '') {
    enableForwardProxy = String(raw.enableForwardProxy) === 'true';
  } else {
    enableForwardProxy = !targetUrl;
  }

  if (!targetUrl && !enableForwardProxy) {
    throw new Error('Configure TARGET_URL for reverse proxy mode or set ENABLE_FORWARD_PROXY=true.');
  }

  const corsOrigin = typeof raw.corsOrigin === 'string' && raw.corsOrigin.trim() ? raw.corsOrigin.trim() : null;

  const requestTimeoutMs = Number.parseInt(String(raw.requestTimeoutMs ?? '30000'), 10);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`Invalid REQUEST_TIMEOUT_MS: ${raw.requestTimeoutMs}`);
  }

  const proxyUsername = typeof raw.proxyUsername === 'string' ? raw.proxyUsername.trim() : '';
  const proxyPassword = typeof raw.proxyPassword === 'string' ? raw.proxyPassword : '';
  if ((proxyUsername && !proxyPassword) || (!proxyUsername && proxyPassword)) {
    throw new Error('Set both proxyUsername and proxyPassword together.');
  }

  const blockMetadata =
    typeof raw.blockMetadata === 'boolean'
      ? raw.blockMetadata
      : raw.blockMetadata !== 'false';

  const adminPassword = typeof raw.adminPassword === 'string' && raw.adminPassword.length > 0
    ? raw.adminPassword
    : null;

  const upstreamProxies = parseUpstreamProxies(raw.upstreamProxies);

  return {
    port,
    host,
    targetUrl,
    enableForwardProxy,
    corsOrigin,
    requestTimeoutMs,
    proxyAuth: proxyUsername ? { username: proxyUsername, password: proxyPassword } : null,
    blockMetadata,
    adminPassword,
    upstreamProxies,
  };
}

/**
 * Format a normalized upstream proxy object back to string form.
 * @param {{ protocol: string, host: string, port: number, username: string | null, password: string | null, country: string | null }} proxy
 * @param {{ maskPassword?: boolean }} [options]
 */
export function formatUpstreamProxy(proxy, options = {}) {
  const { maskPassword = false } = options;
  const hasAuth = proxy.username !== null || proxy.password !== null;
  if (proxy.protocol === 'http:' && !hasAuth && !proxy.country) {
    return `${proxy.host}:${proxy.port}`;
  }

  let auth = '';
  if (hasAuth) {
    const user = encodeURIComponent(proxy.username ?? '');
    const pass = proxy.password !== null
      ? (maskPassword ? '***' : encodeURIComponent(proxy.password))
      : '';
    auth = proxy.password !== null ? `${user}:${pass}@` : `${user}@`;
  }

  const fragment = proxy.country ? `#${proxy.country}` : '';
  return `${proxy.protocol}//${auth}${proxy.host}:${proxy.port}${fragment}`;
}

/**
 * Parse upstream proxies from an array or comma/newline-separated string.
 * Supports `host:port`, `http://[user:pass@]host:port[#CC]`, and `https://[user:pass@]host:port[#CC]`.
 * @param {unknown} input
 * @returns {Array<{ protocol: 'http:' | 'https:', host: string, port: number, username: string | null, password: string | null, country: string | null }>}
 */
export function parseUpstreamProxies(input) {
  if (!input) return [];
  const items = Array.isArray(input)
    ? input
    : String(input).split(/[\n,]+/);

  const proxies = [];
  for (const rawItem of items) {
    const trimmed = String(rawItem).trim();
    if (!trimmed) continue;

    const normalized = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported upstream proxy protocol: ${parsed.protocol}`);
    }
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    const port = Number.parseInt(parsed.port || defaultPort, 10);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid upstream proxy entry: ${trimmed}`);
    }

    const hasUser = parsed.username !== '';
    const hasPass = parsed.password !== '';
    const country = parsed.hash ? parsed.hash.slice(1).trim().toUpperCase() || null : null;

    proxies.push({
      protocol: parsed.protocol,
      host: parsed.hostname,
      port,
      username: hasUser || hasPass ? decodeURIComponent(parsed.username) : null,
      password: hasPass ? decodeURIComponent(parsed.password) : (hasUser ? '' : null),
      country,
    });
  }
  return proxies;
}

/**
 * Load configuration from `config.json` (when using `process.env` or `configPath`) and environment variables.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {{ configPath?: string }} [options]
 */
export function loadConfig(env = process.env, options = {}) {
  const isDefaultEnv = env === process.env;
  const configPath = options.configPath ?? (isDefaultEnv ? (env.CONFIG_PATH || DEFAULT_CONFIG_PATH) : null);

  if (isDefaultEnv) {
    const envPath = resolve(process.cwd(), '.env');
    if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
    }
  }

  let fileConfig = {};
  if (configPath && existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  }

  return normalizeConfig({
    port: fileConfig.port ?? env.PORT,
    host: fileConfig.host ?? env.HOST,
    targetUrl: fileConfig.targetUrl ?? env.TARGET_URL,
    enableForwardProxy: fileConfig.enableForwardProxy ?? env.ENABLE_FORWARD_PROXY,
    corsOrigin: fileConfig.corsOrigin ?? env.CORS_ORIGIN,
    requestTimeoutMs: fileConfig.requestTimeoutMs ?? env.REQUEST_TIMEOUT_MS,
    proxyUsername: fileConfig.proxyUsername ?? env.PROXY_USERNAME,
    proxyPassword: fileConfig.proxyPassword ?? env.PROXY_PASSWORD,
    blockMetadata: fileConfig.blockMetadata ?? env.BLOCK_METADATA,
    adminPassword: fileConfig.adminPassword ?? env.ADMIN_PASSWORD,
    upstreamProxies: fileConfig.upstreamProxies ?? env.UPSTREAM_PROXIES,
  });
}

/**
 * Persist configuration to `config.json` and return the normalized runtime config.
 * @param {Record<string, any>} raw
 * @param {{ configPath?: string }} [options]
 */
export function saveConfig(raw, options = {}) {
  const normalized = normalizeConfig(raw);
  const configPath = options.configPath ?? (process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH);

  const serializable = {
    port: normalized.port,
    host: normalized.host,
    targetUrl: normalized.targetUrl ? normalized.targetUrl.href : '',
    enableForwardProxy: normalized.enableForwardProxy,
    corsOrigin: normalized.corsOrigin ?? '',
    requestTimeoutMs: normalized.requestTimeoutMs,
    proxyUsername: normalized.proxyAuth?.username ?? '',
    proxyPassword: normalized.proxyAuth?.password ?? '',
    blockMetadata: normalized.blockMetadata,
    adminPassword: normalized.adminPassword ?? '',
    upstreamProxies: normalized.upstreamProxies.map((p) => formatUpstreamProxy(p)),
  };

  writeFileSync(configPath, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
  return normalized;
}

/**
 * Return a safe representation of the config for the web UI (masking secrets).
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function serializeConfigForUi(config) {
  return {
    port: config.port,
    host: config.host,
    targetUrl: config.targetUrl ? config.targetUrl.href : '',
    enableForwardProxy: config.enableForwardProxy,
    corsOrigin: config.corsOrigin ?? '',
    requestTimeoutMs: config.requestTimeoutMs,
    proxyUsername: config.proxyAuth?.username ?? '',
    hasProxyPassword: Boolean(config.proxyAuth?.password),
    blockMetadata: config.blockMetadata,
    hasAdminPassword: Boolean(config.adminPassword),
    upstreamProxies: config.upstreamProxies.map((p) => formatUpstreamProxy(p, { maskPassword: true })),
  };
}
