import { fileURLToPath } from 'node:url';
import { App, LogLevel } from '@slack/bolt';
import { config } from 'dotenv';
import { registerBridge } from './bridge.js';
import { registerListeners } from './listeners/index.js';

config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

const requiredEnv = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  throw new Error(
    `Missing Slack environment variables: ${missingEnv.join(', ')}. Copy apps/slack/.env.sample to apps/slack/.env and fill in the values.`,
  );
}

/** Initialization */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG,
  clientOptions: {
    slackApiUrl: process.env.SLACK_API_URL,
  },
});

/** Register Listeners */
registerListeners(app);

/** Start the Bolt App */
(async () => {
  try {
    await app.start();
    registerBridge(app);
    app.logger.info('⚡️ Bolt app is running!');
  } catch (error) {
    app.logger.error('Failed to start the app', error);
  }
})();
