#!/usr/bin/env tsx
/**
 * Fake AWS EC2 Metadata Server
 *
 * Simulates the EC2 instance metadata endpoint (169.254.169.254) for demo purposes.
 * Returns realistic-looking but obviously fake AWS credentials.
 *
 * Usage: tsx scripts/fake-metadata-server.ts
 * Runs on 127.0.0.1:9999
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

const PORT = parseInt(process.env.METADATA_PORT || '9999', 10);

// Fake but realistic-looking AWS credentials
const FAKE_CREDENTIALS = {
  Code: 'Success',
  LastUpdated: new Date().toISOString(),
  Type: 'AWS-HMAC',
  AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  Token: 'FwoGZXIvYXdzEBYaDkExample...TruncatedForDemo',
  Expiration: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), // 6 hours from now
};

const ROLE_NAME = 'demo-instance-role';

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url || '/';

  // Simulate EC2 metadata paths
  if (url === '/latest/meta-data/iam/security-credentials/') {
    // List available roles
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(ROLE_NAME);
    return;
  }

  if (url === `/latest/meta-data/iam/security-credentials/${ROLE_NAME}`) {
    // Return credentials for the role
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(FAKE_CREDENTIALS, null, 2));
    return;
  }

  if (url === '/latest/meta-data/instance-id') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('i-0123456789abcdef0');
    return;
  }

  if (url === '/latest/meta-data/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('instance-id\niam/\nhostname\nlocal-ipv4');
    return;
  }

  // 404 for unknown paths
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

const server = createServer(handleRequest);

server.listen(PORT, '127.0.0.1', () => {
  // Silent startup - the wow demo will start this in the background
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
