'use strict';

module.exports = {
  async timeline({ homey, body }) {
    return homey.app.widgetTimeline(body);
  },
  async picture({ homey, body }) {
    return homey.app.widgetPicture(body);
  },
};
