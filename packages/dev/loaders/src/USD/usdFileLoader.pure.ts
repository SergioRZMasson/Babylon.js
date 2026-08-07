import {
    type ISceneLoaderAsyncResult,
    type ISceneLoaderPluginAsync,
    type ISceneLoaderPluginFactory,
    type ISceneLoaderProgressEvent,
    type SceneLoaderPluginOptions,
    AppendSceneAsync,
    ImportMeshAsync,
    LoadAssetContainerAsync,
    RegisterSceneLoaderPlugin,
} from "core/Loading/sceneLoader";
import { type AssetContainer } from "core/assetContainer";
import { type Scene } from "core/scene";
import { type Nullable } from "core/types";
import { Logger } from "core/Misc/logger";
import { FilesInputStore } from "core/Misc/filesInputStore";

import { USDConverter, type IUSDConvertOptions } from "./usdConverter";
import { USDFileLoaderMetadata } from "./usdFileLoader.metadata";
import { type USDLoadingOptions } from "./usdLoadingOptions";

/**
 * USD file loader plugin for Babylon.js.
 *
 * USD is converted to glTF in WebAssembly by OpenUSD and Adobe's `usdGltf` file format
 * plugin, and the resulting GLB is handed to the glTF loader. Nothing about the
 * translation is reimplemented here, so the conversion matches what a desktop USD
 * installation produces.
 *
 * The converter is a sizeable download (roughly 12 MB uncompressed, about 2 MB brotli) and
 * is fetched on first use. Call `USDConverter.Default.whenReadyAsync()` ahead of time to
 * pay that cost when it suits the application.
 *
 * The shipped module is single-threaded, so it needs no cross-origin isolation and can be
 * served from anywhere. A pthreads build exists for throughput on large scenes; using it
 * requires `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`.
 *
 * Not every USD feature survives the round trip through glTF. Blend shapes, curves, NURBS,
 * implicit primitives (Cube, Sphere, Cylinder), point instancer animation and `purpose` have
 * no glTF representation and are dropped. Meshes, transforms, materials, skinning and
 * skeletal animation are preserved.
 */
export class USDFileLoader implements ISceneLoaderPluginAsync, ISceneLoaderPluginFactory {
    /**
     * Defines the name of the plugin.
     */
    public readonly name = USDFileLoaderMetadata.name;

    /**
     * Defines the extensions the USD loader is able to load.
     */
    public readonly extensions = USDFileLoaderMetadata.extensions;

    private readonly _loadingOptions: Partial<Readonly<USDLoadingOptions>>;

    /**
     * Creates a new USD file loader.
     * @param options options for the loader
     */
    constructor(options: Partial<Readonly<USDLoadingOptions>> = {}) {
        this._loadingOptions = options;
    }

    /**
     * Instantiates a USD file loader plugin.
     * @param options plugin options
     * @returns the created plugin
     */
    public createPlugin(options: SceneLoaderPluginOptions): ISceneLoaderPluginAsync {
        return new USDFileLoader(options[USDFileLoaderMetadata.name]);
    }

    /**
     * Imports meshes from the loaded USD data.
     * @param meshesNames An array of mesh names, a single mesh name, or empty string for all meshes that filter what meshes are imported
     * @param scene The scene to import into
     * @param data The USD payload
     * @param rootUrl The root url for scene and resources
     * @param onProgress The callback when the load progresses
     * @param fileName Defines the name of the file to load
     * @returns The loaded objects (e.g. meshes, particle systems, skeletons, animation groups, etc.)
     */
    public async importMeshAsync(
        meshesNames: string | readonly string[] | null | undefined,
        scene: Scene,
        data: unknown,
        rootUrl: string,
        onProgress?: (event: ISceneLoaderProgressEvent) => void,
        fileName?: string
    ): Promise<ISceneLoaderAsyncResult> {
        const glb = await this._convertAsync(data, fileName);
        return await ImportMeshAsync(glb, scene, { meshNames: meshesNames, pluginExtension: ".glb", rootUrl, onProgress });
    }

    /**
     * Loads the USD data into the scene.
     * @param scene The scene to load into
     * @param data The USD payload
     * @param rootUrl The root url for scene and resources
     * @param onProgress The callback when the load progresses
     * @param fileName Defines the name of the file to load
     */
    public async loadAsync(scene: Scene, data: unknown, rootUrl: string, onProgress?: (event: ISceneLoaderProgressEvent) => void, fileName?: string): Promise<void> {
        const glb = await this._convertAsync(data, fileName);
        await AppendSceneAsync(glb, scene, { pluginExtension: ".glb", rootUrl, onProgress });
    }

    /**
     * Loads the USD data into an asset container.
     * @param scene The scene to load into
     * @param data The USD payload
     * @param rootUrl The root url for scene and resources
     * @param onProgress The callback when the load progresses
     * @param fileName Defines the name of the file to load
     * @returns The loaded asset container
     */
    public async loadAssetContainerAsync(
        scene: Scene,
        data: unknown,
        rootUrl: string,
        onProgress?: (event: ISceneLoaderProgressEvent) => void,
        fileName?: string
    ): Promise<AssetContainer> {
        const glb = await this._convertAsync(data, fileName);
        return await LoadAssetContainerAsync(glb, scene, { pluginExtension: ".glb", rootUrl, onProgress });
    }

    /**
     * Converts the incoming USD payload to a GLB buffer.
     * @param data the payload handed over by the scene loader
     * @param fileName the source file name, which selects the USD importer
     * @returns the GLB bytes
     */
    private async _convertAsync(data: unknown, fileName?: string): Promise<Uint8Array> {
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
            // Every extension is registered as binary, so anything else means the plugin was
            // invoked directly with the wrong payload.
            throw new Error("USDFileLoader: expected the USD data to be an ArrayBuffer.");
        }

        const options = this._loadingOptions;
        const converter = options.converterConfiguration ? new USDConverter(options.converterConfiguration) : USDConverter.Default;

        // The extension selects the importer, so a name is always supplied. Falling back to
        // .usdz would misroute a plain .usd, so the generic .usd is used instead: OpenUSD
        // sniffs the actual encoding for that extension.
        const resolvedFileName = fileName ?? "input.usd";

        const convertOptions: IUSDConvertOptions = {
            fileName: resolvedFileName,
            onLog:
                options.onLog ??
                ((message) => {
                    if (message.level === "error") {
                        Logger.Error(`USD: ${message.message}`);
                    } else if (message.level === "warning") {
                        Logger.Warn(`USD: ${message.message}`);
                    }
                }),
        };

        if (options.additionalFiles) {
            convertOptions.additionalFiles = options.additionalFiles;
        }
        if (options.resolveByFileName !== undefined) {
            convertOptions.resolveByFileName = options.resolveByFileName;
        }

        // A USD scene dropped as a folder arrives with its referenced layers and textures
        // already registered in FilesInputStore. Pulling them in here means drag-and-drop
        // resolves multi-file scenes without the application plumbing anything through.
        if (options.useFilesInputStore !== false) {
            const siblings = await ReadFilesInputStoreAsync(resolvedFileName, convertOptions.additionalFiles);
            if (siblings) {
                convertOptions.additionalFiles = siblings;
            }
        }

        const result = await converter.convertToGlbAsync(data, convertOptions);

        if (result.missingAssets.length > 0) {
            if (options.onMissingAssets) {
                options.onMissingAssets(result.missingAssets);
            } else {
                Logger.Warn(
                    `USD: ${result.missingAssets.length} referenced file(s) were never supplied, so that content is missing: ${result.missingAssets.join(", ")}. ` +
                        `Pass them through the loader's "additionalFiles" option.`
                );
            }
        }

        return result.data;
    }
}

/**
 * Registers the USD file loader with the scene loader.
 */
export function RegisterUSDFileLoader(): void {
    RegisterSceneLoaderPlugin(new USDFileLoader());
}

/**
 * Collects sibling files registered in `FilesInputStore` so a USD scene dropped as a
 * folder can resolve its referenced layers and textures.
 *
 * `FilesInputStore` keys carry the path each file had inside the dropped folder, while the
 * scene loader normally hands the plugin just the root layer's base name. Sibling paths are
 * therefore rebased so that they sit around the root layer exactly as they did on disk, and a
 * reference such as `@./textures/wood.png@` lands on the file the author meant instead of
 * relying on the converter's file-name fallback, which refuses to guess when two folders hold
 * the same file name.
 * @param rootFileName name of the file being loaded, which is skipped
 * @param explicitFiles files the caller supplied, which take precedence
 * @returns the merged file map, or null when there is nothing to add
 * @internal
 */
async function ReadFilesInputStoreAsync(rootFileName: string, explicitFiles?: { [path: string]: ArrayBufferView }): Promise<Nullable<{ [path: string]: ArrayBufferView }>> {
    const store = FilesInputStore.FilesToLoad;
    const names = Object.keys(store);
    if (names.length === 0) {
        return null;
    }

    // FilesInputStore keys are lowercased; the root file is already the payload we were
    // handed, so re-adding it would just duplicate it in the virtual filesystem.
    const rootKey = rootFileName.toLowerCase().replace(/\\/g, "/");
    const rootBaseName = rootKey.slice(rootKey.lastIndexOf("/") + 1);
    // Where the converter will place the root layer, which is what its relative references
    // resolve against.
    const rootDirectoryInFs = rootKey.slice(0, rootKey.lastIndexOf("/") + 1);

    // Locate the root layer's own entry to learn which folder the scene was rooted at. When
    // several folders hold a file of that name there is no way to tell which one was loaded,
    // so paths are left alone and the file-name fallback takes over.
    const rootMatches = names.map((name) => name.toLowerCase().replace(/\\/g, "/")).filter((key) => key === rootKey || key.slice(key.lastIndexOf("/") + 1) === rootBaseName);
    const storeDirectory = rootMatches.length === 1 ? rootMatches[0].slice(0, rootMatches[0].lastIndexOf("/") + 1) : "";

    const candidates = names.filter((name) => {
        const key = name.toLowerCase().replace(/\\/g, "/");
        if (key === rootKey || key.slice(key.lastIndexOf("/") + 1) === rootBaseName) {
            return false;
        }
        // An explicitly supplied file wins: the caller knows the layout better than we do.
        return !explicitFiles || !Object.prototype.hasOwnProperty.call(explicitFiles, name);
    });

    // Read concurrently: a dropped folder can hold many textures, and reading them one at
    // a time would serialise the whole load behind file I/O.
    const entries = await Promise.all(
        candidates.map(async (name) => {
            try {
                const key = name.toLowerCase().replace(/\\/g, "/");
                // Move the file from where it sat in the dropped folder to the matching spot
                // beside the root layer. Files outside the root layer's folder keep their full
                // path; they are still reachable through the file-name fallback.
                const path = storeDirectory && key.startsWith(storeDirectory) ? rootDirectoryInFs + key.slice(storeDirectory.length) : name;
                return { path, data: new Uint8Array(await store[name].arrayBuffer()) };
            } catch {
                // A file that cannot be read is simply not offered to the resolver; the
                // conversion then reports it through missingAssets if it was actually needed.
                return null;
            }
        })
    );

    const files: { [path: string]: ArrayBufferView } = {};
    let added = 0;
    for (const entry of entries) {
        if (entry) {
            files[entry.path] = entry.data;
            added++;
        }
    }

    if (added === 0) {
        return explicitFiles ?? null;
    }

    return { ...files, ...explicitFiles };
}
