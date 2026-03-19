# KHR_Interactivity → Babylon.js FlowGraph Integration Guide

> **Audience**: New developers working on the `KHR_interactivity` glTF loader extension in Babylon.js.
> **Location**: `packages/dev/loaders/src/glTF/2.0/Extensions/KHR_interactivity/`

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [The KHR_Interactivity Spec in a Nutshell](#2-the-khr_interactivity-spec-in-a-nutshell)
3. [Babylon.js FlowGraph System](#3-babylonjs-flowgraph-system)
4. [File-by-File Walkthrough](#4-file-by-file-walkthrough)
5. [The Parsing Pipeline (End-to-End)](#5-the-parsing-pipeline-end-to-end)
6. [The Declaration Mapper — Deep Dive](#6-the-declaration-mapper--deep-dive)
7. [Complex Node Patterns](#7-complex-node-patterns)
8. [Object Model & JSON Pointer System](#8-object-model--json-pointer-system)
9. [Testing](#9-testing)
10. [Known Issues & Observations](#10-known-issues--observations)
11. [Glossary](#11-glossary)

---

## 1. High-Level Overview

This code reads the `KHR_interactivity` extension from a glTF/GLB file and transforms it into a Babylon.js **FlowGraph** — a visual-scripting-style runtime behavior graph. The result is an interactive 3D scene where logic (events, math, animations, property access) is encoded directly in the asset file.

### The Pipeline at a Glance

```
┌─────────────────────────────────┐
│  glTF/GLB File                  │
│  extensions.KHR_interactivity   │
│  ┌───────────────────────────┐  │
│  │ graphs[0]                 │  │
│  │  ├─ types[]               │  │
│  │  ├─ declarations[]        │  │
│  │  ├─ variables[]           │  │
│  │  ├─ events[]              │  │
│  │  └─ nodes[]               │  │
│  └───────────────────────────┘  │
└───────────┬─────────────────────┘
            │  (1) glTF Loader calls onReady()
            ▼
┌─────────────────────────────────┐
│  InteractivityGraphToFlowGraph  │
│  Parser                         │
│  ┌───────────────────────────┐  │
│  │ _parseTypes()             │  │
│  │ _parseDeclarations()      │  │
│  │ _parseVariables()         │  │
│  │ _parseEvents()            │  │
│  │ _parseNodes()             │  │
│  │ _parseNodeConnections()   │  │ ← called during serializeToFlowGraph()
│  └───────────────────────────┘  │
└───────────┬─────────────────────┘
            │  (2) serializeToFlowGraph()
            ▼
┌─────────────────────────────────┐
│  ISerializedFlowGraph           │
│  (intermediate JSON format)     │
│  ├─ allBlocks[]                 │
│  └─ executionContexts[]         │
└───────────┬─────────────────────┘
            │  (3) ParseFlowGraphAsync()
            ▼
┌─────────────────────────────────┐
│  FlowGraph Runtime              │
│  ├─ FlowGraphCoordinator        │
│  │   └─ FlowGraph               │
│  │       ├─ Event blocks         │
│  │       ├─ Execution blocks     │
│  │       ├─ Data blocks          │
│  │       └─ FlowGraphContext     │
│  │           ├─ userVariables    │
│  │           └─ connectionValues │
│  └───────────────────────────────┘
            │  (4) coordinator.start()
            ▼
       Scene is interactive!
```

---

## 2. The KHR_Interactivity Spec in a Nutshell

The spec ([full text](https://github.com/KhronosGroup/glTF/blob/interactivity/extensions/2.0/Khronos/KHR_interactivity/Specification.adoc)) defines a behavior graph as a JSON structure with five arrays:

### 2.1 Types
A palette of data types. Each entry has a `signature` string:

| Signature | Description | Element Count |
|-----------|-------------|--------------|
| `bool` | boolean | 1 |
| `int` | 32-bit signed integer | 1 |
| `float` | double-precision float | 1 |
| `float2` | 2D vector | 2 |
| `float3` | 3D vector | 3 |
| `float4` | 4D vector / quaternion | 4 |
| `float2x2` | 2×2 matrix | 4 |
| `float3x3` | 3×3 matrix | 9 |
| `float4x4` | 4×4 matrix | 16 |

Default values: `bool` → `false`, `int` → `0`, all float types → `NaN`.

### 2.2 Declarations
Maps indices to **operation strings** like `"math/add"`, `"flow/branch"`, `"event/onStart"`. Nodes reference declarations by index. Extension-defined operations add an `extension` field (e.g., `{ op: "flow/log", extension: "BABYLON" }`).

### 2.3 Variables
Global mutable state. Each variable references a type index and optionally provides an initial `value` array.

### 2.4 Events
Custom events for inter-graph communication. Each event can have typed value sockets and an optional string `id` for external identification.

### 2.5 Nodes
The actual graph nodes. Each node has:
- **`declaration`**: Index into declarations array (identifies the operation)
- **`values`**: Input data sockets — either inline constants (`{ value: [1], type: 0 }`) or references to another node's output (`{ node: 2, socket: "value" }`)
- **`flows`**: Output execution flow connections (`{ node: 3, socket: "in" }`)
- **`configuration`**: Static configuration values

### 2.6 Four Socket Types
1. **Input value sockets** — data consumed by a node
2. **Output value sockets** — data produced by a node
3. **Input flow sockets** — entry points for execution (like "methods")
4. **Output flow sockets** — exit points that advance execution (like "function pointers")

### 2.7 Node Ordering Constraint
Value references must point to nodes with **lower** indices; flow connections must point to nodes with **higher** indices. This prevents cycles statically.

---

## 3. Babylon.js FlowGraph System

The FlowGraph system ([docs](https://doc.babylonjs.com/features/featuresDeepDive/flowGraph/flowGraphBasicConcepts)) is Babylon.js's general-purpose visual scripting runtime. The KHR_interactivity loader converts glTF graphs into this system.

### Key Concepts

| Concept | Description |
|---------|-------------|
| **FlowGraphCoordinator** | Top-level manager bound to a Scene. Manages multiple FlowGraphs and handles cross-graph custom event dispatch. |
| **FlowGraph** | A collection of connected blocks. Organized by event type (SceneReady, Tick, PointerDown, etc.). |
| **FlowGraphBlock** | A single operation node. **Blocks are stateless** — all state lives in the context. Three subtypes: Event blocks, Execution blocks, Data blocks. |
| **FlowGraphContext** | Where state lives. Holds user variables, execution variables (per-block internal state), and cached connection values. |
| **Data Connections** | Typed data ports that pass values between blocks (numbers, vectors, matrices, etc.). |
| **Signal Connections** | Execution flow ports. An output signal triggers an input signal on another block. |

### Concept Mapping: KHR_interactivity → FlowGraph

| KHR_interactivity | FlowGraph |
|-------------------|-----------|
| Graph | `FlowGraph` instance |
| Node | `FlowGraphBlock` instance |
| Declaration | Block class name (e.g., `FlowGraphAddBlock`) |
| Type signature | `FlowGraphTypes` enum value |
| Variable | `context._userVariables[name]` |
| Event | `FlowGraphCoordinator._customEventsMap` |
| Output flow socket | `block.signalOutputs` |
| Input flow socket | `block.signalInputs` |
| Input value socket (inline) | `context._connectionValues[connectionId]` |
| Input value socket (reference) | `block.dataInputs` connected to another block's `dataOutputs` |
| Configuration | `block.config` constructor parameter |

---

## 4. File-by-File Walkthrough

### `KHR_interactivity.ts` — Extension Entry Point
**Location**: `packages/dev/loaders/src/glTF/2.0/Extensions/KHR_interactivity.ts`

The glTF loader extension class. Implements `IGLTFLoaderExtension`.

**Key behaviors:**
- **Constructor**: Disables auto-start of animations (`_loader._skipStartAnimationStep = true`), sets up the path converter for JSON pointer resolution, and registers interactivity-specific object model accessors (camera position/rotation, animation state properties).
- **`onReady()`**: The main entry point. Creates a `FlowGraphCoordinator`, parses each graph from the extension JSON via `InteractivityGraphToFlowGraphParser`, then calls `ParseFlowGraphAsync` to instantiate runtime blocks, and finally starts the coordinator.
- **Block factory registration**: Registers the custom `FlowGraphGLTFDataProvider` block so the block factory can find it.
- **Object model additions**: Adds read-only accessors for `/extensions/KHR_interactivity/?/activeCamera/position`, `/extensions/KHR_interactivity/?/activeCamera/rotation`, and animation state properties (`isPlaying`, `minTime`, `maxTime`, `playhead`, `virtualPlayhead`).

### `interactivityGraphParser.ts` — The Core Parser
**Location**: `packages/dev/loaders/src/glTF/2.0/Extensions/KHR_interactivity/interactivityGraphParser.ts`

Transforms a `IKHRInteractivity_Graph` into an `ISerializedFlowGraph`.

**Constructor** runs five parse phases in order:
1. `_parseTypes()` — Converts glTF type signatures to `{ length, flowGraphType, elementType }` tuples
2. `_parseDeclarations()` — Looks up each declaration's operation string in the declaration mapper to get an `IGLTFToFlowGraphMapping`
3. `_parseVariables()` — Parses global variables with default values and type info
4. `_parseEvents()` — Converts custom events to `InteractivityEvent` objects with event data definitions
5. `_parseNodes()` — Creates `ISerializedFlowGraphBlock[]` for each node, applying configuration from mappings

**`serializeToFlowGraph()`** — Called after construction. Runs `_parseNodeConnections()` (the most complex method) which wires up all flow and value connections between blocks, then assembles the final `ISerializedFlowGraph` output.

**`_parseNodeConnections()`** is where the real complexity lives. For each node it:
- Resolves flow connections (signal outputs → signal inputs) using the declaration mapper to translate socket names
- Resolves value connections: either stores inline values in `context._connectionValues`, or wires data output → data input connections
- Handles inter-block connectors for multi-block nodes
- Runs `extraProcessor` callbacks for complex node types

**Key design insight**: The parser produces a **serialized** intermediate form (`ISerializedFlowGraph`), not runtime objects. The actual FlowGraph runtime objects are created later by `ParseFlowGraphAsync` in the core FlowGraph module. This decouples the glTF-specific parsing from the FlowGraph runtime.

### `declarationMapper.ts` — The Mapping Dictionary
**Location**: `packages/dev/loaders/src/glTF/2.0/Extensions/KHR_interactivity/declarationMapper.ts`

A ~1600-line file that maps every KHR_interactivity operation string to its Babylon.js FlowGraph equivalent. This is the **Rosetta Stone** of the integration.

Two mapping dictionaries:
- **`gltfToFlowGraphMapping`** — Maps base spec operations (e.g., `"math/add"` → `FlowGraphBlockNames.Add`)
- **`gltfExtensionsToFlowGraphMapping`** — Maps extension-defined operations (e.g., `"flow/log"` in the `"BABYLON"` extension)

Each mapping (`IGLTFToFlowGraphMapping`) defines:
- **`blocks`**: Which FlowGraph block class(es) to instantiate
- **`inputs`**: How glTF input socket names map to FlowGraph connection names
- **`outputs`**: How glTF output socket names map to FlowGraph connection names
- **`configuration`**: How glTF configuration values map to block constructor config
- **`interBlockConnectors`**: How to wire multiple blocks together (for multi-block nodes)
- **`validation`**: Optional validation logic
- **`extraProcessor`**: Optional post-processing callback for complex transformations

**`addNewInteractivityFlowGraphMapping()`** — Public API for other extensions to register their own node types with the interactivity system.

### `flowGraphGLTFDataProvider.ts` — glTF Data Bridge Block
**Location**: `packages/dev/loaders/src/glTF/2.0/Extensions/KHR_interactivity/flowGraphGLTFDataProvider.ts`

A custom FlowGraph block that provides access to glTF-loaded Babylon objects. It outputs:
- **`animationGroups`**: Array of `AnimationGroup` objects (from `gltf.animations`)
- **`nodes`**: Array of `TransformNode` objects (from `gltf.nodes`)

Used by `animation/start`, `animation/stop`, and `animation/stopAt` nodes to look up animation groups by index.

### `index.ts` — Barrel Export
Re-exports all public symbols from the three main files.

---

## 5. The Parsing Pipeline (End-to-End)

Here's a detailed walkthrough of what happens when a glTF with KHR_interactivity is loaded:

### Step 1: Extension Registration
```typescript
// KHR_interactivity.ts (bottom of file)
registerGLTFExtension("KHR_interactivity", true, (loader) => new KHR_interactivity(loader));
```
The extension is registered with the glTF loader system at module load time.

### Step 2: Constructor — Setup
When the loader detects `KHR_interactivity` in the glTF's `extensionsUsed`, it instantiates the extension:
```typescript
constructor(private _loader: GLTFLoader) {
    this.enabled = this._loader.isExtensionUsed("KHR_interactivity");
    this._pathConverter = GetPathToObjectConverter(this._loader.gltf);
    _loader._skipStartAnimationStep = true;  // Interactivity controls animations
    _AddInteractivityObjectModel(scene);     // Register camera/animation accessors
}
```

### Step 3: `onReady()` — Main Entry Point
After all glTF content is loaded:
```typescript
async onReady() {
    const interactivityDefinition = this._loader.gltf.extensions?.KHR_interactivity;
    const coordinator = new FlowGraphCoordinator({ scene });
    coordinator.dispatchEventsSynchronously = false;  // glTF spec requires async dispatch
    
    const graphs = interactivityDefinition.graphs.map((graph) => {
        const parser = new InteractivityGraphToFlowGraphParser(graph, gltf, targetFps);
        return parser.serializeToFlowGraph();  // → ISerializedFlowGraph
    });
    
    await Promise.all(graphs.map((graph) => ParseFlowGraphAsync(graph, { coordinator, pathConverter })));
    coordinator.start();
}
```

### Step 4: Parser Constructor — Five Parse Phases

Given this glTF input:
```json
{
  "types": [{ "signature": "float" }, { "signature": "float3" }],
  "declarations": [{ "op": "event/onStart" }, { "op": "math/add" }],
  "variables": [{ "type": 0, "value": [42.0] }],
  "events": [{ "id": "myEvent" }],
  "nodes": [
    { "declaration": 0, "flows": { "out": { "node": 1 } } },
    { "declaration": 1, "values": { "a": { "value": [1], "type": 0 }, "b": { "node": 0, "socket": "value" } } }
  ]
}
```

**Phase 1 — `_parseTypes()`**: Converts each type signature to a Babylon type:
```
"float" → { length: 1, flowGraphType: FlowGraphTypes.Number, elementType: "number" }
"float3" → { length: 3, flowGraphType: FlowGraphTypes.Vector3, elementType: "number" }
```

**Phase 2 — `_parseDeclarations()`**: Looks up each `op` in the declaration mapper:
```
"event/onStart" → { blocks: [SceneReadyEvent], outputs: { flows: { out: { name: "done" } } } }
"math/add"      → { blocks: [Add], inputs: { values: { a: { name: "a" }, b: { name: "b" } } }, ... }
```

**Phase 3 — `_parseVariables()`**: Parses variables with their default values:
```
{ type: 0, value: [42.0] } → { type: FlowGraphTypes.Number, value: [42.0] }
```

**Phase 4 — `_parseEvents()`**: Converts events to internal format:
```
{ id: "myEvent" } → { eventId: "myEvent" }
```

**Phase 5 — `_parseNodes()`**: Creates serialized block objects for each node. For each node:
1. Look up the declaration mapping
2. Run validation if defined
3. Create empty block(s) via `_getEmptyBlock()`
4. Apply configuration via `_parseNodeConfiguration()`

### Step 5: `serializeToFlowGraph()` — Wiring Connections

After the constructor, `serializeToFlowGraph()` is called. This creates a context and calls `_parseNodeConnections()`, which:

1. **Wires flow connections**: For each node's `flows` object, creates signal output/input connections and links them by unique ID
2. **Wires value connections**: For each node's `values` object:
   - If it's an **inline value** (`value` property exists): parses the value and stores it in `context._connectionValues[socketId]`
   - If it's a **node reference** (`node` property exists): creates data output/input connections and links them
3. **Inter-block connectors**: For multi-block nodes, wires the internal connections between blocks
4. **Extra processors**: Runs any `extraProcessor` callbacks for post-processing

### Step 6: `ParseFlowGraphAsync()` — Runtime Instantiation

The core FlowGraph parser takes the serialized format and:
1. Loads all block classes asynchronously via the block factory (dynamic imports)
2. Creates block instances with parsed configurations
3. Wires runtime connections by matching unique IDs
4. Creates execution contexts with variables and connection values
5. Registers event blocks with the graph

### Step 7: `coordinator.start()` — Go Live

The coordinator starts all graphs, which activates event listeners. When scene events fire (ready, tick, pointer, etc.), the corresponding event blocks trigger and execution flows through the graph.

---

## 6. The Declaration Mapper — Deep Dive

### Simple Mappings via `getSimpleInputMapping()`

Most math operations use a helper function:
```typescript
function getSimpleInputMapping(type: FlowGraphBlockNames, inputs: string[] = ["a"], inferType?: boolean) {
    return {
        blocks: [type],
        inputs: { values: { a: { name: "a" }, b: { name: "b" }, ... } },
        outputs: { values: { value: { name: "value" } } },
        // optional: extraProcessor for type inference, validation
    };
}
```
This creates a 1:1 mapping: one glTF node → one FlowGraph block.

### Multi-Block Mappings

Some glTF nodes require **multiple FlowGraph blocks**. For example:

**`animation/start`** requires three blocks:
```typescript
blocks: [FlowGraphBlockNames.PlayAnimation, FlowGraphBlockNames.ArrayIndex, "KHR_interactivity/FlowGraphGLTFDataProvider"]
```
- `FlowGraphGLTFDataProvider` provides the array of animation groups from the glTF
- `ArrayIndex` looks up a specific animation group by index
- `PlayAnimation` plays the animation

These are wired together via `interBlockConnectors`:
```typescript
interBlockConnectors: [
    { input: "animationGroup", output: "value", inputBlockIndex: 0, outputBlockIndex: 1, isVariable: true },
    { input: "array", output: "animationGroups", inputBlockIndex: 1, outputBlockIndex: 2, isVariable: true },
]
```

**`pointer/get`** requires two blocks:
```typescript
blocks: [FlowGraphBlockNames.GetProperty, FlowGraphBlockNames.JsonPointerParser]
```
- `JsonPointerParser` resolves the JSON pointer string to an object + property name
- `GetProperty` reads the property value

**`pointer/interpolate`** requires four blocks:
```typescript
blocks: [FlowGraphBlockNames.ValueInterpolation, FlowGraphBlockNames.JsonPointerParser,
         FlowGraphBlockNames.PlayAnimation, FlowGraphBlockNames.BezierCurveEasing]
```

### The `toBlock` Property

When a mapping has multiple blocks, socket mappings use `toBlock` to specify which block a connection belongs to:
```typescript
inputs: {
    values: {
        p1: { name: "controlPoint1", toBlock: FlowGraphBlockNames.BezierCurveEasing },
        p2: { name: "controlPoint2", toBlock: FlowGraphBlockNames.BezierCurveEasing },
    },
    flows: {
        in: { name: "in", toBlock: FlowGraphBlockNames.PlayAnimation },
    },
},
```
If `toBlock` is not specified, the connection defaults to the **first block** in the `blocks` array.

### Array Mappings (Dynamic Socket Names)

Some nodes have variable socket names. These use a pattern with bracket notation:
```typescript
inputs: {
    flows: {
        "[segment]": { name: "in_$1" },  // $1 is replaced with the actual socket name
    },
},
```
When the parser encounters a socket name that doesn't match any explicit key, it looks for a key wrapped in `[]` and uses it as a template, replacing `$1` with the actual socket name.

### The `extraProcessor` Callback

The most powerful customization point. Called during `_parseNodeConnections()`, it can:
- Modify block configuration (e.g., setting `roundHalfAwayFromZero` for `math/round`)
- Add custom config values (e.g., setting `eventId` for event blocks)
- Infer types from input connections
- Transform data (e.g., converting seconds to frames for animation times)
- Generate additional blocks

### The `validation` Callback

Called during `_parseNodes()` before block creation. Returns `{ valid: boolean, error?: string }`. Can also **modify** the node (e.g., removing duplicate switch cases, fixing missing configuration).

### Fallback for Unknown Operations

When `getMappingForDeclaration()` can't find a mapping, it creates a **no-op mapping** with `blocks: []` but preserves input/output socket names from the declaration. This means unknown operations are silently skipped at runtime.

---

## 7. Complex Node Patterns

### Event Send/Receive

Events use `extraProcessor` to inject event metadata:
```typescript
"event/send": {
    blocks: [FlowGraphBlockNames.SendCustomEvent],
    extraProcessor(gltfBlock, declaration, _mapping, parser, serializedObjects) {
        const eventId = gltfBlock.configuration["event"].value?.[0];  // Index into events array
        const event = parser.arrays.events[eventId];
        serializedObjects[0].config.eventId = event.eventId;
        serializedObjects[0].config.eventData = event.eventData;
        return serializedObjects;
    },
}
```

### Variable Interpolation

`variable/interpolate` is one of the most complex mappings, requiring **five blocks**:
1. `ValueInterpolation` — generates the animation keyframes
2. `Context` — provides the execution context's user variables as the animation target
3. `PlayAnimation` — plays the generated animation
4. `BezierCurveEasing` — applies easing
5. `GetVariable` — reads the current variable value as the start value

### Polymorphic Operations

Operations like `math/mul`, `math/not`, `math/and`, `math/or`, `math/xor` work on different types (float, int, bool). The `extraProcessor` infers the type from input connections:
```typescript
extraProcessor(_gltfBlock, _declaration, _mapping, _parser, serializedObjects, context) {
    const socketIn = serializedObjects[0].dataInputs[0];
    serializedObjects[0].config.valueType = 
        context._connectionValues[socketIn.uniqueId]?.type ?? FlowGraphTypes.Integer;
    return serializedObjects;
}
```

### Coordinate System Handling

glTF uses a **right-handed** coordinate system. The parser sets `rightHanded: true` in the serialized output. For camera accessors in `KHR_interactivity.ts`, explicit coordinate transforms are applied when the scene uses left-handed coordinates.

---

## 8. Object Model & JSON Pointer System

### How JSON Pointers Work

KHR_interactivity uses [JSON Pointers (RFC 6901)](https://datatracker.ietf.org/doc/html/rfc6901) to access glTF scene properties. For example:
- `/nodes/0/translation` → position of node 0
- `/materials/1/pbrMetallicRoughness/baseColorFactor` → base color of material 1
- `/animations/0/extensions/KHR_interactivity/isPlaying` → whether animation 0 is playing

### Template Parameters

Pointers can contain template parameters: `/nodes/{myIndex}/translation`. The `{myIndex}` segment becomes an **input value socket** on the node, resolved at runtime with an integer value.

### The Object Model Mapping

**File**: `packages/dev/loaders/src/glTF/2.0/Extensions/objectModelMapping.ts`

A ~56KB file that maps every valid glTF pointer path to a Babylon.js `IObjectAccessor`:
```typescript
interface IObjectAccessor {
    type: string;                         // "Vector3", "Color3", "Matrix", etc.
    get: (target: GLTFObject) => value;   // Read from Babylon object
    set?: (value, target) => void;        // Write to Babylon object
    getTarget: (target) => babylonObject; // Get the Babylon object reference
    getPropertyName?: [(target) => string]; // Property name for animation
}
```

### The `FlowGraphJsonPointerParserBlock`

**File**: `packages/dev/core/src/FlowGraph/Blocks/Data/Transformers/flowGraphJsonPointerParserBlock.ts`

This block resolves a JSON pointer at runtime. It outputs:
- **`object`** — the Babylon.js object being accessed
- **`propertyName`** — the property name on that object
- **`setterFunction`** / **`getterFunction`** — functions for reading/writing the property
- **`generateAnimationsFunction`** — for creating animations targeting this property

The `pointer/get` and `pointer/set` nodes use this block to bridge the glTF pointer world with Babylon.js runtime objects.

### Interactivity-Specific Object Model Additions

`KHR_interactivity.ts` registers additional object model paths:

| Path | Description | Type |
|------|-------------|------|
| `/extensions/KHR_interactivity/?/activeCamera/position` | Active camera world position | Vector3 |
| `/extensions/KHR_interactivity/?/activeCamera/rotation` | Active camera world rotation | Quaternion |
| `/animations/{}/extensions/KHR_interactivity/isPlaying` | Animation playing state | boolean |
| `/animations/{}/extensions/KHR_interactivity/minTime` | Animation start time (seconds) | number |
| `/animations/{}/extensions/KHR_interactivity/maxTime` | Animation end time (seconds) | number |
| `/animations/{}/extensions/KHR_interactivity/playhead` | Current playback position | number |
| `/animations/{}/extensions/KHR_interactivity/virtualPlayhead` | Virtual playback position | number |

---

## 9. Testing

**Test location**: `packages/dev/loaders/test/unit/Interactivity/`

| Test File | What It Tests |
|-----------|---------------|
| `babylon.interactivity.test.ts` | Main integration: logger, math chains, integer math, world pointers, DoN |
| `testData.ts` | Test graph definitions (reusable glTF-like JSON structures) |
| `animation nodes.test.ts` | Animation start/stop/stopAt blocks |
| `event nodes.test.ts` | Event send/receive with data |
| `flow nodes.test.ts` | Branch, sequence, for loop, switch, multiGate, waitAll, throttle, delay |
| `interactivity.math nodes.test.ts` | Math operations: arithmetic, trig, vectors, matrices, quaternions, bitwise |
| `type nodes.test.ts` | Type conversion: bool↔int↔float |
| `objectModel.test.ts` | Object accessor resolution |

### Test Pattern
```typescript
it("should compute correctly", async () => {
    const parser = new InteractivityGraphToFlowGraphParser(graphDefinition, mockGltf);
    const json = parser.serializeToFlowGraph();
    const coordinator = new FlowGraphCoordinator({ scene });
    await ParseFlowGraphAsync(json, { coordinator, pathConverter });
    coordinator.start();
    expect(log).toHaveBeenCalledWith(expectedResult);
});
```

---

## 10. Known Issues & Observations

### 🐛 Bug: `Array.fill()` on Empty Array for Default Values

**File**: `interactivityGraphParser.ts`, lines 143-149

```typescript
case FlowGraphTypes.Vector4:
case FlowGraphTypes.Matrix2D:
case FlowGraphTypes.Quaternion:
    value.fill(NaN, 0, 4);  // ← BUG: fill() doesn't grow an empty array
    break;
case FlowGraphTypes.Matrix:
    value.fill(NaN, 0, 16);  // ← Same bug
    break;
case FlowGraphTypes.Matrix3D:
    value.fill(NaN, 0, 9);   // ← Same bug
    break;
```

`Array.prototype.fill()` only fills **existing** indices — it does not grow the array. When `value` is `[]` (length 0), `value.fill(NaN, 0, 4)` returns `[]`, not `[NaN, NaN, NaN, NaN]`. Compare with the correct implementations for `Vector2` and `Vector3` which use `value.push(NaN, NaN)` and `value.push(NaN, NaN, NaN)`.

**Impact**: Variables of type `float4`, `float4x4`, `float2x2`, `float3x3`, or quaternion that have no initial value will get an empty array instead of NaN-filled defaults. This violates the spec's default value requirements.

**Fix**: Replace `value.fill(NaN, 0, N)` with `value.push(...Array(N).fill(NaN))` or similar.

### ⚠️ Incomplete String-to-Number Conversion

**File**: `interactivityGraphParser.ts`, lines 158-159

```typescript
if (type.elementType === "number" && typeof value[0] === "string") {
    value[0] = parseFloat(value[0]);
}
```

Only converts `value[0]` from string to number. Multi-component types (float3, float4, matrices) could have string values like `"NaN"` or `"Infinity"` in **any** position, not just the first. All elements should be checked and converted.

### ⚠️ Missing Duplicate Type Validation

**File**: `interactivityGraphParser.ts`, lines 39-41

```typescript
/**
 * Note - the graph should be rejected if the same type is defined twice.
 * We currently don't validate that.
 */
```

The spec requires that non-custom type signatures appear at most once. This validation is acknowledged as missing.

### ⚠️ `typeToTypeMapping` — Defined but Never Used

**File**: `declarationMapper.ts`, line 105

The `IGLTFToFlowGraphMapping` interface defines `typeToTypeMapping` but no code in the codebase references it. This is either dead code or an incomplete feature.

### ⚠️ `_animationTargetFps` — Inconsistent Naming and Visibility

**File**: `interactivityGraphParser.ts`, line 52

```typescript
public _animationTargetFps: number = 60
```

The field is `public` but prefixed with underscore (suggesting it should be private). It's accessed by `extraProcessor` callbacks in `declarationMapper.ts` (e.g., for `animation/start`'s time conversion). This is a naming convention inconsistency.

### ⚠️ Hardcoded FPS in Object Model Accessors

**File**: `KHR_interactivity.ts`, lines 143, 151, 162, 172

```typescript
return (animation._babylonAnimationGroup?.from ?? 0) / 60;  // hardcoded 60 fps
```

Animation time properties (`minTime`, `maxTime`, `playhead`, `virtualPlayhead`) use a hardcoded `/ 60` divisor instead of the configurable `targetFps` parameter used by the parser. If the loader's `targetFps` is changed, these accessors would return wrong values.

### ⚠️ `virtualPlayhead` — Unimplemented Distinction

**File**: `KHR_interactivity.ts`, line 169

```typescript
//virtualPlayhead - TODO, do we support this property in our animations?
```

`virtualPlayhead` is implemented identically to `playhead`. Per the spec, `virtualPlayhead` should represent the unbounded time value (continuing to increase even after the animation loops), while `playhead` represents the bounded time within the animation's range. Babylon.js's `getCurrentFrame()` only provides the bounded version.

### ⚠️ `event/send` Lacks Validation

Unlike `event/receive` which has a `validation` callback that checks for valid event configuration, `event/send` has no validation. Invalid event indices would fail inside the `extraProcessor` with a less helpful generic error.

### ⚠️ Silent No-Op for Unknown Operations

**File**: `declarationMapper.ts`, lines 183-208

When a declaration's operation has no mapping, the code logs a warning and returns a no-op mapping with `blocks: []`. This means unknown operations are silently ignored at runtime. While this prevents crashes, it can make debugging very difficult — the user sees no error, but the behavior doesn't work as expected.

### ℹ️ Missing Spec Operations

The following operations from the KHR_interactivity spec are not mapped in the declaration mapper:
- `math/Tau` (the spec defines this constant; only `E`, `Pi`, `Inf`, `NaN` are mapped)
- `math/quatFromUpForward`
- `math/quatSlerp`

### ℹ️ Coordinate System Transforms

**File**: `KHR_interactivity.ts`, lines 108-109, 121

```typescript
quat.w *= -1; // glTF uses right-handed system
quat.x *= -1;
```

The camera rotation and position transforms for left-handed systems only flip specific components. The correctness of these transforms should be verified against the glTF spec's coordinate system requirements.

### ℹ️ No Multi-Graph Support Beyond Iteration

While the code iterates over `interactivityDefinition.graphs` and processes each one, there's no handling of the optional `graph` property (which specifies the default graph index in the spec). All graphs are loaded and started unconditionally.

---

## 11. Glossary

| Term | Definition |
|------|------------|
| **Declaration** | A mapping from an index to an operation type (e.g., index 0 → `"math/add"`). Nodes reference declarations by index. |
| **Block** | A Babylon.js FlowGraph operation unit. Equivalent to a KHR_interactivity node. |
| **Socket** | A named input or output port on a node/block. Four types: input value, output value, input flow, output flow. |
| **Flow** | An execution path between blocks. Analogous to function calls — one block triggers the next. |
| **Value** | A data connection between blocks. Carries typed data (numbers, vectors, etc.). |
| **Context** | Execution state for a FlowGraph. Holds variables and cached connection values. |
| **Coordinator** | Top-level manager for FlowGraphs. Handles event dispatch and cross-graph communication. |
| **JSON Pointer** | An RFC 6901 string that addresses a specific value in the glTF object tree (e.g., `/nodes/0/translation`). |
| **Object Model** | The mapping from JSON pointer paths to Babylon.js object accessors. |
| **Mapping** | An `IGLTFToFlowGraphMapping` object that defines how a glTF operation translates to FlowGraph blocks. |
| **Inter-block connector** | A connection between blocks within a single multi-block mapping (not visible in the glTF graph). |
| **Extra processor** | A callback function in a mapping that performs additional setup after standard parsing. |
| **Data transformer** | A function in a mapping that converts values from glTF format to FlowGraph format (e.g., seconds → frames). |
