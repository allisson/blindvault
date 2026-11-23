import { describe, expect, it } from 'vitest';

import { deviceName } from './device-name';

describe('default device name', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
      'Firefox on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    ['curl/8.0', 'Browser'],
  ])('%s', (ua, name) => {
    expect(deviceName(ua)).toBe(name);
    expect(deviceName(ua, 'web')).toBe(name);
    expect(deviceName(ua, 'extension')).toBe(name);
  });

  it('names the Android app, not the WebView inside it (D298)', () => {
    const webView =
      'Mozilla/5.0 (Linux; Android 15; SM-A546B Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36';
    expect(deviceName(webView, 'android')).toBe('BlindVault app on Android');
    expect(deviceName('curl/8.0', 'android')).toBe('BlindVault app on Android');
  });
});
