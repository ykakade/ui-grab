// One version number, read from the package rather than restated. The three
// places that used to carry their own drifted apart within a release.
import { createRequire } from 'node:module';

export const VERSION = createRequire(import.meta.url)('../package.json').version;
