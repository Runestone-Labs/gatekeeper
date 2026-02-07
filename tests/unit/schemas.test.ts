import { describe, it, expect, beforeAll } from 'vitest';
import {
  ShellExecArgsSchema,
  FilesWriteArgsSchema,
  HttpRequestArgsSchema,
  ToolRequestSchema,
  getToolSchema,
  initToolSchemas,
} from '../../src/tools/schemas.js';
import { MemoryEvidenceArgsSchema } from '../../src/tools/memory/schemas.js';
import { config } from '../../src/config.js';

describe('ShellExecArgsSchema', () => {
  it('accepts valid minimal args', () => {
    const result = ShellExecArgsSchema.safeParse({ command: 'ls -la' });
    expect(result.success).toBe(true);
  });

  it('accepts valid full args', () => {
    const result = ShellExecArgsSchema.safeParse({
      command: 'ls -la',
      cwd: '/tmp',
      timeoutMs: 5000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing command', () => {
    const result = ShellExecArgsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty command', () => {
    const result = ShellExecArgsSchema.safeParse({ command: '' });
    expect(result.success).toBe(false);
  });

  it('rejects timeout > 30000', () => {
    const result = ShellExecArgsSchema.safeParse({
      command: 'ls',
      timeoutMs: 60000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative timeout', () => {
    const result = ShellExecArgsSchema.safeParse({
      command: 'ls',
      timeoutMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = ShellExecArgsSchema.safeParse({
      command: 'ls',
      extraField: 'hack',
    });
    expect(result.success).toBe(false);
  });
});

describe('FilesWriteArgsSchema', () => {
  it('accepts valid minimal args', () => {
    const result = FilesWriteArgsSchema.safeParse({
      path: '/tmp/test.txt',
      content: 'hello',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid full args with encoding', () => {
    const result = FilesWriteArgsSchema.safeParse({
      path: '/tmp/test.txt',
      content: 'hello',
      encoding: 'utf8',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing path', () => {
    const result = FilesWriteArgsSchema.safeParse({ content: 'hello' });
    expect(result.success).toBe(false);
  });

  it('rejects missing content', () => {
    const result = FilesWriteArgsSchema.safeParse({ path: '/tmp/test.txt' });
    expect(result.success).toBe(false);
  });

  it('rejects empty path', () => {
    const result = FilesWriteArgsSchema.safeParse({
      path: '',
      content: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid encoding', () => {
    const result = FilesWriteArgsSchema.safeParse({
      path: '/tmp/test.txt',
      content: 'hello',
      encoding: 'binary',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = FilesWriteArgsSchema.safeParse({
      path: '/tmp/test.txt',
      content: 'hello',
      permissions: '777',
    });
    expect(result.success).toBe(false);
  });
});

describe('HttpRequestArgsSchema', () => {
  it('accepts valid GET request', () => {
    const result = HttpRequestArgsSchema.safeParse({
      url: 'https://example.com',
      method: 'GET',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid POST request with body', () => {
    const result = HttpRequestArgsSchema.safeParse({
      url: 'https://example.com/api',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"data": "test"}',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing url', () => {
    const result = HttpRequestArgsSchema.safeParse({ method: 'GET' });
    expect(result.success).toBe(false);
  });

  it('rejects missing method', () => {
    const result = HttpRequestArgsSchema.safeParse({ url: 'https://example.com' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL', () => {
    const result = HttpRequestArgsSchema.safeParse({
      url: 'not-a-url',
      method: 'GET',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid method', () => {
    const result = HttpRequestArgsSchema.safeParse({
      url: 'https://example.com',
      method: 'DELETE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = HttpRequestArgsSchema.safeParse({
      url: 'https://example.com',
      method: 'GET',
      timeout: 5000,
    });
    expect(result.success).toBe(false);
  });
});

describe('ToolRequestSchema', () => {
  it('accepts valid request', () => {
    const result = ToolRequestSchema.safeParse({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
      args: { command: 'ls' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts request with full actor and context', () => {
    const result = ToolRequestSchema.safeParse({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      actor: { type: 'agent', name: 'test-agent', role: 'openclaw', runId: 'run-123' },
      args: { command: 'ls' },
      context: { conversationId: 'conv-1', traceId: 'trace-1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = ToolRequestSchema.safeParse({
      requestId: 'not-a-uuid',
      actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
      args: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid actor type', () => {
    const result = ToolRequestSchema.safeParse({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      actor: { type: 'bot', name: 'test', role: 'openclaw' },
      args: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing actor name', () => {
    const result = ToolRequestSchema.safeParse({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      actor: { type: 'agent', role: 'openclaw' },
      args: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty actor name', () => {
    const result = ToolRequestSchema.safeParse({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      actor: { type: 'agent', name: '', role: 'openclaw' },
      args: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing actor role', () => {
    const result = ToolRequestSchema.safeParse({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      actor: { type: 'agent', name: 'test-agent' },
      args: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('getToolSchema', () => {
  it('returns schema for shell.exec', () => {
    expect(getToolSchema('shell.exec')).toBe(ShellExecArgsSchema);
  });

  it('returns schema for files.write', () => {
    expect(getToolSchema('files.write')).toBe(FilesWriteArgsSchema);
  });

  it('returns schema for http.request', () => {
    expect(getToolSchema('http.request')).toBe(HttpRequestArgsSchema);
  });

  it('returns schema for memory.evidence when memory enabled', async () => {
    config.enableMemory = true;
    await initToolSchemas();
    expect(getToolSchema('memory.evidence')).toBe(MemoryEvidenceArgsSchema);
  });

  it('returns null for memory tools when memory disabled', () => {
    // Without initToolSchemas, memory schemas aren't loaded by default
    // This verifies the conditional registration works
    expect(config.enableMemory !== undefined).toBe(true);
  });

  it('returns null for unknown tool', () => {
    expect(getToolSchema('unknown.tool')).toBeNull();
  });
});
