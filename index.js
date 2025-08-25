import path from "node:path";
import { URL, URLSearchParams } from "node:url";
import fs from "node:fs";

import MagicString from "magic-string";

function toRelativePath(filename, importer) {
  const relPath = path.posix.relative(path.dirname(importer), filename);
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
}

function parseRequest(id) {
  const { search } = new URL(id, "file:");
  if (!search) return null;
  return Object.fromEntries(new URLSearchParams(search));
}

const queryRE = /\?.*$/s;
const hashRE = /#.*$/s;
const cleanUrl = (url) => url.replace(hashRE, "").replace(queryRE, "");

const nodeWorkerAssetUrlRE = /__VITE_NODE_WORKER_ASSET__([\w$]+)__/g;

/**
 * Resolve `?nodeWorker` and `?modulePath` imports for Node worker_threads.
 * - DEV (serve): generate wrappers that use file URLs (no emitFile).
 * - BUILD: emit chunks and replace placeholders to relative paths.
 */
export default function workerPlugin() {
  let sourcemap = false;
  let isServe = false;

  return {
    name: "vite:node-worker-dev",
    enforce: "pre",

    configResolved(config) {
      sourcemap = !!config.build.sourcemap;
      isServe = config.command === "serve";
    },

    resolveId(id, importer) {
      const query = parseRequest(id);
      if (!query) return;
      if (query.nodeWorker != null || query.modulePath != null) {
        return id + `&importer=${importer}`;
      }
    },

    async load(id) {
      const query = parseRequest(id);
      if (!query || !query.importer) return;

      const cleanPath = cleanUrl(id);

      const importerFile = (query.importer || "").replace(/\?.*$/, "");
      const tryPaths = [];

      // 1) Use Vite resolver first
      const resolved = await this.resolve(cleanPath, importerFile);
      if (resolved?.id) tryPaths.push(resolved.id.replace(/\?.*$/, ""));

      // 2) If id is relative, resolve against importer dir
      if (!cleanPath.startsWith("/")) {
        tryPaths.push(path.resolve(path.dirname(importerFile), cleanPath));
      } else {
        // 3) If id starts with '/' but isn't a real file (e.g. "/api-worker.ts"), try project root
        tryPaths.push(path.resolve(process.cwd(), cleanPath.slice(1)));
      }

      // 4) Always try cwd + id as-is
      tryPaths.push(path.resolve(process.cwd(), cleanPath));

      // Pick the first existing file
      let absId = tryPaths.find((p) => {
        try { return fs.existsSync(p); } catch { return false; }
      });
      if (!absId) absId = (resolved?.id || cleanPath).replace(/\?.*$/, "");

      // ---------------- DEV (serve) ----------------
      if (isServe) {
        // ?modulePath → export file URL for new Worker(url, opts)
        if (query.modulePath != null) {
          return `export default new URL(${JSON.stringify(absId)}, 'file:')`;
        }
        // ?nodeWorker → export a wrapper that constructs Worker
        if (query.nodeWorker != null) {
          return `
            import { Worker } from 'node:worker_threads';
            const url = new URL(${JSON.stringify(absId)}, 'file:');
            export default function (options) { return new Worker(url, options) }
          `;
        }
        return;
      }

      // ---------------- BUILD ----------------
      if (query.nodeWorker != null || query.modulePath != null) {
        const hash = this.emitFile({
          type: "chunk",
          id: cleanPath,
          importer: query.importer,
        });
        const assetRefId = `__VITE_NODE_WORKER_ASSET__${hash}__`;

        if (query.modulePath != null) {
          // build: path export
          return `export default ${assetRefId}`;
        }
        // build: wrapper export
        return `
          import { Worker } from 'node:worker_threads';
          export default function (options) { return new Worker(new URL(${assetRefId}, import.meta.url), options) }
        `;
      }
    },

    renderChunk(code, chunk) {
      if (!nodeWorkerAssetUrlRE.test(code)) return null;

      let match;
      const s = new MagicString(code);
      nodeWorkerAssetUrlRE.lastIndex = 0;

      while ((match = nodeWorkerAssetUrlRE.exec(code))) {
        const [full, hash] = match;
        const filename = this.getFileName(hash);
        const outputFilepath = toRelativePath(filename, chunk.fileName);
        const replacement = JSON.stringify(outputFilepath);
        s.overwrite(match.index, match.index + full.length, replacement, {
          contentOnly: true,
        });
      }

      return {
        code: s.toString(),
        map: sourcemap ? s.generateMap({ hires: "boundary" }) : null,
      };
    },
  };
}
