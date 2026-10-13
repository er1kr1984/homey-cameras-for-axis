'use strict';

module.exports = {
  async traffic({ homey, body }) {
    return homey.app.widgetTraffic(body);
  },
};
