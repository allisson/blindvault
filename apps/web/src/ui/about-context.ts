// Whether the About card is open before unlock (D192). Held above the screens, since each status
// renders a card of its own and a status change would otherwise close it.

import { createContext, useContext, useState } from 'react';

export type AboutState = readonly [boolean, (open: boolean) => void];

export const AboutContext = createContext<AboutState | undefined>(undefined);

export function useAbout(): AboutState {
  const local = useState(false);
  return useContext(AboutContext) ?? local;
}
