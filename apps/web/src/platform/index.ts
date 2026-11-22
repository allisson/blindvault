// The platform this build runs on: `vite build --mode extension` makes the extension's, `--mode
// android` the Android app's, any other mode the web's. The mode is replaced at build time, so each
// build carries only its own.

import { androidPlatform } from './android';
import { extensionPlatform } from './extension';
import { type Platform } from './platform';
import { webPlatform } from './web';

export const platform: Platform =
  import.meta.env.MODE === 'extension'
    ? extensionPlatform
    : import.meta.env.MODE === 'android'
      ? androidPlatform
      : webPlatform;
