import { build } from 'esbuild';
import { chmod, copyFile, readFile } from 'node:fs/promises';

for (const file of ['NotoSans-Regular.ttf', 'OFL.txt', 'README.md']) {
  await copyFile(`src/fonts/${file}`, `dist/fonts/${file}`);
}
const font = await readFile('src/fonts/NotoSans-Regular.ttf');
const plugins = [{
  name: 'embed-print-runtime',
  setup(builder) {
    builder.onLoad({ filter: /[/\\]fonts[/\\]font\.ts$/ }, () => ({
      contents: `export const fontBytes = Buffer.from(${JSON.stringify(font.toString('base64'))}, 'base64');`, loader: 'js',
    }));
    builder.onLoad({ filter: /[/\\]markup-worker-location\.ts$/ }, () => ({
      contents: "import {join} from 'node:path'; export const packagedMarkupWorker = join(__dirname, 'markup-worker.cjs');", loader: 'js',
    }));
  },
}];

// Bundle both subprocesses so they survive npx cache cleanup.
for (const entry of ['markup-worker', 'daemon']) {
  await build({
    entryPoints: [`src/${entry}.ts`], outfile: `dist/${entry}.cjs`,
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', plugins,
  });
}
await chmod('dist/cli.js', 0o755);
