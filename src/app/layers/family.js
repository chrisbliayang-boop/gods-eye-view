import { createFamilyLayer } from '../../layers/family/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
/** Wire the family tracker to the application overlay host. */
export function createApplicationFamily(options) {
  return createFamilyLayer({ overlayHost, picking, ...options });
}
