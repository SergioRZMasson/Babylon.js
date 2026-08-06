import { type ISceneLoaderPluginExtensions, type ISceneLoaderPluginMetadata } from "core/index";

export const USDFileLoaderMetadata = {
    name: "usd",

    extensions: {
        // The converter takes bytes for every flavour: .usdc and .usdz are binary, and
        // .usd/.usda are handed over as an ArrayBuffer too so a single path covers all four.
        ".usd": { isBinary: true, mimeType: "model/vnd.usd" },
        ".usda": { isBinary: true, mimeType: "model/vnd.usda" },
        ".usdc": { isBinary: true, mimeType: "model/vnd.usdc" },
        ".usdz": { isBinary: true, mimeType: "model/vnd.usdz+zip" },
    } as const satisfies ISceneLoaderPluginExtensions,
} as const satisfies ISceneLoaderPluginMetadata;
