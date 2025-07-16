'use strict';

const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const TWENTY_FOUR_HOURS_IN_MS = 86400000;

const db = getFirestore();

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
 * Manages rate limiting for push notifications without caching documents.
 * All operations require the token to be passed and directly query/update Firestore.
 */
class RateLimiter {
  /**
   * Creates a new RateLimiter instance.
   *
   * @param {number} [maxNotificationsPerDay] - Maximum notifications allowed per day
   * @param {boolean} [debug=false] - Whether to enable debug logging
   */
  constructor(maxNotificationsPerDay, debug = false) {
    this.db = db;
    this.maxNotificationsPerDay = maxNotificationsPerDay;
    this.debug = debug;
  }

  /**
   * Gets a reference to the rate limit document for the given token.
   *
   * @private
   * @param {string} token - The push notification token
   * @returns {FirebaseFirestore.DocumentReference} The document reference
   */
  _getDocRef(token) {
    const today = getToday();
    return this.db.collection('rateLimits').doc(today).collection('tokens').doc(token);
  }

  /**
   * Checks the current rate limit status for the token without modifying any counters.
   *
   * @param {string} token - The push notification token
   * @returns {Promise<RateLimitStatus>} The current rate limit status
   * @throws {Error} If Firestore operations fail
   */
  async checkRateLimit(token) {
    const docRef = this._getDocRef(token);
    const doc = await docRef.get();
    
    const docData = doc.exists ? doc.data() : {
      attemptsCount: 0,
      deliveredCount: 0,
      errorCount: 0,
      totalCount: 0,
      expiresAt: getFirestoreTimestamp(),
    };

    const isRateLimited = docData.deliveredCount >= this.maxNotificationsPerDay;
    const shouldSendRateLimitNotification =
      docData.deliveredCount === this.maxNotificationsPerDay;

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
   * @throws {Error} If Firestore operations fail
   */
  async recordAttempt(token) {
    const docRef = this._getDocRef(token);
    
    // Use transaction to atomically read and update
    const result = await this.db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      
      let docData;
      if (doc.exists) {
        docData = doc.data();
        docData.attemptsCount = docData.attemptsCount + 1;
        transaction.update(docRef, { attemptsCount: docData.attemptsCount });
      } else {
        docData = {
          attemptsCount: 1,
          deliveredCount: 0,
          errorCount: 0,
          totalCount: 0,
          expiresAt: getFirestoreTimestamp(),
        };
        transaction.set(docRef, docData);
      }
      
      return docData;
    });

    const isRateLimited = result.deliveredCount >= this.maxNotificationsPerDay;
    const shouldSendRateLimitNotification =
      result.deliveredCount === this.maxNotificationsPerDay;

    return {
      isRateLimited,
      shouldSendRateLimitNotification,
      rateLimits: this._getRateLimitsObject(result),
    };
  }

  /**
   * Records a successful notification delivery.
   * Atomically increments both delivered and total counters.
   * Note: Should be called after recordAttempt() to avoid double-counting attempts.
   *
   * @param {string} token - The push notification token
   * @returns {Promise<RateLimits>} The updated rate limit statistics
   * @throws {Error} If Firestore operations fail
   */
  async recordSuccess(token) {
    const docRef = this._getDocRef(token);
    
    // Use transaction to atomically read and update
    const result = await this.db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      
      let docData;
      if (doc.exists) {
        docData = doc.data();
        docData.deliveredCount = docData.deliveredCount + 1;
        docData.totalCount = docData.totalCount + 1;
        transaction.update(docRef, {
          deliveredCount: docData.deliveredCount,
          totalCount: docData.totalCount
        });
      } else {
        // Should not happen if recordAttempt was called first, but handle gracefully
        docData = {
          attemptsCount: 0,
          deliveredCount: 1,
          errorCount: 0,
          totalCount: 1,
          expiresAt: getFirestoreTimestamp(),
        };
        transaction.set(docRef, docData);
      }
      
      return docData;
    });

    return this._getRateLimitsObject(result);
  }

  /**
   * Records a failed notification delivery.
   * Atomically increments both error and total counters.
   * Note: Should be called after recordAttempt() to avoid double-counting attempts.
   *
   * @param {string} token - The push notification token
   * @returns {Promise<RateLimits>} The updated rate limit statistics
   * @throws {Error} If Firestore operations fail
   */
  async recordError(token) {
    const docRef = this._getDocRef(token);
    
    // Use transaction to atomically read and update
    const result = await this.db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      
      let docData;
      if (doc.exists) {
        docData = doc.data();
        docData.errorCount = docData.errorCount + 1;
        docData.totalCount = docData.totalCount + 1;
        transaction.update(docRef, {
          errorCount: docData.errorCount,
          totalCount: docData.totalCount
        });
      } else {
        // Should not happen if recordAttempt was called first, but handle gracefully
        docData = {
          attemptsCount: 0,
          deliveredCount: 0,
          errorCount: 1,
          totalCount: 1,
          expiresAt: getFirestoreTimestamp(),
        };
        transaction.set(docRef, docData);
      }
      
      return docData;
    });

    return this._getRateLimitsObject(result);
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
