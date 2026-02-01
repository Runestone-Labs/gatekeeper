import { config } from '../config.js';
import { PendingApproval } from '../types.js';
import { redactSecrets } from '../utils.js';
import { ApprovalProvider } from './types.js';

/**
 * Slack approval provider - sends approval requests via Slack webhook.
 * Requires SLACK_WEBHOOK_URL environment variable.
 */
export class SlackApprovalProvider implements ApprovalProvider {
  name = 'slack';

  async requestApproval(
    approval: PendingApproval,
    urls: { approveUrl: string; denyUrl: string }
  ): Promise<boolean> {
    if (!config.slackWebhookUrl) {
      console.warn('Slack webhook URL not configured, skipping notification');
      return false;
    }

    // Sanitize args for display
    const sanitizedArgs = redactSecrets(approval.args, 100);

    const message = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `Tool Approval Required: ${approval.toolName}`,
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Tool:*\n\`${approval.toolName}\``,
            },
            {
              type: 'mrkdwn',
              text: `*Agent:*\n${approval.actor.name}`,
            },
            {
              type: 'mrkdwn',
              text: `*Request ID:*\n\`${approval.requestId}\``,
            },
            {
              type: 'mrkdwn',
              text: `*Expires:*\n${new Date(approval.expiresAt).toLocaleString()}`,
            },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Arguments:*\n\`\`\`${sanitizedArgs}\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Approve',
                emoji: true,
              },
              style: 'primary',
              url: urls.approveUrl,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Deny',
                emoji: true,
              },
              style: 'danger',
              url: urls.denyUrl,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Approval ID: \`${approval.id}\``,
            },
          ],
        },
      ],
    };

    try {
      const response = await fetch(config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        console.error('Failed to send Slack notification:', response.status, await response.text());
        return false;
      }

      return true;
    } catch (err) {
      console.error('Error sending Slack notification:', err);
      return false;
    }
  }

  async notifyResult(
    approval: PendingApproval,
    action: 'approved' | 'denied',
    result?: string
  ): Promise<void> {
    if (!config.slackWebhookUrl) {
      return;
    }

    const emoji = action === 'approved' ? ':white_check_mark:' : ':x:';
    const color = action === 'approved' ? '#36a64f' : '#dc3545';

    const message: {
      attachments: Array<{
        color: string;
        blocks: Array<{ type: string; text?: { type: string; text: string } }>;
      }>;
    } = {
      attachments: [
        {
          color,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${emoji} *${approval.toolName}* was *${action}*`,
              },
            },
            {
              type: 'context',
              text: {
                type: 'mrkdwn',
                text: `Request ID: \`${approval.requestId}\` | Agent: ${approval.actor.name}`,
              },
            },
          ],
        },
      ],
    };

    if (result) {
      message.attachments[0].blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Result:*\n\`\`\`${result.slice(0, 500)}\`\`\``,
        },
      });
    }

    try {
      await fetch(config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
    } catch {
      // Ignore errors on result notifications
    }
  }
}
