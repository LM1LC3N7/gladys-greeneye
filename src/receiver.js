// -----------------------------------------------------------------------------
// Entry point of the `gem-link` sub-container (manifest `containers`, same
// image, command `node src/receiver.js`): the TCP port the GreenEye Monitor connects to.
// No Gladys credentials here: see src/link/service.js.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { startLinkService } from './link/service.js';

const logger = createLogger({ name: 'gem-link' });

try {
  const service = await startLinkService({ env: process.env, logger });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info(`${signal}: stopping`);
      service.stop().finally(() => process.exit(0));
    });
  }
} catch (err) {
  logger.error(`The GEM link could not start: ${err.message}`);
  process.exit(1);
}
