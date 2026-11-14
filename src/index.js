import { loadConfig } from './config.js';
import { createProxyServer } from './proxy.js';

const config = loadConfig();
const server = createProxyServer(config);

server.listen(config.port, config.host, () => {
  const address = server.address();
  const displayPort = typeof address === 'object' && address ? address.port : config.port;
  console.log(`Proxy server listening on http://${config.host}:${displayPort}`);
  console.log(`  Configuration UI: http://localhost:${displayPort}/config`);
  if (config.targetUrl) {
    console.log(`  Reverse proxy target: ${config.targetUrl.href}`);
  }
  if (config.enableForwardProxy) {
    console.log('  Forward proxy (HTTP + HTTPS CONNECT): enabled');
  }
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  server.close((err) => {
    if (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

