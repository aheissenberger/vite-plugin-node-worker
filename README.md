# vite-node-worker-dev

A plugin to serve and build ViteJS projects with [Node Worker Threads](https://nodejs.org/api/worker_threads.html). Supports DEV and BUILD mode and TypeScript.

## Install & Configuration

### Install dependencies

```bash
npm install vite-node-worker-dev
```

### Setup ViteJS

```ts
// ./vite.config.ts
import { defineConfig } from "vite";
import workerPlugin from "vite-node-worker-dev";
export default defineConfig({
  plugins: [workerPlugin()],
  worker: {
    plugins: () => [workerPlugin()],
  },
});
```

**Note:** `worker: {}` applys the transformation in ViteJS Dev Mode.

### Import Worker

The path to the worker file needs to be suffixed with `?nodeWorker` or `?modulePath`.

**Wrapper Mode**

```ts
import ApiWorker from "./api-worker.ts?nodeWorker";
const apiW = ApiWorker({ workerData: { hello: "world" } });
api.postMessage("MSG")
```

transforms `import ApiWorker from "./api-worker.ts?nodeWorker";` to:

```js
import { Worker } from 'node:worker_threads';
export default function (options) { return new Worker(new URL(${assetRefId}, import.meta.url), options) }
```


**Path Export**

```ts
import ApiWorkerPath from "./api-worker.ts?modulePath";
import { Worker } from "node:worker_threads"
const apiW = new Worker(workerPath, { workerData: { hello: "world" } });
api.postMessage("MSG")
```

transforms `import ApiWorkerPath from "./api-worker.ts?modulePath";` to:

```js
export default ${assetRefId}
```

## Related Projects

This plugin is based on code from:

- https://www.npmjs.com/package/@fetsorn/vite-node-worker
- https://github.com/alex8088/electron-vite/blob/master/src/plugins/worker.ts

## License

[MIT](LICENSE)
