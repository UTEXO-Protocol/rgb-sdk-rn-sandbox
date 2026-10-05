#!/usr/bin/env node
/**
 * local-node-bridge
 *
 * Thin HTTP shim that translates the demo app's bitcoin-node HTTP API calls
 * into docker-compose bitcoin-cli commands against the local regtest stack.
 *
 * Usage:
 *   1. Start regtest services:  ./regtest.sh start
 *   2. Start this bridge:       node local-node-bridge.js
 *   3. Set in demo .env:        BITCOIN_NODE_ENDPOINT=http://127.0.0.1:5000/execute
 *
 * Supported commands (sent as JSON body { "args": "<cmd> [args...]" }):
 *   mine <numBlocks>
 *   sendtoaddress <address> <amount>
 *   gettxout <txid> <vout>
 *   getblockchaininfo
 *   <any other bitcoin-cli command>
 */

const http = require('http');
const { execSync } = require('child_process');

const PORT = Number(process.env.BRIDGE_PORT ?? 5000);
const RGBLN_REPO = process.env.RGBLN_REPO ?? '';
const CLI = RGBLN_REPO
  ? `docker compose --project-directory ${RGBLN_REPO} exec -T -u blits bitcoind bitcoin-cli -regtest`
  : 'docker compose exec -T -u blits bitcoind bitcoin-cli -regtest';

function runCli(cliCmd) {
  return execSync(cliCmd, { timeout: 30000 }).toString().trim();
}

function buildCliCommand(args) {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0];

  if (cmd === 'mine') {
    return `${CLI} -rpcwallet=miner -generate ${parts[1]}`;
  }
  if (cmd === 'sendtoaddress') {
    return `${CLI} -rpcwallet=miner sendtoaddress ${parts[1]} ${parts[2]}`;
  }
  if (cmd === 'gettxout') {
    return `${CLI} gettxout ${parts.slice(1).join(' ')}`;
  }
  // passthrough for any other bitcoin-cli command
  return `${CLI} ${args}`;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    try {
      const { args } = JSON.parse(body);
      if (typeof args !== 'string' || !args.trim()) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Missing or invalid "args" field' }));
        return;
      }

      const cliCmd = buildCliCommand(args);
      const stdout = runCli(cliCmd);

      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = stdout;
      }

      res.end(JSON.stringify({ result }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`local-node-bridge listening on http://127.0.0.1:${PORT}/execute`);
  console.log('Set BITCOIN_NODE_ENDPOINT=http://127.0.0.1:5000/execute in the demo .env');
});

server.on('error', err => {
  console.error('Server error:', err.message);
  process.exit(1);
});
