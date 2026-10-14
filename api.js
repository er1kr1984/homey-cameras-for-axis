'use strict';

// Endpoints of the app's settings page (Homey login required).
module.exports = {
  async getSettingsState({ homey }) {
    return homey.app.settingsState();
  },
  async setDiagnostics({ homey, body }) {
    return homey.app.settingsSetDiagnostics(body && body.on);
  },
  // Only with diagnostics switched on in the app settings.
  async getLogs({ homey }) {
    return homey.app.diagnosticsLogs(false);
  },
  async getPreviousLogs({ homey }) {
    return homey.app.diagnosticsLogs(true);
  },
  // What each camera offers (VAPIX APIs, properties, event types and how the app uses them).
  async getCameraFeatures({ homey }) {
    return homey.app.diagnosticsFeatures();
  },
};
