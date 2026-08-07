/**
 * Vite entry point for the Babylon.js Sandbox.
 *
 * Dev mode: imports directly and calls Sandbox.Show immediately.
 * Production: the CDN bootstrap (public/index.js) loads Babylon from CDN,
 * then loads babylon.sandbox.js (a build-time-generated shim that injects
 * this module and registers a BABYLON.Sandbox.Show stub).  The stub captures
 * the Show args and dispatches a "babylonSandboxReady" event that we pick up
 * here to start the sandbox with the correct version info.
 */
// Register the GLTF/GLB loader plus all glTF 2.0 extensions (draco, mesh quantization, KHR materials, etc.).
// The sandbox loads .glb/.gltf files directly via SceneLoader and must support arbitrary extensions.
import "loaders/glTF/2.0";
// Register the FBX loader so .fbx files can be loaded via SceneLoader (drag-and-drop and the file picker).
import "loaders/FBX/fbxFileLoader";
// Register the USD loader so .usd/.usda/.usdc/.usdz files can be loaded. It converts to glTF in
// WebAssembly and delegates to the glTF loader registered above, fetching its WebAssembly module
// on first use.
import "loaders/USD/usdFileLoader";
import { USDConverter } from "loaders/USD/usdConverter";
// Register Scene animation extensions (e.g. getAllAnimatablesByTarget) used by the Inspector's animation panel.
import "core/Animations/animatable";
import { Sandbox } from "./sandbox";

// USDConverter.DefaultConfiguration points at cdn.babylonjs.com. The Vite dev server does not
// run the CDN bootstrap (public/index.js) that sets Tools.ScriptBaseUrl, so redirect the
// converter at the copy vite.config.ts serves from the local CDN
// (packages/tools/babylonServer/public/usd).
if (import.meta.env.DEV) {
    USDConverter.DefaultConfiguration = {
        wasmUrl: `${location.origin}/usd/usd-web-gltf.js`,
        wasmBinaryUrl: `${location.origin}/usd/usd-web-gltf.wasm`,
        dataUrl: `${location.origin}/usd/usd-web-gltf.data`,
    };
}

const HostElement = document.getElementById("host-element") as HTMLElement;

if (import.meta.env.DEV) {
    // Dev mode — register the Inspector v2 debug layer (production gets it from the CDN bundle),
    // then show immediately. The inspector index attaches Scene.debugLayer as a side effect.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
        await import("inspector/index");
        Sandbox.Show(HostElement, { version: "dev", bundles: [] });
    })();
} else {
    // Production — CDN bootstrap calls BABYLON.Sandbox.Show which stores args
    const win = window as unknown as Record<string, unknown>;
    if (Array.isArray(win["__viteSandboxArgs"])) {
        Sandbox.Show(
            (win["__viteSandboxArgs"] as [HTMLElement, { version: string; bundles: string[] }])[0],
            (win["__viteSandboxArgs"] as [HTMLElement, { version: string; bundles: string[] }])[1]
        );
    } else {
        window.addEventListener(
            "babylonSandboxReady",
            (e: Event) => {
                const args = (e as CustomEvent<{ args: [HTMLElement, { version: string; bundles: string[] }] }>).detail.args;
                Sandbox.Show(args[0], args[1]);
            },
            { once: true }
        );
    }
}
