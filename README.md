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

Test individual block rendering using coordinates from `debug_world_blocks.json`. Captures cropped screenshots centered on each block.

```bash
# Run block tests (headless)
npm run test:block

# Run with visible browser
npm run test:block:visible

# Update baseline screenshots
npm run test:block:update

# Filter to specific blocks
npm run test:block -- --filter=stairs
npm run test:block -- --filter=oak_door

# Limit number of tests
npm run test:block -- --limit=10
```

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
