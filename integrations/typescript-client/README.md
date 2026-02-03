# Runestone Gatekeeper TypeScript Client

A minimal, framework-agnostic TypeScript client for [Runestone Gatekeeper](https://github.com/Runestone-Labs/gatekeeper).

## Installation

```bash
# Copy to your project or import directly
cp -r integrations/typescript-client ./gatekeeper-client
```

## Usage

```typescript
import { GatekeeperClient } from './gatekeeper-client';

// Initialize client
const gk = new GatekeeperClient({
  baseUrl: 'http://localhost:3847',
  agentName: 'my-agent',
  runId: 'optional-correlation-id'
});

// Or simply:
const gk = new GatekeeperClient('http://localhost:3847');

// Execute a shell command
const result = await gk.shellExec({ command: 'ls -la' });

if (result.decision === 'allow') {
  // Command was executed
  console.log(result.result.stdout);
} else if (result.decision === 'approve') {
  // Human approval required
  console.log('Waiting for approval:', result.approvalId);
  console.log('Expires:', result.expiresAt);
} else {
  // Denied by policy
  console.error('Denied:', result.reason);
}
```

## Available Methods

### `shellExec(args)`
Execute a shell command.
```typescript
await gk.shellExec({
  command: 'npm install',
  cwd: '/path/to/project',
  timeoutMs: 30000
});
```

### `filesWrite(args)`
Write a file.
```typescript
await gk.filesWrite({
  path: '/tmp/output.txt',
  content: 'Hello, world!',
  encoding: 'utf8' // or 'base64'
});
```

### `httpRequest(args)`
Make an HTTP request.
```typescript
await gk.httpRequest({
  url: 'https://api.example.com/data',
  method: 'POST',
  headers: { 'Authorization': 'Bearer token' },
  body: JSON.stringify({ key: 'value' })
});
```

### `callTool(tool, args)`
Low-level method for calling any tool.
```typescript
await gk.callTool('shell.exec', { command: 'echo hello' });
```

### `health()`
Check if Gatekeeper is running.
```typescript
const status = await gk.health();
console.log(status.version, status.demoMode);
```

## Response Types

All methods return a `GatekeeperResult<T>`:

```typescript
interface GatekeeperResult<T> {
  decision: 'allow' | 'approve' | 'deny';
  requestId: string;

  // When decision === 'allow'
  result?: T;
  success?: boolean;

  // When decision === 'approve'
  approvalId?: string;
  expiresAt?: string;

  // When decision === 'deny'
  reason?: string;
}
```

## Integration Examples

See the `integrations/` directory for examples of wrapping this client for specific agent frameworks:

- [OpenClaw](../openclaw/) - OpenClaw skill integration

## License

Apache-2.0
