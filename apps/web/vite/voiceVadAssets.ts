// @effect-diagnostics nodeBuiltinImport:off -- Vite plugin runs in Node before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { Plugin } from "vite-plus";

const require = NodeModule.createRequire(import.meta.url);

// Voice mode's VAD loads these by URL at runtime, so they ship as plain files under stable names
// rather than as hashed bundler assets. Only what Silero v5 on one WASM thread needs; the
// package contains far more (other models, ORT backends, source maps).
function resolveAssets() {
  const vadPackageJson = require.resolve("@ricky0123/vad-web/package.json");
  const vadDist = NodePath.join(NodePath.dirname(vadPackageJson), "dist");
  // onnxruntime-web is vad-web's own dependency, so resolve it the way vad-web does.
  const ortDist = NodePath.dirname(
    NodeModule.createRequire(vadPackageJson).resolve("onnxruntime-web/wasm"),
  );
  const { version } = require("@ricky0123/vad-web/package.json") as { version: string };
  return {
    version,
    files: [
      { name: "silero_vad_v5.onnx", path: NodePath.join(vadDist, "silero_vad_v5.onnx") },
      {
        name: "vad.worklet.bundle.min.js",
        path: NodePath.join(vadDist, "vad.worklet.bundle.min.js"),
      },
      {
        name: "ort-wasm-simd-threaded.mjs",
        path: NodePath.join(ortDist, "ort-wasm-simd-threaded.mjs"),
      },
      {
        name: "ort-wasm-simd-threaded.wasm",
        path: NodePath.join(ortDist, "ort-wasm-simd-threaded.wasm"),
      },
    ],
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

export function voiceVadAssetsPlugin(): Plugin {
  const { version, files } = resolveAssets();
  const urlPrefix = `/vad/${version}/`;
  return {
    name: "t3code:voice-vad-assets",
    configureServer(server) {
      server.middlewares.use(urlPrefix, (request, response, next) => {
        const name = (request.url ?? "").split("?")[0]?.replace(/^\//, "");
        const file = files.find((candidate) => candidate.name === name);
        if (!file) return next();
        response.setHeader(
          "Content-Type",
          CONTENT_TYPES[NodePath.extname(file.name)] ?? "application/octet-stream",
        );
        NodeFS.createReadStream(file.path).pipe(response);
      });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({
          type: "asset",
          fileName: `vad/${version}/${file.name}`,
          source: NodeFS.readFileSync(file.path),
        });
      }
    },
  };
}
