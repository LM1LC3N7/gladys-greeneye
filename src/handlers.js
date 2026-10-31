// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the monitor and its channels appear once the GEM sent packets.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated(() => app.deviceChanged());
  gladys.onDeviceUpdated(() => app.deviceChanged());
  gladys.onDeviceDeleted(() => app.deviceChanged());

  // Configuration screen button: the counters held back, in two clicks.
  gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldButton());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated');
    return app.configUpdated(config);
  });

  // Connection lifecycle: the configuration is read (retried without end
  // while it fails), then the status and the Discovery are sent again (the
  // core keeps them in memory only).
  gladys.on('connected', () => {
    app.gladysConnected().catch((err) => logger?.error('Start failed', err));
  });
}
