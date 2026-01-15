# Block Viewer

A Minecraft world viewer that renders `.mca` region files using Three.js. Replicates Minecraft's rendering pipeline including block meshing, lighting, ambient occlusion, and texture atlases.

## Getting Started

### Prerequisites

- Node.js 18+
- Rust and [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) for WASM builds

### Installation

```bash
npm install
```

### Development

```bash
# Build WASM and start dev server
npm run dev:wasm

# Or if WASM is already built, just start dev server
npm run dev
```

### Production Build

```bash
# Full build (WASM + Vite)
npm run build

# Preview production build
npm run preview
```

### WASM Build Only

```bash
# Debug build (faster, larger)
npm run build:wasm

# Release build (optimized)
npm run build:wasm:release
```

Open http://localhost:5173 and drag-and-drop a Minecraft world folder or `.mca` region file.

## Testing

### Visual Regression Tests

Compare rendered scenes against baseline screenshots to detect visual regressions.

```bash
# Run regression tests (headless)
npm run test:regression

# Run with visible browser for debugging
npm run test:regression:visible

# Update baseline screenshots after intentional changes
npm run test:regression:update
```

### Single Block Tests

Test individual block rendering using coordinates from `test/fixtures/debug_world_blocks.json`. Captures isometric screenshots of each block for regression testing.

#### Setting Up Block Tests (First Time)

Block tests require a "debug world" containing all block types and a generated block registry JSON.

**Step 1: Create or obtain a debug world**

Use a Minecraft debug world that contains every block type. Place it in the test folder:
```
test/world_files/debug_world.zip
```

**Step 2: Extract block registry from the world**

Run the extraction script to generate `test/fixtures/debug_world_blocks.json`:
```bash
node scripts/extract-world-blocks.cjs test/world_files/debug_world.zip test/fixtures/debug_world_blocks.json
```

This scans every chunk in the world and outputs a JSON file containing:
- Every unique block + properties combination
- Sample coordinates (x, y, z) for each block state
- Used by the block regression tests to locate blocks

**Step 3: Generate baseline screenshots**

Run the subset test (diverse ~100 blocks) to create initial baselines:
```bash
npm run test:block:subset:update
```

Or generate baselines for ALL blocks (takes hours):
```bash
npm run test:block:update
```

#### Running Block Tests

```bash
# Run subset tests (~100 diverse blocks, ~80 seconds)
npm run test:block:subset

# Run all block tests (29k+ blocks, takes hours)
npm run test:block

# Run with visible browser for debugging
npm run test:block:visible
npm run test:block:subset:visible

# Update baselines after intentional changes
npm run test:block:update
npm run test:block:subset:update

# Filter to specific blocks
npm run test:block -- --filter=stairs
npm run test:block -- --filter=oak_door

# Limit number of tests
npm run test:block -- --limit=10
```

#### How It Works

1. Loads the debug world with full region render distance (32 chunks)
2. Waits for 200+ chunks to load (ensures entire region is in memory)
3. For each block in the registry:
   - Positions camera isometrically (offset +X, +Y, +Z from block)
   - Takes screenshot and crops to 350x350 centered on the canvas
   - Compares against baseline or updates baseline

### Performance Tests

Measure rendering performance and chunk loading times.

```bash
# Run performance test (headless)
npm run test:performance

# Run with visible browser
npm run test:performance:visible

# Run benchmark suite
npm run test:benchmark
npm run test:benchmark:headless
```

### Mesh Consistency Tests

Verify mesh generation produces consistent output.

```bash
npm run test:mesh
npm run test:mesh:update
```

## Project Structure

- `src/mesh/` - Chunk meshing (FastMesher for greedy meshing, ModelMesher for partial blocks)
- `src/wasm-mesher/` - Rust/WASM implementation of meshers
- `src/viewer/` - Three.js rendering and materials
- `src/assets/` - Block models, textures, and atlases
- `test/e2e/` - End-to-end visual regression tests
- `docs/` - Technical documentation and Minecraft shader references
