const fs = require('fs');
const legacy = require('../legacy.js');
var assert = require('assert');

describe('legacy.js', () => {
  const fixturesDir = './test/fixtures/legacy/';
  fs.readdirSync(fixturesDir).forEach((file) => {
    if (!file.endsWith('.json')) {
      return;
    }

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

        let result = legacy.createPayload({ body: input });
        // removing things that aren't worth copy/pasting between test cases
        delete result['payload']['android'];
        delete result['payload']['notification'];
        delete result['payload']['fcm_options'];
        assert.deepStrictEqual(result, expected);

        done();
      });
    });
  });
});
