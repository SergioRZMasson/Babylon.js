import { Tools } from "core/Misc/tools.pure";
import { type IDisposable } from "core/scene";
import { type Nullable } from "core/types";

/**
 * Configuration for the USD to glTF converter.
 */
export interface IUSDConverterConfiguration {
    /**
     * The url to the Emscripten glue JavaScript module.
     */
    wasmUrl?: string;

    /**
     * The url to the WebAssembly binary.
     */
    wasmBinaryUrl?: string;

    /**
     * The url to the resource bundle holding OpenUSD's schemas and plugin manifests.
     * The converter cannot open a stage without it.
     */
    dataUrl?: string;

    /**
     * Optional ArrayBuffer of the WebAssembly binary.
     * If provided it will be used instead of loading the binary from wasmBinaryUrl.
     */
    wasmBinary?: ArrayBuffer;

    /**
     * The Emscripten module factory if already available.
     */
    jsModule?: unknown;
}

/**
 * Severity of a diagnostic emitted by OpenUSD while converting.
 */
export type USDLogLevel = "info" | "warning" | "error";

/**
 * A diagnostic emitted while converting.
 */
export interface IUSDLogMessage {
    /**
     * Severity of the message.
     */
    level: USDLogLevel;
    /**
     * The message text.
     */
    message: string;
}

/**
 * Options for a single conversion.
 */
export interface IUSDConvertOptions {
    /**
     * Name of the primary file including extension. The extension selects the importer,
     * so it must be `.usd`, `.usda`, `.usdc` or `.usdz`.
     */
    fileName?: string;

    /**
     * Additional assets (referenced layers, textures) made visible to USD's asset resolver,
     * keyed by the path used inside the USD layer. Unnecessary for self-contained `.usdz`.
     */
    additionalFiles?: { [path: string]: ArrayBufferView };

    /**
     * Resolve references that cannot be found by matching on file name. Defaults to true.
     * USD files exported from other tools frequently carry absolute paths from the machine
     * they were authored on, which can never resolve as written.
     */
    resolveByFileName?: boolean;

    /**
     * Called for each diagnostic emitted by OpenUSD.
     */
    onLog?: (message: IUSDLogMessage) => void;
}

/**
 * Result of a successful conversion.
 */
export interface IUSDConvertResult {
    /**
     * The GLB payload.
     */
    data: Uint8Array;
    /**
     * Duration of the native conversion, in milliseconds.
     */
    durationMs: number;
    /**
     * File names the asset referenced but that were never supplied. The conversion still
     * succeeds; this is the signal that content is missing from the output.
     */
    missingAssets: string[];
}

/** Maps the native log level enum onto its string form. */
const LogLevels: readonly USDLogLevel[] = ["info", "warning", "error"];

/** Working directory inside the Emscripten virtual filesystem. */
const ScratchDir = "/work";

/**
 * Shape of the Emscripten module produced by the usd-web-gltf native build.
 * @internal
 */
interface IUSDNativeModule {
    HEAPU8: Uint8Array;
    FS: {
        writeFile(path: string, data: Uint8Array): void;
        unlink(path: string): void;
        mkdir(path: string): void;
        analyzePath(path: string): { exists: boolean };
    };
    convert(inputPath: string, outputPath: string): IUSDNativeResult;
    setLogCallback(callback: (level: number, message: string) => void): void;
    getSupportedOutputFormats(): string;
    isGltfPluginAvailable(): boolean;
    getUsdVersion(): string;
    registerAssetDirectory(directory: string): void;
    clearAssetIndex(): void;
    setAssetFallbackEnabled(enabled: boolean): void;
    getUnresolvedAssets(): string;
    getResolverName(): string;
}

/**
 * Native conversion result. Owns wasm heap memory and must be explicitly deleted.
 * @internal
 */
interface IUSDNativeResult {
    ok(): boolean;
    error(): string;
    dataPtr(): number;
    dataSize(): number;
    durationMs(): number;
    delete(): void;
}

/** Factory signature exported by the Emscripten glue. */
type USDModuleFactory = (options?: Record<string, unknown>) => Promise<IUSDNativeModule>;

/**
 * Converts USD assets to glTF using OpenUSD and Adobe's usdGltf file format plugin,
 * compiled to WebAssembly.
 *
 * The conversion runs inside OpenUSD itself: the module links the glTF plugin statically,
 * so `UsdStage::Export` dispatches to it exactly as it would in a desktop USD installation.
 *
 * By default the configuration points to a copy of the converter on the Babylon.js CDN.
 * To update the configuration, use the following code:
 * ```javascript
 *     USDConverter.DefaultConfiguration = {
 *          wasmUrl: "<url to the Emscripten glue module>",
 *          wasmBinaryUrl: "<url to the WebAssembly binary>",
 *          dataUrl: "<url to the USD resource bundle>",
 *     };
 * ```
 *
 * To convert a USD asset, get the default USDConverter object and call convertToGlbAsync:
 * ```javascript
 *     const glb = await USDConverter.Default.convertToGlbAsync(data, { fileName: "model.usdz" });
 * ```
 *
 * The binary is roughly 12 MB uncompressed (about 2 MB brotli), so serving it with
 * compression matters.
 *
 * The shipped module is single-threaded and needs no special headers. A pthreads build
 * exists for throughput on large scenes; it requires the page to be cross-origin isolated
 * (`Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`) so `SharedArrayBuffer` is available.
 */
export class USDConverter implements IDisposable {
    /**
     * Default configuration for the USDConverter. Defaults to loading the converter from
     * the Babylon.js CDN.
     */
    public static DefaultConfiguration: IUSDConverterConfiguration = {
        wasmUrl: `${Tools._DefaultCdnUrl}/usd-web-gltf.js`,
        wasmBinaryUrl: `${Tools._DefaultCdnUrl}/usd-web-gltf.wasm`,
        dataUrl: `${Tools._DefaultCdnUrl}/usd-web-gltf.data`,
    };

    /**
     * Returns true if the converter's `DefaultConfiguration` is available.
     */
    public static get DefaultAvailable(): boolean {
        const config = USDConverter.DefaultConfiguration;
        return !!(config.jsModule || (config.wasmUrl && (config.wasmBinary || config.wasmBinaryUrl) && typeof WebAssembly === "object"));
    }

    private static _Default: Nullable<USDConverter> = null;

    /**
     * Default instance for the USDConverter.
     */
    public static get Default(): USDConverter {
        USDConverter._Default ??= new USDConverter();
        return USDConverter._Default;
    }

    /**
     * Reset the default USDConverter object to null, disposing the removed default instance.
     * @param skipDispose set to true to not dispose the removed default instance
     */
    public static ResetDefault(skipDispose?: boolean): void {
        if (USDConverter._Default) {
            if (!skipDispose) {
                USDConverter._Default.dispose();
            }
            USDConverter._Default = null;
        }
    }

    private _modulePromise?: Promise<IUSDNativeModule>;
    private readonly _configuration: IUSDConverterConfiguration;

    /** Diagnostics collected for the conversion currently in flight. */
    private _activeLog: Nullable<(message: IUSDLogMessage) => void> = null;

    /**
     * Conversions are serialised: the native module keeps global state (its virtual
     * filesystem and asset index) for the duration of a call.
     */
    private _queue: Promise<unknown> = Promise.resolve();

    /**
     * Creates a new USDConverter.
     * @param configuration The configuration for the USDConverter instance.
     */
    constructor(configuration: IUSDConverterConfiguration = USDConverter.DefaultConfiguration) {
        this._configuration = configuration;
    }

    /**
     * Returns a promise that resolves when the converter is ready. Call this manually to
     * pay the module instantiation cost ahead of the first conversion.
     * @returns a promise that resolves when ready
     */
    public async whenReadyAsync(): Promise<void> {
        await this._getModuleAsync();
    }

    /**
     * The OpenUSD version the module was built from, for example `"0.26.8"`.
     * @returns a promise that resolves with the version string
     */
    public async getUsdVersionAsync(): Promise<string> {
        const module = await this._getModuleAsync();
        return module.getUsdVersion();
    }

    /**
     * Converts a USD asset to a GLB buffer.
     * @param data The `.usd`/`.usda`/`.usdc`/`.usdz` payload
     * @param options Conversion options
     * @returns The GLB payload and conversion metadata
     */
    public async convertToGlbAsync(data: ArrayBuffer | ArrayBufferView, options: IUSDConvertOptions = {}): Promise<IUSDConvertResult> {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

        if (bytes.byteLength === 0) {
            throw new Error("USDConverter: the supplied USD payload is empty.");
        }

        // Serialise: the native module keeps global state across a conversion (its virtual
        // filesystem and asset index), so overlapping calls would corrupt each other.
        const previous = this._queue;
        const run = (async () => {
            try {
                await previous;
            } catch {
                // A previous conversion's failure was already delivered to its own caller
                // and must not prevent later conversions from running.
            }
            return await this._convertAsync(bytes, options);
        })();

        // Keep the chain alive regardless of this conversion's outcome.
        this._queue = (async () => {
            try {
                await run;
            } catch {
                // Delivered to this call's caller below.
            }
        })();

        return await run;
    }

    private async _convertAsync(bytes: Uint8Array, options: IUSDConvertOptions): Promise<IUSDConvertResult> {
        const module = await this._getModuleAsync();

        const fileName = options.fileName ?? "input.usdz";
        const inputPath = `${ScratchDir}/${SanitizeVirtualPath(fileName)}`;
        const outputPath = `${inputPath.slice(0, inputPath.lastIndexOf(".") + 1 || inputPath.length)}glb`;

        const written: string[] = [];
        this._activeLog = options.onLog ?? null;

        try {
            EnsureParentDirectories(module, inputPath);
            module.FS.writeFile(inputPath, bytes);
            written.push(inputPath);

            if (options.additionalFiles) {
                for (const rawPath of Object.keys(options.additionalFiles)) {
                    const payload = options.additionalFiles[rawPath];
                    const target = `${ScratchDir}/${SanitizeVirtualPath(rawPath)}`;
                    EnsureParentDirectories(module, target);
                    module.FS.writeFile(target, new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
                    written.push(target);
                }
            }

            // Index what was just written so references that fail normal resolution can fall
            // back to a file-name match. Cleared first so a previous conversion's files can
            // never satisfy this one's references.
            module.clearAssetIndex();
            module.setAssetFallbackEnabled(options.resolveByFileName ?? true);
            module.registerAssetDirectory(ScratchDir);

            const native = module.convert(inputPath, outputPath);
            written.push(outputPath);

            try {
                if (!native.ok()) {
                    throw new Error(`USDConverter: ${native.error()}`);
                }

                // Copy out of the wasm heap before the native buffer is freed; memory growth
                // can also detach the previous HEAPU8 view.
                const ptr = native.dataPtr();
                const size = native.dataSize();
                const glb = module.HEAPU8.slice(ptr, ptr + size);

                return {
                    data: glb,
                    durationMs: native.durationMs(),
                    missingAssets: module
                        .getUnresolvedAssets()
                        .split(",")
                        .filter((name) => name.length > 0),
                };
            } finally {
                native.delete();
            }
        } finally {
            this._activeLog = null;
            for (const path of written) {
                try {
                    module.FS.unlink(path);
                } catch {
                    // Already gone, or never created because the export failed.
                }
            }
        }
    }

    private async _getModuleAsync(): Promise<IUSDNativeModule> {
        this._modulePromise ??= this._createModuleAsync();
        return await this._modulePromise;
    }

    private async _createModuleAsync(): Promise<IUSDNativeModule> {
        const config = this._configuration;

        if (typeof WebAssembly !== "object") {
            throw new Error("USDConverter: WebAssembly is not supported in this context.");
        }
        if (!config.jsModule && !config.wasmUrl) {
            throw new Error("USDConverter: no wasmUrl or jsModule configured.");
        }
        // The resource bundle carries OpenUSD's schemas and plugInfo.json files. Emscripten
        // resolves it against the document rather than the glue script, so its location is
        // supplied explicitly through locateFile below.
        const wasmBinaryUrl = config.wasmBinaryUrl ? Tools.GetBabylonScriptURL(config.wasmBinaryUrl, true) : undefined;
        const dataUrl = config.dataUrl ? Tools.GetBabylonScriptURL(config.dataUrl, true) : undefined;

        let factory = config.jsModule as USDModuleFactory | undefined;
        if (!factory) {
            const glueUrl = Tools.GetBabylonScriptURL(config.wasmUrl!, true);
            // The glue is an ES module emitted by Emscripten with -sEXPORT_ES6.
            const glue = (await import(/* webpackIgnore: true */ /* @vite-ignore */ glueUrl)) as { default: USDModuleFactory };
            factory = glue.default;
        }

        if (typeof factory !== "function") {
            throw new Error("USDConverter: the configured module did not provide an Emscripten factory.");
        }

        const wasmBinary = config.wasmBinary ?? (wasmBinaryUrl ? ((await Tools.LoadFileAsync(wasmBinaryUrl)) as ArrayBuffer) : undefined);

        let module: IUSDNativeModule;
        try {
            module = await factory({
                wasmBinary,
                noExitRuntime: true,
                locateFile: (path: string, scriptDirectory: string) => {
                    if (path.endsWith(".wasm") && wasmBinaryUrl) {
                        return wasmBinaryUrl;
                    }
                    if (path.endsWith(".data") && dataUrl) {
                        return dataUrl;
                    }
                    return scriptDirectory + path;
                },
            });
        } catch (error) {
            // A threaded build cannot start without SharedArrayBuffer, and the underlying
            // failure is usually opaque, so the likely cause is called out here.
            if (typeof SharedArrayBuffer === "undefined") {
                throw new Error(
                    "USDConverter: the module failed to start and SharedArrayBuffer is unavailable. " +
                        "The threaded build requires the page to be cross-origin isolated: serve it with " +
                        '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp".',
                    { cause: error }
                );
            }
            throw error;
        }

        if (!module.isGltfPluginAvailable()) {
            throw new Error("USDConverter: the glTF file format plugin did not register. The WebAssembly build is incomplete.");
        }

        module.setLogCallback((level: number, message: string) => {
            this._activeLog?.({ level: LogLevels[level] ?? "info", message });
        });

        if (!module.FS.analyzePath(ScratchDir).exists) {
            module.FS.mkdir(ScratchDir);
        }

        return module;
    }

    /**
     * Stop all async operations and release resources.
     */
    public dispose(): void {
        // The WebAssembly instance is reclaimed by the garbage collector once no references
        // remain; there is no explicit teardown entry point in the module.
        delete this._modulePromise;
    }
}

/**
 * Sanitises a caller-supplied virtual path so it cannot escape the scratch directory.
 * @param path the path to sanitise
 * @returns a relative path with no traversal segments
 * @internal
 */
function SanitizeVirtualPath(path: string): string {
    const segments: string[] = [];
    for (const segment of path.replace(/\\/g, "/").split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    if (segments.length === 0) {
        throw new Error(`USDConverter: "${path}" is not a usable file path.`);
    }
    return segments.join("/");
}

/**
 * Creates any missing parent directories for a virtual file path.
 * @param module the Emscripten module
 * @param path the file path whose parents should exist
 * @internal
 */
function EnsureParentDirectories(module: IUSDNativeModule, path: string): void {
    const segments = path.split("/").slice(1, -1);
    let current = "";
    for (const segment of segments) {
        current += `/${segment}`;
        if (!module.FS.analyzePath(current).exists) {
            module.FS.mkdir(current);
        }
    }
}
