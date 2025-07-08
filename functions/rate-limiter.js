'use strict';

const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const functions = require('firebase-functions');

const TWENTY_FOUR_HOURS_IN_MS = 86400000;

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

/**
 * @typedef {Object} RateLimitData
 * @property {number} attemptsCount - Number of attempts
 * @property {number} deliveredCount - Number of delivered notifications
 * @property {number} errorCount - Number of errors
 * @property {number} totalCount - Total notifications sent
 * @property {FirebaseFirestore.Timestamp} expiresAt - When this record expires
 */

/**
 * Manages rate limiting for push notifications on a per-token basis.
 * Each instance is specific to a single push token and maintains its own state.
 */
class RateLimiter {
  /**
   * Creates a new RateLimiter instance for a specific push token.
   *
   * @param {string} token - The push notification token to rate limit
   * @param {number} [maxNotificationsPerDay] - Maximum notifications allowed per day
   * @param {boolean} [debug=false] - Whether to enable debug logging
   */
  constructor(token, maxNotificationsPerDay, debug = false) {
    this.token = token;
    this.db = getFirestore();
    this.maxNotificationsPerDay = maxNotificationsPerDay;
    this.debug = debug;

    // Internal state - will be loaded on first access
    this._loaded = false;
    this._ref = null;
    this._docExists = false;
    this._docData = null;
  }

  /**
   * Ensures the rate limit data is loaded from Firestore.
   * This is called automatically by public methods.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _ensureLoaded() {
    if (this._loaded) return;

    const today = getToday();
    this._ref = this.db.collection('rateLimits').doc(today).collection('tokens').doc(this.token);

    this._docData = {
      attemptsCount: 0,
      deliveredCount: 0,
      errorCount: 0,
      totalCount: 0,
      expiresAt: getFirestoreTimestamp(),
    };

    const currentDoc = await this._ref.get();
    this._docExists = currentDoc.exists;
    if (currentDoc.exists) {
      this._docData = currentDoc.data();
    }

    this._loaded = true;
  }

  /**
   * Checks the current rate limit status for the token without modifying any counters.
   *
   * @returns {Promise<RateLimitStatus>} The current rate limit status
   * @throws {Error} If Firestore operations fail
   */
  async checkRateLimit() {
    await this._ensureLoaded();

    const isRateLimited = this._docData.deliveredCount >= this.maxNotificationsPerDay;
    const shouldSendRateLimitNotification =
      this._docData.deliveredCount === this.maxNotificationsPerDay;

    return {
      isRateLimited,
      shouldSendRateLimitNotification,
      rateLimits: this._getRateLimitsObject(this._docData),
    };
  }

  /**
   * Records a notification attempt and increments the attempts counter.
   * Only updates Firestore if the rate limit has been exceeded.
   *
   * @returns {Promise<RateLimitStatus>} The updated rate limit status
   * @throws {Error} If Firestore operations fail
   */
  async recordAttempt() {
    await this._ensureLoaded();

    this._docData.attemptsCount = this._docData.attemptsCount + 1;

    const isRateLimited = this._docData.deliveredCount > this.maxNotificationsPerDay;
    const shouldSendRateLimitNotification =
      this._docData.deliveredCount === this.maxNotificationsPerDay;

    if (this._docData.deliveredCount >= this.maxNotificationsPerDay && isRateLimited) {
      await this._updateDoc();
    }

    return {
      isRateLimited,
      shouldSendRateLimitNotification,
      rateLimits: this._getRateLimitsObject(this._docData),
    };
  }

  /**
   * Records a successful notification delivery.
   * Increments both delivered and total counters.
   * Note: Should be called after recordAttempt() to avoid double-counting attempts.
   *
   * @returns {Promise<RateLimits>} The updated rate limit statistics
   * @throws {Error} If Firestore operations fail
   */
  async recordSuccess() {
    await this._ensureLoaded();

    // attemptsCount was already incremented in recordAttempt
    this._docData.deliveredCount = this._docData.deliveredCount + 1;
    this._docData.totalCount = this._docData.totalCount + 1;

    await this._updateDoc();

    return this._getRateLimitsObject(this._docData);
  }

  /**
   * Records a failed notification delivery.
   * Increments both error and total counters.
   * Note: Should be called after recordAttempt() to avoid double-counting attempts.
   *
   * @returns {Promise<RateLimits>} The updated rate limit statistics
   * @throws {Error} If Firestore operations fail
   */
  async recordError() {
    await this._ensureLoaded();

    // attemptsCount was already incremented in recordAttempt
    this._docData.errorCount = this._docData.errorCount + 1;
    this._docData.totalCount = this._docData.totalCount + 1;

    await this._updateDoc();

    return this._getRateLimitsObject(this._docData);
  }

  /**
   * Updates or creates the rate limit document in Firestore.
   *
   * @private
   * @returns {Promise<void>}
   * @throws {Error} If Firestore operations fail
   */
  async _updateDoc() {
    if (this._docExists) {
      if (this.debug) functions.logger.info('Updating existing rate limit doc!');
      await this._ref.update(this._docData);
    } else {
      if (this.debug) functions.logger.info('Creating new rate limit doc!');
      await this._ref.set(this._docData);
    }
  }

  /**
   * Converts internal rate limit data to a user-friendly format.
   *
   * @private
   * @param {RateLimitData} doc - The internal rate limit data
   * @returns {RateLimits} User-friendly rate limit statistics
   */
  _getRateLimitsObject(doc) {
    const d = new Date();
    let remainingCount = this.maxNotificationsPerDay - doc.deliveredCount;
    if (remainingCount < 0) remainingCount = 0;

    return {
      attempts: doc.attemptsCount || 0,
      successful: doc.deliveredCount || 0,
      errors: doc.errorCount || 0,
      total: doc.totalCount || 0,
      maximum: this.maxNotificationsPerDay,
      remaining: remainingCount,
      resetsAt: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
    };
  }
}

/**
 * Gets today's date in YYYYMMDD format for use as a Firestore document ID.
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


/**
 * Creates a Firestore timestamp for the end of the current day (midnight).
 * Used to set document expiration times.
 *
 * @private
 * @returns {FirebaseFirestore.Timestamp} Timestamp for end of current day
 */
function getFirestoreTimestamp() {
  const now = new Date().getTime();
  const endDate = new Date(now - (now % TWENTY_FOUR_HOURS_IN_MS) + TWENTY_FOUR_HOURS_IN_MS);
  return Timestamp.fromDate(endDate);
}

module.exports = RateLimiter;
