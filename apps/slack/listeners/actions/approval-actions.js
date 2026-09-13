import { setApproval } from '../../bridge.js';

export const registerApprovalActions = (app) => {
  app.action('agentverify_approve', async ({ ack, body, client, respond, logger }) => {
    await ack();
    try {
      await setApproval(body.actions[0].value, 'approved', body.message.ts, client);
      await respond({ response_type: 'ephemeral', text: 'Approved. AgentVerify can create the GitHub issue.' });
    } catch (error) {
      logger.error(error);
    }
  });

  app.action('agentverify_reject', async ({ ack, body, client, respond, logger }) => {
    await ack();
    try {
      await setApproval(body.actions[0].value, 'rejected', body.message.ts, client);
      await respond({ response_type: 'ephemeral', text: 'No issue will be created.' });
    } catch (error) {
      logger.error(error);
    }
  });
};
