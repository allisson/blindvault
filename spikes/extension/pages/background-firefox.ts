// Firefox's MV3 event page: the session host (measure 1) and the interception background
// (measures 3 and 4) in one document, since Firefox has no offscreen document to measure.

import { onMessage } from '../scripts/webauthn';
import { startHost } from './host';

declare const chrome: any;

startHost('background');
chrome.runtime.onMessage.addListener(onMessage);
