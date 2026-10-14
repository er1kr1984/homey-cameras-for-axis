'use strict';

module.exports = {
  async overview({ homey }) {
    return homey.app.widgetOverview();
  },
};
