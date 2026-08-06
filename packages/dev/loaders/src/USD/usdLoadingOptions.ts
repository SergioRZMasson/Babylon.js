import { type IUSDConverterConfiguration, type IUSDLogMessage } from "./usdConverter";

/**
 * Options for loading USD files.
 */
export type USDLoadingOptions = {
    /**
     * Configuration for the WebAssembly converter. When omitted the shared default
     * converter is used, so the module is instantiated once and reused across loads.
     *
     * Supply this to point at a self-hosted copy of the converter, or to inject an
     * already-loaded module.
     */
    converterConfiguration: IUSDConverterConfiguration;

    /**
     * Additional assets (referenced layers, textures) made visible to USD's asset
     * resolver, keyed by the path used inside the USD layer.
     *
     * Multi-file USD scenes reference siblings by relative path, and those references only
     * resolve if the files come along. Self-contained `.usdz` archives need nothing here.
     */
    additionalFiles: { [path: string]: ArrayBufferView };

    /**
     * Supply sibling files from `FilesInputStore` when loading through `FilesInput`
     * (drag-and-drop, file pickers). Defaults to true.
     *
     * A USD scene dropped as a folder arrives with its referenced layers and textures
     * already registered there, so this makes those references resolve without the
     * application having to plumb them through `additionalFiles`. Files supplied
     * explicitly via `additionalFiles` take precedence.
     */
    useFilesInputStore: boolean;

    /**
     * Resolve references that cannot be found by matching on file name. Defaults to true.
     *
     * USD files exported from DCC tools frequently carry absolute paths from the machine
     * they were authored on, which can never resolve as written. When enabled, any supplied
     * file with a matching name is used instead. Set to false to require exact resolution.
     */
    resolveByFileName: boolean;

    /**
     * Called for each diagnostic emitted by OpenUSD while converting.
     */
    onLog: (message: IUSDLogMessage) => void;

    /**
     * Called with the file names an asset referenced but that were never supplied.
     *
     * The load still succeeds; this is the signal that content is missing from the result.
     */
    onMissingAssets: (missingAssets: string[]) => void;
};
