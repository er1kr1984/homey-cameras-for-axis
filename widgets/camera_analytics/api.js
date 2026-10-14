'use strict';

module.exports = {
  async state({ homey, body }) {
    return homey.app.widgetState(body);
  },
  async scene({ homey, body }) {
    return homey.app.widgetScene(body);
  },
  async snapshot({ homey, body }) {
    return homey.app.widgetSnapshot(body);
  },
  async offer({ homey, body }) {
    return homey.app.widgetOffer(body);
  },
};
