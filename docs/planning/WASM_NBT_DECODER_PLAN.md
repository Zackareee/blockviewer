# WASM NBT Decoder - Dynamic Hybrid Solution

## Executive Summary

**Current Status**: The project already has WASM-based NBT decoding using `fastnbt` and `flate2` in `src/wasm-mesher/src/decode/`. The bottleneck is:
1. **Fixed `BlockProperties` struct** with ~70 hardcoded fields - doesn't adapt to new blocks
2. **Block state lookup** via string building and registry calls

**Goal**: Make block state handling fully dynamic with O(1) hash lookups.

Expected **2x speedup** in chunk decoding (from faster state resolution).

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Compressed Chunk                           │
│                    (zlib/gzip compressed NBT)                      │
└──────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                    WASM Layer (wasm_nbt module)                   │
├──────────────────────────────────────────────────────────────────┤
│  1. decompress_chunk()     - zlib/gzip decompression             │
│  2. parse_nbt()            - Generic NBT tag parsing             │
│  3. extract_chunk_data()   - Minecraft chunk structure           │
│                                                                   │
│  Output:                                                          │
│  - palette_strings: Vec<String>    (raw block state strings)     │
│  - block_indices: Vec<u16>         (palette indices per block)   │
│  - block_light: Vec<u8>            (light data)                  │
│  - sky_light: Vec<u8>              (sky light data)              │
│  - heightmaps: HeightmapData       (for optimization)            │
└──────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Dynamic Lookup Table (WASM)                     │
├──────────────────────────────────────────────────────────────────┤
│  - Initialized from JS with known block states                    │
│  - Fast O(1) lookup via hash table                               │
│  - Returns block ID for known states                              │
│  - Returns UNKNOWN_BLOCK sentinel for new states                  │
└──────────────────────────────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
         ┌─────────────────┐      ┌─────────────────────┐
         │   Known Block   │      │   Unknown Block     │
         │   (fast path)   │      │   (JS fallback)     │
         ├─────────────────┤      ├─────────────────────┤
         │ Use WASM ID     │      │ Parse in JS         │
         │ directly        │      │ Register new block  │
         │                 │      │ Update WASM table   │
         └─────────────────┘      └─────────────────────┘
                    │                         │
                    └────────────┬────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Decoded Chunk Output                         │
├──────────────────────────────────────────────────────────────────┤
│  - BinaryGrid data (block IDs per position)                      │
│  - BlockStateGrid data (state indices)                           │
│  - LightGrid data (sky + block light)                            │
└──────────────────────────────────────────────────────────────────┘
```

## Phase 1: WASM NBT Parser Core

### 1.1 Create Rust NBT Module

**File: `src/wasm-mesher/src/nbt/mod.rs`**

```rust
pub mod parser;
pub mod tags;
pub mod chunk;
pub mod decompressor;

pub use parser::NBTParser;
pub use tags::NBTTag;
pub use chunk::ChunkData;
```

### 1.2 NBT Tag Types

**File: `src/wasm-mesher/src/nbt/tags.rs`**

```rust
#[derive(Debug, Clone)]
pub enum NBTTag {
    End,
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<i8>),
    String(String),
    List(Vec<NBTTag>),
    Compound(HashMap<String, NBTTag>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}
```

### 1.3 NBT Parser

**File: `src/wasm-mesher/src/nbt/parser.rs`**

```rust
pub struct NBTParser<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> NBTParser<'a> {
    pub fn parse(data: &'a [u8]) -> Result<NBTTag, NBTError> {
        let mut parser = Self { data, pos: 0 };
        parser.parse_tag()
    }
    
    fn parse_tag(&mut self) -> Result<NBTTag, NBTError> {
        let tag_type = self.read_byte()?;
        if tag_type == 0 { return Ok(NBTTag::End); }
        
        let _name = self.read_string()?; // Root name (usually empty)
        self.parse_payload(tag_type)
    }
    
    fn parse_payload(&mut self, tag_type: u8) -> Result<NBTTag, NBTError> {
        match tag_type {
            1 => Ok(NBTTag::Byte(self.read_byte()? as i8)),
            2 => Ok(NBTTag::Short(self.read_short()?)),
            3 => Ok(NBTTag::Int(self.read_int()?)),
            4 => Ok(NBTTag::Long(self.read_long()?)),
            5 => Ok(NBTTag::Float(self.read_float()?)),
            6 => Ok(NBTTag::Double(self.read_double()?)),
            7 => self.parse_byte_array(),
            8 => Ok(NBTTag::String(self.read_string()?)),
            9 => self.parse_list(),
            10 => self.parse_compound(),
            11 => self.parse_int_array(),
            12 => self.parse_long_array(),
            _ => Err(NBTError::UnknownTag(tag_type)),
        }
    }
}
```

### 1.4 Decompressor

**File: `src/wasm-mesher/src/nbt/decompressor.rs`**

```rust
use flate2::read::{GzDecoder, ZlibDecoder};
use std::io::Read;

pub fn decompress(data: &[u8], compression_type: u8) -> Result<Vec<u8>, DecompressError> {
    let mut output = Vec::new();
    
    match compression_type {
        1 => { // GZip
            let mut decoder = GzDecoder::new(data);
            decoder.read_to_end(&mut output)?;
        }
        2 => { // Zlib
            let mut decoder = ZlibDecoder::new(data);
            decoder.read_to_end(&mut output)?;
        }
        3 => { // Uncompressed (1.20.5+)
            output = data.to_vec();
        }
        _ => return Err(DecompressError::UnsupportedCompression(compression_type)),
    }
    
    Ok(output)
}
```

## Phase 2: Minecraft Chunk Extractor

### 2.1 Chunk Data Structure

**File: `src/wasm-mesher/src/nbt/chunk.rs`**

```rust
#[wasm_bindgen]
pub struct DecodedChunk {
    // Per-section data (24 sections, Y=-64 to Y=319)
    sections: Vec<ChunkSection>,
    
    // Block entities (chests, signs, etc.)
    block_entities: Vec<BlockEntityData>,
    
    // Heightmaps for optimization
    heightmaps: HeightmapData,
}

pub struct ChunkSection {
    pub y: i8,
    pub palette: Vec<String>,           // Raw block state strings
    pub block_states: Vec<u16>,         // Palette indices (4096 values)
    pub block_light: Option<Vec<u8>>,   // 2048 bytes (4 bits per block)
    pub sky_light: Option<Vec<u8>>,     // 2048 bytes
}

impl ChunkSection {
    /// Extract block states from packed long array
    pub fn unpack_block_states(
        data: &[i64],
        bits_per_block: u32,
        palette_size: usize,
    ) -> Vec<u16> {
        let mut states = Vec::with_capacity(4096);
        let blocks_per_long = 64 / bits_per_block;
        let mask = (1u64 << bits_per_block) - 1;
        
        for (block_idx, state) in states.iter_mut().enumerate().take(4096) {
            let long_idx = block_idx / blocks_per_long as usize;
            let bit_offset = (block_idx % blocks_per_long as usize) * bits_per_block as usize;
            
            if long_idx < data.len() {
                *state = ((data[long_idx] as u64 >> bit_offset) & mask) as u16;
            }
        }
        
        states
    }
}
```

### 2.2 Palette String Builder

```rust
impl ChunkSection {
    /// Build block state string from palette entry
    /// e.g., "minecraft:oak_stairs[facing=north,half=top,shape=straight]"
    pub fn build_state_string(entry: &NBTTag) -> String {
        let compound = entry.as_compound().unwrap();
        let name = compound.get("Name").unwrap().as_string().unwrap();
        
        if let Some(properties) = compound.get("Properties") {
            let props = properties.as_compound().unwrap();
            if props.is_empty() {
                return name.clone();
            }
            
            let prop_str: Vec<String> = props
                .iter()
                .map(|(k, v)| format!("{}={}", k, v.as_string().unwrap()))
                .collect();
            
            format!("{}[{}]", name, prop_str.join(","))
        } else {
            name.clone()
        }
    }
}
```

## Phase 3: Dynamic Block Lookup Table

### 3.1 WASM Lookup Table

**File: `src/wasm-mesher/src/nbt/block_lookup.rs`**

```rust
use std::collections::HashMap;
use once_cell::sync::OnceCell;

static BLOCK_LOOKUP: OnceCell<BlockLookup> = OnceCell::new();

pub struct BlockLookup {
    // FNV-1a hash of block state string → block ID
    table: HashMap<u64, u16>,
    
    // Unknown block sentinel
    unknown_id: u16,
}

impl BlockLookup {
    pub fn get(&self, state_hash: u64) -> Option<u16> {
        self.table.get(&state_hash).copied()
    }
    
    pub fn contains(&self, state_hash: u64) -> bool {
        self.table.contains_key(&state_hash)
    }
}

/// FNV-1a hash for block state strings
pub fn hash_block_state(state: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in state.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[wasm_bindgen]
pub fn init_block_lookup(data: &[u8]) {
    // Data format: [count: u32, (hash: u64, id: u16)...]
    let count = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    let mut table = HashMap::with_capacity(count);
    
    let mut offset = 4;
    for _ in 0..count {
        let hash = u64::from_le_bytes(data[offset..offset+8].try_into().unwrap());
        let id = u16::from_le_bytes(data[offset+8..offset+10].try_into().unwrap());
        table.insert(hash, id);
        offset += 10;
    }
    
    BLOCK_LOOKUP.set(BlockLookup { table, unknown_id: 0 }).ok();
}

#[wasm_bindgen]
pub fn lookup_block(state_hash: u64) -> i32 {
    BLOCK_LOOKUP.get()
        .and_then(|lookup| lookup.get(state_hash))
        .map(|id| id as i32)
        .unwrap_or(-1)  // -1 = unknown, handle in JS
}
```

### 3.2 JavaScript Bridge

**File: `src/mesh/WasmNBTDecoder.js`**

```javascript
export class WasmNBTDecoder {
    constructor() {
        this.wasmModule = null;
        this.blockLookup = new Map();  // state string → ID
        this.unknownBlocks = new Set(); // Track unknown blocks for reporting
    }
    
    async initialize(wasmModule) {
        this.wasmModule = wasmModule;
        await this.buildLookupTable();
    }
    
    /**
     * Build WASM lookup table from block registry
     */
    async buildLookupTable() {
        const registry = getBlockRegistry();
        const entries = [];
        
        for (const [state, id] of registry.getAllStates()) {
            const hash = this.hashBlockState(state);
            entries.push({ hash, id });
            this.blockLookup.set(state, id);
        }
        
        // Pack into binary format for WASM
        const buffer = new ArrayBuffer(4 + entries.length * 10);
        const view = new DataView(buffer);
        
        view.setUint32(0, entries.length, true);
        let offset = 4;
        
        for (const { hash, id } of entries) {
            view.setBigUint64(offset, hash, true);
            view.setUint16(offset + 8, id, true);
            offset += 10;
        }
        
        this.wasmModule.init_block_lookup(new Uint8Array(buffer));
        console.log(`[WasmNBTDecoder] Initialized lookup table with ${entries.length} states`);
    }
    
    /**
     * Decode a compressed chunk
     */
    decodeChunk(compressedData, compressionType, chunkX, chunkZ) {
        // Step 1: WASM decompression + NBT parsing
        const result = this.wasmModule.decode_chunk(
            compressedData,
            compressionType,
            chunkX,
            chunkZ
        );
        
        // Step 2: Map palette strings to block IDs
        const sections = [];
        
        for (const section of result.sections) {
            const blockIds = new Uint16Array(4096);
            
            for (let i = 0; i < 4096; i++) {
                const paletteIdx = section.block_indices[i];
                const stateString = section.palette[paletteIdx];
                
                // Try WASM fast path
                const hash = this.hashBlockState(stateString);
                let blockId = this.wasmModule.lookup_block(hash);
                
                if (blockId === -1) {
                    // Unknown block - use JS fallback
                    blockId = this.handleUnknownBlock(stateString);
                }
                
                blockIds[i] = blockId;
            }
            
            sections.push({
                y: section.y,
                blockIds,
                blockLight: section.block_light,
                skyLight: section.sky_light,
            });
        }
        
        return { sections, blockEntities: result.block_entities };
    }
    
    /**
     * Handle unknown block state - register and update lookup
     */
    handleUnknownBlock(stateString) {
        // Check JS cache first
        let id = this.blockLookup.get(stateString);
        if (id !== undefined) return id;
        
        // Register new block
        const registry = getBlockRegistry();
        id = registry.registerUnknownState(stateString);
        
        // Update caches
        this.blockLookup.set(stateString, id);
        this.unknownBlocks.add(stateString);
        
        // Update WASM lookup (batch this for performance)
        this.pendingLookupUpdates = this.pendingLookupUpdates || [];
        this.pendingLookupUpdates.push({ state: stateString, id });
        
        // Debounce WASM update
        if (!this.lookupUpdatePending) {
            this.lookupUpdatePending = true;
            queueMicrotask(() => this.flushLookupUpdates());
        }
        
        return id;
    }
    
    /**
     * FNV-1a hash (must match WASM implementation)
     */
    hashBlockState(state) {
        let hash = 0xcbf29ce484222325n;
        for (let i = 0; i < state.length; i++) {
            hash ^= BigInt(state.charCodeAt(i));
            hash = BigInt.asUintN(64, hash * 0x100000001b3n);
        }
        return hash;
    }
}
```

## Phase 4: Integration with SuperChunkWorker

### 4.1 Worker Integration

**File: `src/mesh/workers/SuperChunkWorker.js` (modifications)**

```javascript
// Add WASM NBT decoder
let wasmNbtDecoder = null;

async function initWasmNbtDecoder() {
    if (wasmNbtDecoder) return;
    
    const wasmModule = await initWasmModule();
    wasmNbtDecoder = {
        decode_chunk: wasmModule.decode_chunk,
        lookup_block: wasmModule.lookup_block,
        init_block_lookup: wasmModule.init_block_lookup,
    };
}

// Replace decompressChunk + parseNBT with WASM version
async function decodeChunkWasm(compressedData, compressionType) {
    if (!wasmNbtDecoder) {
        // Fallback to JS
        return decodeChunkJS(compressedData, compressionType);
    }
    
    try {
        return wasmNbtDecoder.decode_chunk(
            new Uint8Array(compressedData),
            compressionType
        );
    } catch (e) {
        console.warn('[SuperChunkWorker] WASM decode failed, falling back to JS:', e);
        return decodeChunkJS(compressedData, compressionType);
    }
}
```

## Phase 5: Testing & Benchmarking

### 5.1 Benchmark Test

```javascript
async function benchmarkDecoding() {
    const testChunks = await loadTestChunks();
    
    // Warm up
    for (const chunk of testChunks.slice(0, 10)) {
        await decodeChunkWasm(chunk.data, chunk.compression);
    }
    
    // Benchmark WASM
    const wasmStart = performance.now();
    for (const chunk of testChunks) {
        await decodeChunkWasm(chunk.data, chunk.compression);
    }
    const wasmTime = performance.now() - wasmStart;
    
    // Benchmark JS
    const jsStart = performance.now();
    for (const chunk of testChunks) {
        await decodeChunkJS(chunk.data, chunk.compression);
    }
    const jsTime = performance.now() - jsStart;
    
    console.log(`WASM: ${wasmTime.toFixed(1)}ms, JS: ${jsTime.toFixed(1)}ms`);
    console.log(`Speedup: ${(jsTime / wasmTime).toFixed(1)}x`);
}
```

## Implementation Status

### ✅ Completed

1. **Dynamic Block Properties** (`src/wasm-mesher/src/decode/nbt.rs`)
   - Added `dynamic_properties` HashMap field to capture any unknown properties
   - Implemented `to_sorted_vec()` for consistent property ordering
   - Added `build_dynamic_state_string()` method for automatic state string building
   - Added `fnv1a_hash()` function matching JS implementation

2. **FNV-1a Hash-Based Lookup** (`src/wasm-mesher/src/registry.rs`)
   - Created `StateHashLookup` struct with `FnvHashMap<u64, u16>`
   - Implemented `init_state_hash_lookup()` export for JS initialization
   - Added `get_block_id_by_hash()` and `get_state_id_by_hash()` functions
   - Fallback to string-based lookup when hash not found

3. **JS Bridge** (`src/mesh/WasmNBTDecoder.js`)
   - Created `WasmNBTDecoder` class for managing hash lookup
   - Implemented `fnv1aHash()` matching WASM implementation
   - Implemented `buildStateString()` for consistent state string building
   - Added fallback handling for unknown blocks

4. **Worker Integration** (`src/mesh/workers/SuperChunkWorker.js`, `SuperChunkWorkerPool.js`)
   - Added `init_state_hash_lookup` call to worker initialization
   - Built state hash lookup data from block registry + manifest
   - Integrated with existing worker pipeline

5. **Decoder Enhancement** (`src/wasm-mesher/src/decode/mod.rs`)
   - Updated `preprocess_palette_with_states()` to use hash-based lookup
   - O(1) state resolution when hash lookup is available
   - Automatic fallback to string-based lookup for unknown states

### Benchmark Results

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Rotation FPS | ~35 | ~35 | Neutral |
| 1% Low FPS | ~29 | ~29 | Neutral |

**Note**: The hash-based lookup is now integrated but the performance impact on chunk loading 
is difficult to measure in the rotation benchmark since that test primarily measures render 
performance after chunks are already loaded.

### Future Improvements

1. **Lazy Lookup Building**: Build hash lookup incrementally as states are encountered
2. **Dynamic Updates**: Allow adding new hashes at runtime without reinitialization
3. **Profiling**: Add timing instrumentation to measure actual decode speedup
4. **Cache Hit Rate**: Track how often hash lookup succeeds vs fallback

## Expected Results

| Metric | Current (JS) | Target (WASM) | Improvement |
|--------|-------------|---------------|-------------|
| Decompress | 15-25ms | 3-5ms | 5x |
| NBT Parse | 20-40ms | 5-10ms | 4x |
| Block Lookup | 5-10ms | 1-2ms | 5x |
| **Total** | **40-75ms** | **9-17ms** | **~4x** |

## Risk Mitigation

1. **WASM compile size**: NBT parser adds ~50KB - acceptable
2. **Memory usage**: Reuse buffers, avoid allocations
3. **Unknown blocks**: JS fallback ensures no visual issues
4. **Compatibility**: Support all Minecraft versions 1.13+

## Files to Create/Modify

### New Files:
- `src/wasm-mesher/src/nbt/mod.rs`
- `src/wasm-mesher/src/nbt/tags.rs`
- `src/wasm-mesher/src/nbt/parser.rs`
- `src/wasm-mesher/src/nbt/decompressor.rs`
- `src/wasm-mesher/src/nbt/chunk.rs`
- `src/wasm-mesher/src/nbt/block_lookup.rs`
- `src/mesh/WasmNBTDecoder.js`

### Modified Files:
- `src/wasm-mesher/src/lib.rs` - Export NBT functions
- `src/wasm-mesher/Cargo.toml` - Add flate2 dependency
- `src/mesh/workers/SuperChunkWorker.js` - Use WASM decoder
