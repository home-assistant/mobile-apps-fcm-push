'use strict';

const { getToday, TWENTY_FOUR_HOURS_IN_MS } = require('./util');

const Redis = require('ioredis');

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
 * Manages rate limiting for push notifications using Redis as the backend.
 * Uses Redis hashes for atomic and efficient updates.
 */
class RedisRateLimiter {
  /**
   * Creates a new RedisRateLimiter instance.
   *
   * @param {number} [maxNotificationsPerDay] - Maximum notifications allowed per day
   * @param {boolean} [debug=false] - Whether to enable debug logging
   * @param {string} [redisHost] - Redis host
   * @param {number} [redisPort] - Redis port
   */
  constructor(maxNotificationsPerDay, debug = false, redisHost = 'localhost', redisPort = 6379) {
    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });
    this.maxNotificationsPerDay = maxNotificationsPerDay;
    this.debug = debug;
  }

  /**
   * Gets the Redis key for the rate limit data.
   *
   * @private
   * @param {string} token - The push notification token
   * @returns {string} The Redis key
   */
  _getRedisKey(token) {
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
   * @throws {Error} If Redis operations fail
   */
  async checkRateLimit(token) {
    const key = this._getRedisKey(token);
    const data = await this.redis.hgetall(key);

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
   * @throws {Error} If Redis operations fail
   */
  async recordAttempt(token) {
    const key = this._getRedisKey(token);

    // Use Redis transaction for atomic operations
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, 'attemptsCount', 1);
    pipeline.expire(key, this._getTTLSeconds());
    pipeline.hgetall(key);

    const results = await pipeline.exec();
    const [, , [, data]] = results;

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
   * @throws {Error} If Redis operations fail
   */
  async recordSuccess(token) {
    const key = this._getRedisKey(token);

    // Use Redis transaction for atomic operations
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, 'deliveredCount', 1);
    pipeline.hincrby(key, 'totalCount', 1);
    pipeline.expire(key, this._getTTLSeconds());
    pipeline.hgetall(key);

    const results = await pipeline.exec();
    const [, , , [, data]] = results;

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
   * @throws {Error} If Redis operations fail
   */
  async recordError(token) {
    const key = this._getRedisKey(token);

    // Use Redis transaction for atomic operations
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, 'errorCount', 1);
    pipeline.hincrby(key, 'totalCount', 1);
    pipeline.expire(key, this._getTTLSeconds());
    pipeline.hgetall(key);

    const results = await pipeline.exec();
    const [, , , [, data]] = results;

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
   * Closes the Redis connection.
   */
  async close() {
    await this.redis.quit();
  }
}

module.exports = RedisRateLimiter;
