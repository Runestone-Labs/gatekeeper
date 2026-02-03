import { config } from '../config.js';
import { PendingApproval } from '../types.js';
import { redactSecrets } from '../utils.js';

/**
 * Send a Slack notification for an approval request.
 * SECURITY: Sanitizes args before sending.
 */
export async function sendSlackApprovalNotification(params: {
  approval: PendingApproval;
  approveUrl: string;
  denyUrl: string;
}): Promise<boolean> {
  if (!config.slackWebhookUrl) {
    console.warn('Slack webhook URL not configured, skipping notification');
    return false;
  }

  const { approval, approveUrl, denyUrl } = params;

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
            url: approveUrl,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Deny',
              emoji: true,
            },
            style: 'danger',
            url: denyUrl,
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

/**
 * Send a Slack notification for an approval action result.
 */
export async function sendSlackActionNotification(params: {
  approval: PendingApproval;
  action: 'approved' | 'denied';
  result?: string;
}): Promise<boolean> {
  if (!config.slackWebhookUrl) {
    return false;
  }

  const { approval, action, result } = params;

  const emoji = action === 'approved' ? ':white_check_mark:' : ':x:';
  const color = action === 'approved' ? '#36a64f' : '#dc3545';

  const message = {
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
            elements: [
              {
                type: 'mrkdwn',
                text: `Request ID: \`${approval.requestId}\` | Agent: ${approval.actor.name}`,
              },
            ],
          },
        ],
      },
    ],
  };

  if (result) {
    (
      message.attachments[0].blocks as Array<{
        type: string;
        text?: { type: string; text: string };
      }>
    ).push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Result:*\n\`\`\`${result.slice(0, 500)}\`\`\``,
      },
    });
  }

  try {
    const response = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    return response.ok;
  } catch {
    return false;
  }
}
