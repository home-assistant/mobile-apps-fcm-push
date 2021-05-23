const fs = require('fs');
var assert = require('assert');

describe('legacy.js', function () {
    const legacy = require('../legacy.js');
    
    describe('input/output tests', function () {
        const dir = './test/fixtures/legacy/';
        fs.readdirSync(dir).forEach(file => {
            if (!file.endsWith(".json")) {
                return;
            }

            describe(`${file}`, function() {
                var input;
                var expectedApns;
                var expectedRateLimit;
                
                before(function (done) {
                    fs.readFile(dir + file, 'utf8', (err, data) => {
                        if (err) {
                            done(err);
                            return;
                        }
                        
                        const json = JSON.parse(data)
                        input = json["input"]
                        expected = {
                            "payload": {
                                "apns": {
                                    "headers": json["headers"],
                                    "payload": json["payload"]
                                }
                            },
                            "updateRateLimits": json["rate_limit"]
                        }
                        done();
                    })
                })
                
                it('should match the expected', function() {
                    let result = legacy.createPayload({"body": input});
                    // removing things that aren't worth copy/pasting between test cases
                    delete result["payload"]["android"];
                    delete result["payload"]["notification"];
                    delete result["payload"]["fcm_options"];
                    assert.deepStrictEqual(result, expected);
                });
            });
        });
    });
});
