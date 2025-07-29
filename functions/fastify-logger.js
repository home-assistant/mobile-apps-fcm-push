'use strict';

/**
 * A light adaption of the logger config for fastify documented from:
 * https://cloud.google.com/stackdriver/docs/instrumentation/setup/nodejs
 */

/**
 * @type {Record<string, string | undefined>}
 */
const PinoLevelToSeverityLookup = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

const loggerConfig = {
  messageKey: 'message',
  // Same as pino.stdTimeFunctions.isoTime but uses "timestamp" key instead of "time"
  /**
   * @returns {string}
   */
  timestamp() {
    return `,"timestamp":"${new Date(Date.now()).toISOString()}"`;
  },
  formatters: {
    // See
    // https://getpino.io/#/docs/help?id=mapping-pino-log-levels-to-google-cloud-logging-stackdriver-severity-levels
    /**
     * @param {string} label
     * @returns {Object}
     */
    level(label) {
      return {
        severity:
          PinoLevelToSeverityLookup[label] !== undefined
            ? PinoLevelToSeverityLookup[label]
            : PinoLevelToSeverityLookup['info'],
      };
    },
  },
};

module.exports = { loggerConfig };
