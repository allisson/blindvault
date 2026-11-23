import { describe, expect, it } from 'vitest';

import { warnsBrowserSave } from './NewPassword';

describe('the warning not to let the browser save the local password (D175, D297)', () => {
  it('shows on the web and in the extension, whose browser may save it', () => {
    expect(warnsBrowserSave('web')).toBe(true);
    expect(warnsBrowserSave('extension')).toBe(true);
  });

  it('is left out of the Android app, whose WebView no autofill service sees', () => {
    expect(warnsBrowserSave('android')).toBe(false);
  });
});
