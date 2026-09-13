import { registerApprovalActions } from './approval-actions.js';
import { sampleActionCallback } from './sample-action.js';

export const register = (app) => {
  app.action('sample_action_id', sampleActionCallback);
  registerApprovalActions(app);
};
