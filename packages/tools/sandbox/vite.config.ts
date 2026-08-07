import { defineConfig } from "vite";
import path from "path";
import fs from "fs";
// @ts-ignore -- untyped JS helper
import { commonDevViteConfiguration, babylonDevExternalsPlugin } from "../../public/viteToolsHelper.mjs";

// Files the USD converter downloads at runtime, and the content types they must be served
// with. Emscripten instantiates the wasm by streaming, which requires application/wasm.
const usdCdnAssets: Record<string, string> = {
    "usd-web-gltf.js": "text/javascript",
    "usd-web-gltf.wasm": "application/wasm",
    "usd-web-gltf.data": "application/octet-stream",
};

/**
 * Serves the USD converter's WebAssembly artifacts from the local CDN
 * (packages/tools/babylonServer/public/usd) during `vite dev`.
 *
 * The production sandbox reaches them through Tools.ScriptBaseUrl, which public/index.js
 * points at either the real CDN or babylonServer. The Vite dev server never runs that
 * bootstrap, so without this the sandbox would request them from cdn.babylonjs.com. Serving
 * the babylonServer copy keeps a single source of truth for the ~12 MB binary instead of
 * staging a second copy under the sandbox's own public folder.
 */
function usdLocalCdnPlugin() {
    const cdnDir = path.resolve(__dirname, "../babylonServer/public/usd");

    return {
        name: "usd-local-cdn",
        apply: "serve" as const,
        configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
            server.middlewares.use((req, res, next) => {
                const fileName = req.url?.split("?")[0].replace(/^\/usd\//, "");
                const contentType = fileName ? usdCdnAssets[fileName] : undefined;
                if (!req.url?.startsWith("/usd/") || !contentType) {
                    next();
                    return;
                }

                const filePath = path.join(cdnDir, fileName!);
                if (!fs.existsSync(filePath)) {
                    res.statusCode = 404;
                    res.end(`${fileName} is missing from ${cdnDir}.`);
                    return;
                }

                res.setHeader("Content-Type", contentType);
                res.setHeader("Content-Length", fs.statSync(filePath).size);
                fs.createReadStream(filePath).pipe(res);
            });
        },
    };
}

const base = commonDevViteConfiguration({
    port: parseInt(process.env.SANDBOX_PORT ?? "1339"),
    aliases: {
        "shared-ui-components": path.resolve("../../dev/sharedUiComponents/dist"),
        core: path.resolve("../../dev/core/dist"),
        gui: path.resolve("../../dev/gui/dist"),
        loaders: path.resolve("../../dev/loaders/dist"),
        serializers: path.resolve("../../dev/serializers/dist"),
        materials: path.resolve("../../dev/materials/dist"),
        addons: path.resolve("../../dev/addons/dist"),
        inspector: path.resolve("../../dev/inspector-v2/dist"),
        // Inspector v2 lazily imports the node/GUI editors when those panels are opened.
        // Alias them so Vite can resolve the dynamic imports in dev (loaded on demand only).
        "gui-editor": path.resolve("../../tools/guiEditor/dist"),
        "node-editor": path.resolve("../../tools/nodeEditor/dist"),
        "node-geometry-editor": path.resolve("../../tools/nodeGeometryEditor/dist"),
        "node-particle-editor": path.resolve("../../tools/nodeParticleEditor/dist"),
        "node-render-graph-editor": path.resolve("../../tools/nodeRenderGraphEditor/dist"),
    },
    productionExternals: {
        babylonjs: "BABYLON",
        "babylonjs-gui": "BABYLON.GUI",
        "babylonjs-loaders": "BABYLON",
        "babylonjs-serializers": "BABYLON",
        "babylonjs-materials": "BABYLON",
        "babylonjs-addons": "ADDONS",
    },
});

export default defineConfig({
    ...base,
    plugins: [
        ...(base.plugins ?? []),
        usdLocalCdnPlugin(),
        // Rewrite dev-package imports (core/*, gui/*, …) to globalThis.BABYLON accesses
        // during production builds. In dev mode the resolve.alias entries handle resolution;
        // in build mode this plugin (enforce: "pre") rewrites the imports before Rollup
        // resolves them through aliases, keeping the bundle small and deferring to CDN UMDs.
        {
            ...babylonDevExternalsPlugin({
                core: "BABYLON",
                gui: "BABYLON.GUI",
                loaders: "BABYLON",
                serializers: "BABYLON",
                materials: "BABYLON",
                addons: "ADDONS",
            }),
            apply: "build" as const,
        },
        {
            // Generates `babylon.sandbox.js` at build time.
            //
            // The production HTML (public/index.html) uses a CDN bootstrap that
            // loads `babylon.sandbox.js` then calls BABYLON.Sandbox.Show().
            // In the old dev-server flow this file was the compiled bundle. With Vite the
            // bundle is ES modules in assets/. This plugin generates a shim that:
            //   1. Injects <style> tags with inlined CSS and a <script type="module">
            //      tag for the Vite-built entry chunk (with correct hashed filename).
            //   2. Registers a BABYLON.Sandbox.Show stub that captures args and
            //      dispatches an event picked up by main.ts.
            //
            // CSS is inlined as <style> (not loaded via <link>) so it is applied
            // synchronously, matching the old runtime style-injection behavior and
            // preventing Playwright screenshots from capturing an unstyled page.
            name: "generate-sandbox-shim",
            apply: "build" as const,
            generateBundle(_options, bundle) {
                const entryChunk = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry);
                const cssAssets = Object.values(bundle).filter((a) => a.type === "asset" && a.fileName.endsWith(".css"));

                const moduleSrc = entryChunk ? `./${entryChunk.fileName}` : "./assets/index.js";
                // Inline CSS content into <style> tags so styles are applied synchronously.
                const cssInjections = cssAssets
                    .map((a) => {
                        const cssContent = "source" in a ? String(a.source) : "";
                        // Escape backticks and backslashes for template literal safety
                        const escaped = cssContent.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
                        return `var st=document.createElement("style");st.textContent=\`${escaped}\`;document.head.appendChild(st);`;
                    })
                    .join("\n    ");

                const shimCode = `(function () {
    // Inject Vite-built CSS inline (synchronous — no FOUC)
    ${cssInjections}
    // Load Vite-built ES module entry
    var s = document.createElement("script");
    s.type = "module";
    s.crossOrigin = "";
    s.src = "${moduleSrc}";
    document.head.appendChild(s);
    // Register BABYLON.Sandbox.Show shim for the CDN bootstrap (index.js)
    var B = window.BABYLON || (window.BABYLON = {});
    B.Sandbox = {
        Show: function (hostElement, versionInfo) {
            var args = [hostElement, versionInfo];
            window.__viteSandboxArgs = args;
            window.dispatchEvent(new CustomEvent("babylonSandboxReady", { detail: { args: args } }));
        },
    };
})();
`;
                this.emitFile({ type: "asset", fileName: "babylon.sandbox.js", source: shimCode });
            },
        },
    ],
});
