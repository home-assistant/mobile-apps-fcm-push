'use strict';

/**
 * @typedef {Object} RateLimits
 * @property {number} attempts - Total number of attempts made
 * @property {number} successful - Number of successfully delivered notifications
 * @property {number} errors - Number of failed notification attempts
 * @property {number} total - Total number of notifications (successful + errors)
 * @property {number} maximum - Maximum notifications allowed per day
 * @property {number} remaining - Remaining notifications allowed today
 * @property {Date} resetsAt - When the rate limit resets
 */

/**
 * @typedef {Object} RateLimitStatus
 * @property {boolean} isRateLimited - Whether the token has exceeded the rate limit
 * @property {boolean} shouldSendRateLimitNotification - Whether to send a rate limit notification
 * @property {RateLimits} rateLimits - Current rate limit statistics
 */

const TWENTY_FOUR_HOURS_IN_MS = 86400000;

/**
 * Gets today's date in YYYYMMDD format for use in Redis keys.
 *
 * @private
 * @returns {string} Today's date as YYYYMMDD
 */
function getToday() {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  return yyyy + mm + dd;
}

exports.getToday = getToday;
exports.TWENTY_FOUR_HOURS_IN_MS = TWENTY_FOUR_HOURS_IN_MS;
