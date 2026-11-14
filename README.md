# Node.js Proxy Server

A lightweight, zero-dependency Node.js HTTP/HTTPS reverse and forward proxy server built on `node:http`, `node:https`, `node:net`, and `node:tls`.

## Features

- **Reverse Proxy**: Forwards incoming HTTP requests and WebSocket/HTTP `upgrade` connections to `TARGET_URL`, preserving paths, query strings, methods, and bodies while adding `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` headers.
- **Forward Proxy (optional)**: Supports standard HTTP proxy requests and HTTPS `CONNECT` tunneling when `ENABLE_FORWARD_PROXY=true`.
- **Health Check**: `GET /health` returns `{ "status": "ok", "mode": { ... } }`.
- **CORS Support**: Optional `CORS_ORIGIN` configuration with automatic `OPTIONS` preflight handling.
- **Timeouts & Error Handling**: Configurable upstream timeout (`REQUEST_TIMEOUT_MS`) returning `504 Gateway Timeout` on timeout and `502 Bad Gateway` on upstream connection errors.

## Quick Start

1. Start the server (no `.env` required):

   ```bash
   npm start
   # or with auto-reload during development:
   npm run dev
   ```

2. Open `http://localhost:8080` in your browser — it automatically redirects to `/config` where you can configure proxy mode, client authentication, metadata blocking, timeouts, and admin password. Settings are saved to `config.json` and applied live.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Host interface to bind |
| `TARGET_URL` | _(unset)_ | Upstream URL for reverse proxy mode |
| `ENABLE_FORWARD_PROXY` | `true` (if `TARGET_URL` unset) | Enable HTTP forward proxy and `CONNECT` tunneling |
| `PROXY_USERNAME` | _(unset)_ | Basic auth username for forward proxy clients |
| `PROXY_PASSWORD` | _(unset)_ | Basic auth password for forward proxy clients |
| `BLOCK_METADATA` | `true` | Block requests to `169.254.169.254` / `metadata.google.internal` |
| `CORS_ORIGIN` | _(unset)_ | Value for `Access-Control-Allow-Origin` |
| `REQUEST_TIMEOUT_MS` | `30000` | Upstream request timeout in milliseconds |

## Examples

**Reverse proxy mode:**

```bash
TARGET_URL=https://httpbin.org PORT=8080 npm start
curl http://localhost:8080/get
```

**Forward proxy mode:**

```bash
ENABLE_FORWARD_PROXY=true TARGET_URL= PORT=8080 npm start
curl -x http://localhost:8080 https://httpbin.org/get
```

## Hosting on a Google Cloud VM

1. **Install Node.js (v20+) on the VM** (Ubuntu/Debian example):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Deploy the app to `/opt/proxy-server` and configure `.env`**:

   ```bash
   sudo mkdir -p /opt/proxy-server
   # Copy repo files to /opt/proxy-server, then:
   sudo cp /opt/proxy-server/.env.example /opt/proxy-server/.env
   ```

   Set strong credentials in `/opt/proxy-server/.env` so your VM does not act as an open proxy on the public internet:

   ```env
   PORT=8080
   HOST=0.0.0.0
   ENABLE_FORWARD_PROXY=true
   PROXY_USERNAME=your-client-user
   PROXY_PASSWORD=your-strong-password
   BLOCK_METADATA=true
   ```

3. **Run as a systemd service** using [deploy/proxy-server.service](deploy/proxy-server.service):

   ```bash
   sudo cp /opt/proxy-server/deploy/proxy-server.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now proxy-server
   sudo systemctl status proxy-server
   ```

4. **Open the firewall port in Google Cloud**:
   Create a VPC firewall rule allowing ingress TCP on port `8080` (ideally restricted to your clients' source IP ranges) targeting your VM's network tag.

5. **Connect clients**:

   ```bash
   curl -x http://your-client-user:your-strong-password@VM_EXTERNAL_IP:8080 https://api.ipify.org
   ```

## Tests

```bash
npm test
```

# proxy-server
