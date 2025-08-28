import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, URL, URLSearchParams } from "node:url";

import MagicString from "magic-string";
import { transformWithEsbuild, normalizePath,transformWithOxc } from "vite";

const transformWith = typeof transformWithOxc === "function" ? transformWithOxc : transformWithEsbuild;

const DEBUG = process.env.VNW_DEBUG === "1";

function normalizeAliases(raw) {
  if (!raw) return [];
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

function toRelativePath(filename, importer) {
  const from = path.posix.dirname(importer);
  const relPath = path.posix.relative(from, filename);
  const norm = normalizePath(relPath);
  return norm.startsWith(".") ? norm : `./${norm}`;
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
    candidates.add(base);
    candidates.add(baseNoExt + ".ts");
    candidates.add(baseNoExt + ".tsx");
    candidates.add(baseNoExt + ".mts");
    candidates.add(baseNoExt + ".cts");
    candidates.add(baseNoExt + ".mjs");
    candidates.add(baseNoExt + ".cjs");
    candidates.add(baseNoExt + ".js");
  } else {
    for (const e of PROBE_EXTS) {
      candidates.add(baseNoExt + e);
    }
  }

  const dir = base;
  for (const e of PROBE_EXTS.slice(1)) {
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
  importFrom: /(import\s+[^'";]*?from\s*['"])([^'"\n]+)(['"])/g,
  exportFrom: /(export\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\*|[\w$,\s]*)\s*from\s*['"])([^'"\n]+)(['"])/g,
  dynImport: /(import\s*\(\s*['"])([^'"\n]+)(['"]\s*\))/g,
  sideImport: /(import\s*['"])([^'"\n]+)(['"])/g,
};

const NODE_BUILTINS = new Set([
  'assert','buffer','child_process','cluster','console','constants','crypto','dgram','diagnostics_channel','dns','domain','events','fs','fs/promises','http','http2','https','module','net','os','path','perf_hooks','process','punycode','querystring','readline','repl','stream','string_decoder','sys','timers','tls','tty','url','util','v8','vm','wasi','worker_threads','zlib'
]);

async function rewriteEntryAliasesToFile(src, entryFile, opts) {
  const projectRoot = (opts && opts.root) || process.cwd();
  const projectAliases = (opts && opts.aliases) || [];
  const env = opts && opts.env;

  // Use opts.cacheDir if provided, otherwise default to node_modules/.vite-plugin-node-worker/dev
  const DEV_CACHE_DIR = (opts && opts.cacheDir)
    ? path.resolve(projectRoot, opts.cacheDir)
    : path.join(projectRoot, "node_modules/.vite-plugin-node-worker/dev");

  const cache = new Map();
  const active = new Set();

  // Cache transpiled outputs by (fsPath, mtime) to avoid re-transpiling unchanged files
  const esbuildCache = new Map(); // key: fsPath, value: { mtimeMs: number, code: string }
  const resolveCache = new Map(); // key: `${fromFile}::${spec}` -> string | null

  function getMtimeMsSafe(p) {
    try {
      const st = fs.statSync(p);
      return st.mtimeMs || 0;
    } catch {
      return 0;
    }
  }

  function toURL(p) {
    return toFileURL(p);
  }

  async function resolveToFs(spec, fromFile) {
    if (!spec || typeof spec !== "string") return null;
    const cacheKey = `${fromFile || ''}::${spec}`;
    if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);

    // Treat external URL-like imports as non-rewritable
    if (/^(?:https?:|data:|deno:)/.test(spec)) { resolveCache.set(cacheKey, null); return null; }

    // Normalize node: scheme and skip node built-ins entirely
    const noNodePrefix = spec.replace(/^node:/, "");
    const isBare = !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("file:") && !/^[A-Za-z]:\\/.test(spec);
    if (isBare && NODE_BUILTINS.has(noNodePrefix)) { resolveCache.set(cacheKey, null); return null; }

    // Apply project aliases for non-relative, non-absolute specs first
    if (isBare) {
      const aliased = applyAliases(spec, projectAliases);
      if (aliased !== spec) spec = aliased;
      else if (env?.pluginContainer?.resolveId) {
        const r = await env.pluginContainer.resolveId(spec, fromFile);
        if (r && r.id) {
          // Explicit externals or node: builtins – do not rewrite
          if (r.external) { resolveCache.set(cacheKey, null); return null; }
          if (r.id.startsWith("node:")) { resolveCache.set(cacheKey, null); return null; }

          // /@fs/ -> absolute filesystem path
          if (r.id.startsWith("/@fs/")) { const v = r.id.slice(4); resolveCache.set(cacheKey, v); return v; }

          // Virtual pre-bundled id – handle upstream in rewriteModule
          if (r.id.startsWith("/@id/")) { resolveCache.set(cacheKey, r.id); return r.id; }

          // Absolute path or file URL returned by resolver
          if (path.isAbsolute(r.id) || r.id.startsWith("file:")) { resolveCache.set(cacheKey, r.id); return r.id; }

          // Unknown shape – let upstream treat as virtual id
          resolveCache.set(cacheKey, r.id); return r.id;
        }
        resolveCache.set(cacheKey, null); return null;
      }
    }

    // file: URLs -> filesystem path
    if (spec.startsWith("file:")) {
      try { const v = new URL(spec).pathname; resolveCache.set(cacheKey, v); return v; } catch { resolveCache.set(cacheKey, null); return null; }
    }

    // Re-apply aliases defensively
    spec = applyAliases(spec, projectAliases);

    // Resolve to absolute base path
    let base;
    if (path.isAbsolute(spec)) {
      base = spec.startsWith("/") ? path.resolve(projectRoot, spec.slice(1)) : spec;
    } else if (spec.startsWith(".")) {
      base = path.resolve(path.dirname(fromFile), spec);
    } else {
      base = path.resolve(projectRoot, spec);
    }

    const resolved = tryResolveFileLike(base);
    resolveCache.set(cacheKey, resolved);
    return resolved;
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
      return toURL(fsPath);
    }
    if (cache.has(fsPath)) return cache.get(fsPath);

    let code;
    const isVirtualId = fsPath.startsWith("/@id/") || fsPath.startsWith("\u0000") || fsPath.startsWith("virtual:");

    if (fsPath.startsWith("/@fs/")) {
      fsPath = fsPath.slice(4);
    }

    try {
      if (isVirtualId) {
        if (!env || typeof env.transformRequest !== "function") {
          // Cannot transform virtual ids without Vite – leave as-is
          const url = toURL(fsPath);
          cache.set(fsPath, url);
          return url;
        }
        // Avoid SSR helpers in dev: use ssr: false
        const res = await env.transformRequest(fsPath, { ssr: false });
        if (!res || !res.code) {
          const url = toURL(fsPath);
          cache.set(fsPath, url);
          return url;
        }
        code = res.code;
      } else {
        code = fs.readFileSync(fsPath, "utf8");
        const ext = path.extname(fsPath).toLowerCase();

        // Only TS-like files need transpilation
        const isTsLike = ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts";
        if (isTsLike) {
          const mtimeMs = getMtimeMsSafe(fsPath);
          const cached = esbuildCache.get(fsPath);
          if (cached && cached.mtimeMs === mtimeMs) {
            // Reuse previous esbuild output
            code = cached.code;
          } else {
            try {
              const esb = await transformWith(code, fsPath, {
                loader: ext === ".tsx" ? "tsx" : "ts",
                format: "esm",
                sourcemap: false,
                target: "esnext",
                tsconfigRaw: {}
              });
              if (esb && esb.code) {
                code = esb.code;
                esbuildCache.set(fsPath, { mtimeMs, code });
              }
            } catch (e) {
              if (DEBUG) console.warn("[vite-plugin-node-worker][DEBUG] esbuild transform failed for", fsPath, e);
            }
          }
        }
      }
    } catch (err) {
      if (DEBUG) {
        console.error(
          "[vite-plugin-node-worker][DEBUG] failed to read file for rewrite:",
          fsPath,
          "\n",
          err
        );
      }
      throw err;
    }

    const originalURL = toURL(fsPath);
    cache.set(fsPath, originalURL);
    active.add(fsPath);
    try {
      let out = code;
      let ms = new MagicString(out);

      async function applyTripletRule(re, resolver) {
        re.lastIndex = 0;
        for (const m of out.matchAll(re)) {
          const p1 = m[1];
          const spec = m[2];
          const p3 = m[3];
          if (!spec) continue;
          const start = m.index + p1.length;
          const end = start + spec.length;
          const replacement = await resolver(spec);
          if (replacement && replacement !== spec) {
            ms.overwrite(start, end, replacement, { contentOnly: true });
          }
        }
        out = ms.toString();
      }

      await applyTripletRule(RE.sideImport, async (spec) => {
        const childFs = await resolveToFs(spec, fsPath);
        if (!childFs || childFs === fsPath) return spec;
        return await rewriteModule(childFs);
      });

      await applyTripletRule(RE.importFrom, async (spec) => {
        const childFs = await resolveToFs(spec, fsPath);
        if (!childFs || childFs === fsPath) return spec;
        return await rewriteModule(childFs);
      });

      try {
        await applyTripletRule(RE.exportFrom, async (spec) => {
          const childFs = await resolveToFs(spec, fsPath);
          if (!childFs || childFs === fsPath) return spec;
          return await rewriteModule(childFs);
        });
      } catch (e) {
        if (DEBUG) {
          console.warn(
            "[vite-plugin-node-worker][DEBUG] skipping export-from rewrite due to",
            fsPath,
            "\n",
            e
          );
        }
      }

      await applyTripletRule(/(['"])(~\/[\w@./-]+)(['"])/g, async (spec) => {
        const childFs = await resolveToFs(spec, fsPath);
        if (!childFs) return spec;
        return toURL(childFs);
      });

      // Handle absolute imports that Vite (or upstream transforms) may have left as
      // "/node_modules/...". In Node, an import like that is treated as an absolute
      // path from the filesystem root and will fail ("file:///node_modules/..." does not exist).
      // We prefer to ask Vite's resolver first, then fallback.
      await applyTripletRule(/(['"])\/(node_modules\/[^'"\n]+)(['"])/g, async (spec) => {
        const full = '/' + spec; // restore leading slash
        if (env?.pluginContainer?.resolveId) {
          const r = await env.pluginContainer.resolveId(full, fsPath);
          if (r?.external) return full;
          if (r?.id?.startsWith('/@fs/')) return await rewriteModule(r.id.slice(4));
          if (r?.id?.startsWith('/@id/')) return await rewriteModule(r.id);
          if (r?.id && (path.isAbsolute(r.id) || r.id.startsWith('file:'))) return await rewriteModule(r.id);
        }
        const childFs = await resolveToFs(full, fsPath);
        return childFs ? await rewriteModule(childFs) : full;
      });

      if (DEBUG && /(^|[^A-Za-z0-9_])~\//.test(out)) {
        console.warn(
          "[vite-plugin-node-worker][DEBUG] alias tokens remain after rewrite in",
          fsPath
        );
      }

      // Safety normalization for any stray /node_modules/... strings in template literals or elsewhere
      out = out.replace(/(["'`])\/(node_modules\/[^"'`\n]+)(["'`])/g, (m, q1, p, q3) => {
        const abs = path.resolve(projectRoot, p);
        const probed = tryResolveFileLike(abs) || abs;
        return `${q1}${toURL(probed)}${q3}`;
      });


      // Safety net: if upstream still injected SSR helpers, provide a minimal shim
      if (out.includes("__vite_ssr_import__")) {
        out = `async function __vite_ssr_import__(u){ return import(u); }\n` + out;
      }
      if (out.includes("__vite_ssr_dynamic_import__")) {
        out = `async function __vite_ssr_dynamic_import__(u){ return import(u); }\n` + out;
      }

      fs.mkdirSync(DEV_CACHE_DIR, { recursive: true });
      const hash = sha1(fsPath + "|" + out).slice(0, 12);
      const outFile = path.join(DEV_CACHE_DIR, `${hash}.mjs`);
      if (!fileExists(outFile)) {
        fs.writeFileSync(outFile, out + `\n//# sourceURL=${toURL(fsPath)}`);
        if (DEBUG) {
          console.log("[vite-plugin-node-worker][DEBUG] emitted", outFile, "from", fsPath);
        }
      }
      const url = toURL(outFile);
      cache.set(fsPath, url);
      return url;
    } finally {
      active.delete(fsPath);
    }
  }

  const entryURL = await rewriteModule(entryFile);
  return { entryURL };
}

export default function workerPlugin() {
  let sourcemap = false;
  let isServe = false;
  let root = process.cwd();
  let aliases = [];
  let devServer = null;
  let cacheDirFromVite = null;

  return {
    name: "vite:node-worker",
    enforce: "pre",

    configResolved(config) {
      sourcemap = !!config.build.sourcemap;
      isServe = config.command === "serve";
      root = config.root || root;
      aliases = normalizeAliases(config.resolve && config.resolve.alias);
      cacheDirFromVite = config.cacheDir || path.join(root, 'node_modules/.vite');
    },

    configureServer(s) {
      devServer = s;
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

      const resolved = await this.resolve(cleanPath, importerFile);
      if (resolved?.id) tryPaths.push(resolved.id.replace(/\?.*$/, ""));

      const resolved2 = await this.resolve(cleanPath, importerFile, {
        skipSelf: true,
      });
      if (resolved2?.id && resolved2.id !== resolved?.id) {
        tryPaths.unshift(resolved2.id.replace(/\?.*$/, ""));
      }

      if (!cleanPath.startsWith("/")) {
        tryPaths.push(path.resolve(path.dirname(importerFile), cleanPath));
      } else {
        tryPaths.push(path.resolve(root, cleanPath.slice(1)));
      }

      tryPaths.push(path.resolve(root, cleanPath));

      let absId = tryPaths.find((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
      if (!absId) absId = (resolved?.id || cleanPath).replace(/\?.*$/, "");

      if (isServe) {
        const env =
          this.environment ||
          (devServer?.environments?.client ?? devServer?.environments?.ssr) ||
          null;

        try {
          const { entryURL } = await rewriteEntryAliasesToFile("", absId, {
            root,
            aliases,
            env,
            cacheDir: path.join(cacheDirFromVite || path.join(root, 'node_modules/.vite'), 'node-worker')
          });
          absId = new URL(entryURL).pathname;
        } catch (err) {
          if (DEBUG) {
            console.error(
              "[vite-plugin-node-worker][DEBUG] rewrite failed:",
              absId,
              "\n",
              err
            );
          }
        }

        if (DEBUG) {
          console.log("[vite-plugin-node-worker][DEBUG] worker entry URL:", toFileURL(absId));
        }

        if (query.modulePath != null) {
          return `export default new URL(${JSON.stringify(toFileURL(absId))})`;
        }
        if (query.nodeWorker != null) {
          return `
            import { Worker } from 'node:worker_threads';
            const url = new URL(${JSON.stringify(toFileURL(absId))});
            export default function (options) { return new Worker(url, options) }
          `;
        }
        return;
      }

      if (query.nodeWorker != null || query.modulePath != null) {
        const base = path.basename(cleanPath, path.extname(cleanPath));
        const refId = this.emitFile({
          type: "chunk",
          id: absId,
          importer: query.importer,
          fileName: `${base}.worker.mjs`, // temporary name; we will rename in generateBundle
        });

        const assetRefId = `__VITE_NODE_WORKER_ASSET__${refId}__`;

        if (query.modulePath != null) {
          return `export default ${assetRefId}`;
        }
        return `
          import { Worker } from 'node:worker_threads';
          export default function (options) { return new Worker(new URL(${assetRefId}, import.meta.url), options) }
        `;
      }
    },

    handleHotUpdate(ctx) {
      // Best-effort: when files change, future rewrites will produce new hashed cache filenames.
      // If you later promote caches to module scope, invalidate them here.
      return ctx.modules;
    },

    generateBundle(_, bundle) {
      // Replace placeholders with final relative paths (no renaming, no hashing)
      for (const fileName of Object.keys(bundle)) {
        const b = bundle[fileName];
        if (b.type !== 'chunk') continue;
        if (!nodeWorkerAssetUrlRE.test(b.code)) continue;
        nodeWorkerAssetUrlRE.lastIndex = 0;
        const s = new MagicString(b.code);
        let m;
        while ((m = nodeWorkerAssetUrlRE.exec(b.code))) {
          const full = m[0];
          const refId = m[1];
          let workerName;
          try {
            workerName = this.getFileName(refId);
          } catch {
            // Unknown refId – skip without throwing
            continue;
          }
          const rel = toRelativePath(workerName, fileName);
          s.overwrite(m.index, m.index + full.length, JSON.stringify(rel), { contentOnly: true });
        }
        b.code = s.toString();
        if (sourcemap) b.map = s.generateMap({ hires: true });
      }
    },
  };
}

function parseRequest(id) {
  const { search } = new URL(id, "file:");
  if (!search) return null;
  return Object.fromEntries(new URLSearchParams(search));
}