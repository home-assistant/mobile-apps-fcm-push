'use strict';

const { getToday, TWENTY_FOUR_HOURS_IN_MS } = require('./util');

const { GlideClusterClient, ClusterBatch } = require('@valkey/valkey-glide');

/**
 * @typedef {import('./util').RateLimits} RateLimits
 * @typedef {import('./util').RateLimitStatus} RateLimitStatus
 */

/**
 * @typedef {Object} RateLimitData
 * @property {number} attemptsCount - Number of attempts
 * @property {number} deliveredCount - Number of delivered notifications
 * @property {number} errorCount - Number of errors
 * @property {number} totalCount - Total notifications sent
 */

/**
 * Manages rate limiting for push notifications using Valkey as the backend.
 * Uses Valkey hashes for atomic and efficient updates.
 */
class ValkeyRateLimiter {
  /**
   * Creates a new ValkeyRateLimiter instance.
   *
   * @param {number} [maxNotificationsPerDay] - Maximum notifications allowed per day
   * @param {boolean} [debug=false] - Whether to enable debug logging
   * @param {string} [valkeyHost] - Valkey Cluster host
   * @param {number} [valkeyPort] - Valkey Cluster port
   */
  constructor(maxNotificationsPerDay, debug = false, valkeyHost = 'localhost', valkeyPort = 6379) {
    this.valkeyHost = valkeyHost;
    this.valkeyPort = valkeyPort;
    this.maxNotificationsPerDay = maxNotificationsPerDay;
    this.debug = debug;
    this.connected = false;
    this.client = null;
  }

  async connect() {
    if (this.connected) {
      return; // Already connected
    }
    this.client = await GlideClusterClient.createClient({
      addresses: [{ host: this.valkeyHost, port: this.valkeyPort }],
      requestTimeout: 500,
      clientName: 'RateLimiterClient',
    });
    this.connected = true;
  }

  /**
   * Gets the Valkey key for the rate limit data.
   *
   * @private
   * @param {string} token - The push notification token
   * @returns {string} The Valkey key
   */
  _getValkeyKey(token) {
    const today = getToday();
    return `rate_limit:${token}:${today}`;
  }

  /**
   * Gets the TTL in seconds until end of day.
   *
   * @private
   * @returns {number} TTL in seconds
   */
  _getTTLSeconds() {
    const now = new Date().getTime();
    const endOfDay = now - (now % TWENTY_FOUR_HOURS_IN_MS) + TWENTY_FOUR_HOURS_IN_MS;
    const ttlMs = endOfDay - now;
    return Math.ceil(ttlMs / 1000);
  }

  /**
   * Checks the current rate limit status for the token without modifying any counters.
   *
   * @param {string} token - The push notification token
   * @returns {Promise<RateLimitStatus>} The current rate limit status
   * @throws {Error} If Valkey operations fail
   */
  async checkRateLimit(token) {
    await this.connect();
    const key = this._getValkeyKey(token);
    const data = await this.client.hgetall(key);

    const docData = {
      attemptsCount: parseInt(data.attemptsCount || '0', 10),
      deliveredCount: parseInt(data.deliveredCount || '0', 10),
      errorCount: parseInt(data.errorCount || '0', 10),
      totalCount: parseInt(data.totalCount || '0', 10),
    };

    const isRateLimited = docData.deliveredCount >= this.maxNotificationsPerDay;
    const shouldSendRateLimitNotification = docData.deliveredCount === this.maxNotificationsPerDay;

    return {
      isRateLimited,
      shouldSendRateLimitNotification,
      rateLimits: this._getRateLimitsObject(docData),
    };
  }

  /**
   * Records a notification attempt and atomically increments the attempts counter.
   *
   * @param {string} token - The push notification token
   * @returns {Promise<RateLimitStatus>} The updated rate limit status
   * @throws {Error} If Valkey operations fail
   */
  async recordAttempt(token) {
    await this.connect();
    const key = this._getValkeyKey(token);

    // Use Valkey batch with non-atomic operations as we don't need strict atomicity here
    const batch = new ClusterBatch(false);
    batch.hincrby(key, 'attemptsCount', 1);
    batch.expire(key, this._getTTLSeconds());
    batch.hgetall(key);

    const results = await this.client.exec(batch, true);
    const [, , data] = results;

    const docData = {
      attemptsCount: parseInt(data.attemptsCount || '0', 10),
      deliveredCount: parseInt(data.deliveredCount || '0', 10),
      errorCount: parseInt(data.errorCount || '0', 10),
      totalCount: parseInt(data.totalCount || '0', 10),
    };

    const isRateLimited = docData.deliveredCount >= this.maxNotificationsPerDay;
    const shouldSendRateLimitNotification = docData.deliveredCount === this.maxNotificationsPerDay;

    return {
      isRateLimited,
      shouldSendRateLimitNotification,
      rateLimits: this._getRateLimitsObject(docData),
    };
  }

  /**
   * Records a successful notification delivery.
   * Atomically increments both delivered and total counters.
   * Note: Should be called after recordAttempt() to avoid double-counting attempts.
   *
   * @param {string} token - The push notification token
   * @returns {Promise<RateLimits>} The updated rate limit statistics
   * @throws {Error} If Valkey operations fail
   */
  async recordSuccess(token) {
    await this.connect();
    const key = this._getValkeyKey(token);

    // Use Valkey batch with non-atomic operations as we don't need strict atomicity here
    const batch = new ClusterBatch(false);
    batch.hincrby(key, 'deliveredCount', 1);
    batch.hincrby(key, 'totalCount', 1);
    batch.expire(key, this._getTTLSeconds());
    batch.hgetall(key);

    const results = await this.client.exec(batch, true);
    const [, , , data] = results;

    const docData = {
      attemptsCount: parseInt(data.attemptsCount || '0', 10),
      deliveredCount: parseInt(data.deliveredCount || '0', 10),
      errorCount: parseInt(data.errorCount || '0', 10),
      totalCount: parseInt(data.totalCount || '0', 10),
    };

    return this._getRateLimitsObject(docData);
  }

  /**
   * Records a failed notification delivery.
   * Atomically increments both error and total counters.
   * Note: Should be called after recordAttempt() to avoid double-counting attempts.
   *
   * @param {string} token - The push notification token
   * @returns {Promise<RateLimits>} The updated rate limit statistics
   * @throws {Error} If Valkey operations fail
   */
  async recordError(token) {
    await this.connect();
    const key = this._getValkeyKey(token);

    // Use Valkey batch with non-atomic operations as we don't need strict atomicity here
    const batch = new ClusterBatch(false);
    batch.hincrby(key, 'errorCount', 1);
    batch.hincrby(key, 'totalCount', 1);
    batch.expire(key, this._getTTLSeconds());
    batch.hgetall(key);

    const results = await this.client.exec(batch, true);
    const [, , , data] = results;

    const docData = {
      attemptsCount: parseInt(data.attemptsCount || '0', 10),
      deliveredCount: parseInt(data.deliveredCount || '0', 10),
      errorCount: parseInt(data.errorCount || '0', 10),
      totalCount: parseInt(data.totalCount || '0', 10),
    };

    return this._getRateLimitsObject(docData);
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

  /**
   * Closes the Valkey connection.
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.connected = false;
      this.client = null;
    }
  }
}

module.exports = ValkeyRateLimiter;
