// The platform this build runs on: `vite build --mode extension` makes the extension's, any other
// mode the web's. The mode is replaced at build time, so each build carries only its own.

import { extensionPlatform } from './extension';
import { type Platform } from './platform';
import { webPlatform } from './web';

export const platform: Platform =
  import.meta.env.MODE === 'extension' ? extensionPlatform : webPlatform;
