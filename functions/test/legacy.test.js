'use strict';

const fs = require('fs');
const legacy = require('../legacy.js');
const assert = require('assert');

describe('legacy.js', () => {
  const fixturesDir = './test/fixtures/legacy/';

  // Get fixture files synchronously for test definition
  const files = fs.readdirSync(fixturesDir);
  const jsonFiles = files.filter((file) => file.endsWith('.json'));

  // Create a test for each fixture file
  jsonFiles.forEach((file) => {
    it(`should handle ${file}`, (done) => {
      fs.readFile(fixturesDir + file, 'utf8', (err, data) => {
        if (err) {
          done(err);
          return;
        }

        const json = JSON.parse(data);
        const input = json['input'];
        const expected = {
          payload: {
            apns: {
              headers: json['headers'],
              payload: json['payload'],
            },
          },
          updateRateLimits: json['rate_limit'],
        };

        const result = legacy.createPayload({ body: input });

        // Remove things that aren't worth copy/pasting between test cases
        delete result['payload']['android'];
        delete result['payload']['notification'];
        delete result['payload']['fcm_options'];

        assert.deepStrictEqual(result, expected);
        done();
      });
    });
  });

  // Ensure we have fixture files to test
  it('should have fixture files to test', () => {
    expect(jsonFiles.length).toBeGreaterThan(0);
  });
});
