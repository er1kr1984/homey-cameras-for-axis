'use strict';

// Errors with a code the app turns into plain-language messages (see locales errors.*).
//   unreachable    the camera did not answer (off, wrong address, other network)
//   login_failed   username or password refused
//   forbidden      the user may not do this (e.g. a viewer account asked to move PTZ)
//   cert_changed   the camera's HTTPS certificate is not the one seen when it was added
//   not_supported  the camera has no such function (or its AXIS OS is too old)
//   bad_response   the camera answered something we could not read
class AxisError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { AxisError };
