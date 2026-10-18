'use strict';

const android = require('../android.js');

describe('android.js createPayload', () => {
  function makeReq(data) {
    return {
      body: {
        data,
        registration_info: {},
      },
    };
  }

  describe('whitelisted data values', () => {
    test('primitive values are stringified', () => {
      const { payload } = android.createPayload(makeReq({ tag: 'foo', importance: 4 }));
      expect(payload.data.tag).toBe('foo');
      expect(payload.data.importance).toBe('4');
    });

    test('array values are JSON-stringified, not coerced via String()', () => {
      // Repro: HA's template engine auto-parses a JSON array string back into a
      // native list before posting. Without JSON.stringify, the proxy ships
      // "1,2,3" (Array.prototype.toString), and the receiving app's JSON.parse
      // throws SyntaxError. Object array would arrive as "[object Object]".
      const samples = [
        { time: '2026-01-01T08:00:00Z', value: 60 },
        { time: '2026-01-01T08:00:30Z', value: 64 },
      ];
      const { payload } = android.createPayload(makeReq({ vibrationPattern: samples }));
      expect(payload.data.vibrationPattern).toBe(JSON.stringify(samples));
      expect(JSON.parse(payload.data.vibrationPattern)).toEqual(samples);
    });

    test('object values are JSON-stringified', () => {
      const obj = { a: 1, b: 'two' };
      const { payload } = android.createPayload(makeReq({ intent_extras: obj }));
      expect(payload.data.intent_extras).toBe(JSON.stringify(obj));
    });

    test('null values fall through to String() and become "null"', () => {
      // Documents existing behavior — JSON.stringify(null) is also 'null', but
      // explicitly guarding `typeof v === 'object' && v !== null` keeps null
      // out of the JSON branch so this stays consistent with prior versions.
      const { payload } = android.createPayload(makeReq({ tag: null }));
      expect(payload.data.tag).toBe('null');
    });
  });
});
