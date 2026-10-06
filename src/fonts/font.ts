import { readFileSync } from 'node:fs';

// The daemon build embeds these bytes so printing survives npx cache cleanup.
export const fontBytes = readFileSync(new URL('./NotoSans-Regular.ttf', import.meta.url));
