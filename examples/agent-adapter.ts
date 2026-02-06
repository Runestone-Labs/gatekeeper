/**
 * Agent Adapter Example
 *
 * This example demonstrates how an agent framework might route
 * tool calls through Runestone Gatekeeper.
 *
 * It is intentionally incomplete and not production-ready.
 * It is not imported or tested as part of this repository.
 *
 * The pattern shown here applies to any agent that supports
 * tool/function abstraction: LangChain, OpenAI Assistants,
 * Anthropic Claude, AutoGPT, custom agents, etc.
 */

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface GatekeeperResponse {
  decision: 'allow' | 'approve' | 'deny';
  requestId: string;
  result?: unknown;
  reasonCode?: string;
  humanExplanation?: string;
  approvalId?: string;
  expiresAt?: string;
}

/**
 * Wraps tool execution to route through Gatekeeper.
 *
 * Instead of executing tools directly, the agent calls this adapter.
 * The adapter handles policy enforcement transparently.
 */
async function executeToolViaGatekeeper(
  toolCall: ToolCall,
  options: {
    gatekeeperUrl: string;
    agentName: string;
    role: string;
    runId: string;
    onApprovalRequired?: (approvalId: string, expiresAt: string) => void;
  }
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const { gatekeeperUrl, agentName, role, runId, onApprovalRequired } = options;

  const response = await fetch(`${gatekeeperUrl}/tool/${toolCall.tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      actor: {
        type: 'agent',
        name: agentName,
        role,
        runId,
      },
      args: toolCall.args,
    }),
  });

  const data: GatekeeperResponse = await response.json();

  switch (data.decision) {
    case 'allow':
      // Tool executed successfully
      return { success: true, result: data.result };

    case 'approve':
      // Human approval required
      // In a real agent, you might:
      // - Pause and wait for approval callback
      // - Queue for later retry
      // - Notify the user and continue with other tasks
      if (onApprovalRequired && data.approvalId && data.expiresAt) {
        onApprovalRequired(data.approvalId, data.expiresAt);
      }
      return {
        success: false,
        error: `Approval required: ${data.humanExplanation}`,
      };

    case 'deny':
      // Action blocked by policy
      return {
        success: false,
        error: `Denied: ${data.humanExplanation}`,
      };

    default:
      return {
        success: false,
        error: 'Unknown decision from gatekeeper',
      };
  }
}

// -----------------------------------------------------------------------------
// Example usage (illustrative, not runnable as-is)
// -----------------------------------------------------------------------------

/*
// In your agent's tool execution layer:

const result = await executeToolViaGatekeeper(
  {
    tool: 'shell.exec',
    args: { command: 'ls -la /tmp' },
  },
  {
    gatekeeperUrl: 'http://127.0.0.1:3847',
    agentName: 'my-agent',
    role: 'openclaw',
    runId: 'run-123',
    onApprovalRequired: (approvalId, expiresAt) => {
      console.log(`Waiting for approval: ${approvalId}`);
      console.log(`Expires at: ${expiresAt}`);
      // Implement your wait/retry logic here
    },
  }
);

if (result.success) {
  console.log('Tool output:', result.result);
} else {
  console.log('Tool blocked:', result.error);
  // Agent should adapt: try alternative approach, ask user, or fail gracefully
}
*/

export { executeToolViaGatekeeper };
export type { ToolCall, GatekeeperResponse };
