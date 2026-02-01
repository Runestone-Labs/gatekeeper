import { ApprovalProvider } from './types.js';
import { PendingApproval } from '../types.js';

/**
 * Local approval provider - logs approval URLs to console.
 * Useful for development and single-user setups.
 */
export class LocalApprovalProvider implements ApprovalProvider {
  name = 'local';

  async requestApproval(
    approval: PendingApproval,
    urls: { approveUrl: string; denyUrl: string }
  ): Promise<boolean> {
    console.log('\n========================================');
    console.log('APPROVAL REQUIRED');
    console.log('========================================');
    console.log(`Tool: ${approval.toolName}`);
    console.log(`Agent: ${approval.actor.name}`);
    console.log(`Request ID: ${approval.requestId}`);
    console.log(`Expires: ${approval.expiresAt}`);
    console.log('');
    console.log('Arguments:', JSON.stringify(approval.args, null, 2));
    console.log('');
    console.log('Approve:', urls.approveUrl);
    console.log('Deny:', urls.denyUrl);
    console.log('========================================\n');

    return true;
  }

  async notifyResult(
    approval: PendingApproval,
    action: 'approved' | 'denied',
    result?: string
  ): Promise<void> {
    const emoji = action === 'approved' ? '✓' : '✗';
    console.log(`\n${emoji} ${approval.toolName} was ${action}`);
    if (result) {
      console.log(`Result: ${result.slice(0, 200)}...`);
    }
  }
}
