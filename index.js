import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, URL, URLSearchParams } from "node:url";

import MagicString from "magic-string";
import { transformWithEsbuild } from "vite";

const DEBUG = process.env.VNW_DEBUG === "1";

function normalizeAliases(raw) {
  if (!raw) return [];
  // Vite accepts array or object
  if (Array.isArray(raw))
    return raw.map((e) => ({ find: e.find, replacement: e.replacement }));
  return Object.entries(raw).map(([find, replacement]) => ({
    find,
    replacement,
  }));
}

function applyAliases(spec, aliases) {
  let out = spec;
  for (const { find, replacement } of aliases) {
    if (!find) continue;
    if (find instanceof RegExp) {
      if (find.test(out)) out = out.replace(find, replacement);
    } else if (typeof find === "string") {
      if (out.startsWith(find)) out = replacement + out.slice(find.length);
    }
  }
  return out;
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function codeFrame(text, pos, span = 80) {
  const start = Math.max(0, pos - span);
  const end = Math.min(text.length, pos + span);
  const snippet = text.slice(start, end);
  const caret = " ".repeat(Math.max(0, pos - start)) + "^";
  return snippet + "\n" + caret;
}

function toRelativePath(filename, importer) {
  const relPath = path.posix.relative(path.dirname(importer), filename);
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
}

const queryRE = /\?.*$/s;
const hashRE = /#.*$/s;
const cleanUrl = (url) => url.replace(hashRE, "").replace(queryRE, "");

const PROBE_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function tryResolveFileLike(base) {
  const ext = path.extname(base);
  const baseNoExt = ext ? base.slice(0, -ext.length) : base;

  const candidates = new Set();

  if (ext) {
    // If caller provided an extension (even .js), try exact first
    candidates.add(base);
    // Then try TypeScript-preferred swaps
    candidates.add(baseNoExt + ".ts");
    candidates.add(baseNoExt + ".tsx");
    candidates.add(baseNoExt + ".mts");
    candidates.add(baseNoExt + ".cts");
    // Also allow JS module variants
    candidates.add(baseNoExt + ".mjs");
    candidates.add(baseNoExt + ".cjs");
    candidates.add(baseNoExt + ".js");
  } else {
    // No extension provided: probe common extensions
    for (const e of PROBE_EXTS) {
      candidates.add(baseNoExt + e);
    }
  }

  // If base refers to a directory, try index.* files
  const dir = base;
  for (const e of PROBE_EXTS.slice(1)) {
    // skip ""
    candidates.add(path.join(dir, `index${e}`));
  }

  for (const file of candidates) {
    if (fileExists(file)) return file;
  }
  return null;
}

const toFileURL = (p) => pathToFileURL(path.resolve(p)).href;

const nodeWorkerAssetUrlRE = /__VITE_NODE_WORKER_ASSET__([\w$]+)__/g;

const RE = {
  importFrom: /(import\s+[^'";]*?from\s*['"])([^'"\n]+)(['"])/g, // import x from '...'
  // Safer: avoid catastrophic backtracking on large lines by constraining tokens
  exportFrom: /(export\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\*|[\w$,\s]*)\s*from\s*['"])([^'"\n]+)(['"])/g, // export { x } from '...'
  dynImport: /(import\s*\(\s*['"])([^'"\n]+)(['"]\s*\))/g, // import('...')
  sideImport: /(import\s*['"])([^'"\n]+)(['"])/g, // import '...'
};

async function rewriteEntryAliasesToFile(src, entryFile, opts) {
  const projectRoot = (opts && opts.root) || process.cwd();
  const projectAliases = (opts && opts.aliases) || [];

  const DEV_CACHE_DIR = path.join(
    projectRoot,
    "node_modules/.vite-plugin-node-worker/dev"
  );

  // Cache to avoid rewriting same module multiple times per load()
  const cache = new Map(); // fsPath -> fileURL
  const active = new Set(); // fsPath currently being rewritten (cycle guard)

  function toURL(p) {
    return toFileURL(p);
  }
  const isExternalUrl = (s) => /^(?:https?:|data:|node:|deno:)/.test(s);
  function resolveToFs(spec, fromFile) {
    if (!spec || typeof spec !== 'string') return null;
    if (isExternalUrl(spec)) return null;
    // Bare package: keep as-is
    if (
      !spec.startsWith(".") &&
      !spec.startsWith("/") &&
      !spec.startsWith("file:") &&
      !/^[A-Za-z]:\\/.test(spec)
    ) {
      // try alias first; if alias maps to absolute/relative, continue, else keep as bare
      const aliased = applyAliases(spec, projectAliases);
      if (aliased === spec) return null; // no alias mapping -> bare package
      spec = aliased; // fall-through to resolve
    }

    if (spec.startsWith("file:")) {
      try {
        return new URL(spec).pathname;
      } catch {
        return null;
      }
    }

    // Apply aliases for non-bare paths as well (e.g., '~/x', custom prefixes)
    spec = applyAliases(spec, projectAliases);

    let base;
    if (path.isAbsolute(spec)) {
      // Treat leading '/' as relative to Vite root, not filesystem root
      if (spec.startsWith("/")) base = path.resolve(projectRoot, spec.slice(1));
      else base = spec; // e.g., Windows absolute path like C:\\
    } else if (spec.startsWith(".")) {
      base = path.resolve(path.dirname(fromFile), spec);
    } else {
      // any remaining custom prefix already rewritten by aliases; resolve from project root
      base = path.resolve(projectRoot, spec);
    }

    return tryResolveFileLike(base);
  }

  async function rewriteModule(fsPath) {
    const skip = /\.(json|css|scss|sass|less|svg|png|jpe?g|gif|webp)$/i.test(
      fsPath
    );
    if (skip) {
      const url = toURL(fsPath);
      cache.set(fsPath, url);
      return url;
    }
    if (active.has(fsPath)) {
      // Break cycles early by returning the original file URL without further rewriting
      return toURL(fsPath);
    }
    if (cache.has(fsPath)) return cache.get(fsPath);

    let code;
    try {
      code = fs.readFileSync(fsPath, "utf8");
    } catch (err) {
      if (DEBUG) {
        console.error(
          "[vite-plugin-node-worker][DEBUG] failed to read file for rewrite:",
          fsPath,
          "\n",
          err
        );
      }
      // Re-throw so the caller can decide how to proceed rather than silently skipping
      throw err;
    }

    // Optimistically cache original URL and mark as active to prevent recursive cycles
    const originalURL = toURL(fsPath);
    cache.set(fsPath, originalURL);
    active.add(fsPath);
    try {
      let out = code;
      let ms = new MagicString(out);

      // Helper to apply a list of regex rules of the form /(p1)(spec)(p3)/
      async function applyTripletRule(re, resolver) {
        re.lastIndex = 0;
        for (const m of out.matchAll(re)) {
          const full = m[0];
          const p1 = m[1];
          const spec = m[2];
          const p3 = m[3];
          if (!spec) continue;
          const start = /** spec start **/ (m.index + p1.length);
          const end = start + spec.length;
          const replacement = await resolver(spec);
          if (replacement && replacement !== spec) {
            ms.overwrite(start, end, replacement, { contentOnly: true });
          }
        }
        out = ms.toString();
      }

      // side-effect imports: (import '...')
      await applyTripletRule(RE.sideImport, async (spec) => {
        const childFs = resolveToFs(spec, fsPath);
        if (!childFs || childFs === fsPath) return spec;
        const childURL = await rewriteModule(childFs);
        return childURL;
      });

      // import ... from '...'
      await applyTripletRule(RE.importFrom, async (spec) => {
        const childFs = resolveToFs(spec, fsPath);
        if (!childFs || childFs === fsPath) return spec;
        const childURL = await rewriteModule(childFs);
        return childURL;
      });

      // export ... from '...'
      try {
        await applyTripletRule(RE.exportFrom, async (spec) => {
          const childFs = resolveToFs(spec, fsPath);
          if (!childFs || childFs === fsPath) return spec;
          const childURL = await rewriteModule(childFs);
          return childURL;
        });
      } catch (e) {
        if (DEBUG) {
          console.warn(
            "[vite-plugin-node-worker][DEBUG] skipping export-from rewrite due to complex line in",
            fsPath,
            "\n",
            e
          );
        }
      }

      // catch-all: string literals that start with '~/...' -> /(quote)(spec)(quote)/
      await applyTripletRule(/(['"])(~\/[\w@./-]+)(['"])/g, async (spec) => {
        const childFs = resolveToFs(spec, fsPath);
        if (!childFs) return spec;
        const childURL = toURL(childFs);
        return childURL;
      });

      // DEBUG: warn if any alias tokens remain
      if (DEBUG && /(^|[^A-Za-z0-9_])~\//.test(out)) {
        console.warn(
          "[vite-plugin-node-worker][DEBUG] alias tokens remain after rewrite in",
          fsPath
        );
        let idx = 0;
        while ((idx = out.indexOf("~/", idx)) !== -1) {
          const frame = codeFrame(out, idx);
          console.warn(frame);
          idx += 2;
        }
      }

      // Transpile TS/TSX to ESM JS using Vite's helper
      const esb = await transformWithEsbuild(out, fsPath, {
        loader: /\.tsx?$/.test(fsPath) ? 'ts' : 'js',
        format: 'esm',
        sourcemap: false,
        target: 'esnext',
      });
      out = esb.code;

      // Emit rewritten (or original if unchanged) to dev cache and return file URL
      fs.mkdirSync(DEV_CACHE_DIR, { recursive: true });
      const hash = sha1(fsPath + "|" + out).slice(0, 12);
      const outFile = path.join(DEV_CACHE_DIR, `${hash}.mjs`);
      if (!fileExists(outFile)) {
        fs.writeFileSync(outFile, out + `\n//# sourceURL=${toURL(fsPath)}`);
        if (DEBUG) {
          console.log(
            "[vite-plugin-node-worker][DEBUG] emitted",
            outFile,
            "from",
            fsPath
          );
        }
      }
      const url = toURL(outFile);
      cache.set(fsPath, url);
      return url;
    } finally {
      active.delete(fsPath);
    }
  }

  // Start from entry file path, return the rewritten entry code and output URL
  const entryURL = await rewriteModule(entryFile);
  return { entryURL };
}

/**
 * @fileoverview
 * Resolve `?nodeWorker` and `?modulePath` imports for Node worker_threads.
 * - DEV (serve): generate wrappers that use file URLs (no emitFile).
 * - BUILD: emit chunks and replace placeholders to relative paths.
 *
 * @doctype module
 */
export default function workerPlugin() {
  let sourcemap = false;
  let isServe = false;
  let root = process.cwd();
  let aliases = [];

  return {
    name: "vite:node-worker",
    enforce: "pre",

    configResolved(config) {
      sourcemap = !!config.build.sourcemap;
      isServe = config.command === "serve";
      root = config.root || root;
      aliases = normalizeAliases(config.resolve && config.resolve.alias);
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

      // Prefer a context-aware resolution that avoids self-recursion
      const resolved2 = await this.resolve(cleanPath, importerFile, {
        skipSelf: true,
      });
      if (resolved2?.id && resolved2.id !== resolved?.id) {
        // Put this first so it wins over manual fs probing
        tryPaths.unshift(resolved2.id.replace(/\?.*$/, ""));
      }

      // 2) If id is relative, resolve against importer dir
      if (!cleanPath.startsWith("/")) {
        tryPaths.push(path.resolve(path.dirname(importerFile), cleanPath));
      } else {
        // 3) If id starts with '/' but isn't a real file, treat as relative to Vite root
        tryPaths.push(path.resolve(root, cleanPath.slice(1)));
      }

      // 4) Also try root + id as-is
      tryPaths.push(path.resolve(root, cleanPath));

      // Pick the first existing file
      let absId = tryPaths.find((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
      if (!absId) absId = (resolved?.id || cleanPath).replace(/\?.*$/, "");

      // ---------------- DEV (serve) ----------------
      if (isServe) {
        // Recursively rewrite the worker entry and its local imports to file: URLs
        try {
          const { entryURL } = await rewriteEntryAliasesToFile("", absId, {
            root,
            aliases,
          });
          absId = new URL(entryURL).pathname; // keep fs path for toFileURL below
        } catch (err) {
          if (DEBUG) {
            console.error(
              "[vite-plugin-node-worker][DEBUG] rewrite failed, using original entry without alias transform:",
              absId,
              "\n",
              err
            );
          }
          // Fall back to running the original file (may fail if it contains aliases)
        }

        if (DEBUG) {
          console.log(
            "[vite-plugin-node-worker][DEBUG] worker entry URL:",
            toFileURL(absId)
          );
        }

        // ?modulePath → export file URL for new Worker(url, opts)
        if (query.modulePath != null) {
          return `export default new URL(${JSON.stringify(toFileURL(absId))})`;
        }
        // ?nodeWorker → export a wrapper that constructs Worker
        if (query.nodeWorker != null) {
          return `
            import { Worker } from 'node:worker_threads';
            const url = new URL(${JSON.stringify(toFileURL(absId))});
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
        map: sourcemap ? s.generateMap({ hires: true }) : null,
      };
    },
  };
}

function parseRequest(id) {
  const { search } = new URL(id, "file:");
  if (!search) return null;
  return Object.fromEntries(new URLSearchParams(search));
}
