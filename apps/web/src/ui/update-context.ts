// The update monitor and the controller, for the update banner every screen shows (D191).

import { createContext, useContext } from 'react';

import { type VaultController } from '../app/controller';
import { type UpdateMonitor } from '../app/updates';

export interface Updates {
  readonly monitor: UpdateMonitor;
  readonly controller: VaultController;
}

export const UpdatesContext = createContext<Updates | undefined>(undefined);

export function useUpdates(): Updates | undefined {
  return useContext(UpdatesContext);
}
