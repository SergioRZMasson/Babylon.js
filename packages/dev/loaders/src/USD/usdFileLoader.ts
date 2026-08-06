/**
 * Re-exports the pure implementation and applies the runtime registration side effect.
 * Import "./usdFileLoader.pure" for tree-shakeable, side-effect-free usage.
 */
export * from "./usdFileLoader.types";
export * from "./usdFileLoader.pure";
export * from "./usdConverter";
export * from "./usdLoadingOptions";

// The converted GLB is loaded by the glTF loader, so it has to be registered too.
import "../glTF/2.0/glTFLoader";

import { RegisterUSDFileLoader } from "./usdFileLoader.pure";
RegisterUSDFileLoader();
