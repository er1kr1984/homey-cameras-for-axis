'use strict';

module.exports = {
  async heatmap({ homey, body }) {
    return homey.app.widgetHeatmap(body);
  },
};
