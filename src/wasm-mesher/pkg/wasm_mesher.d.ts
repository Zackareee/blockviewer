/* tslint:disable */
/* eslint-disable */

export class MeshResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly lava_colors: Float32Array;
  readonly glass_colors: Float32Array;
  readonly lava_indices: Uint32Array;
  readonly lava_normals: Float32Array;
  readonly solid_colors: Float32Array;
  readonly water_colors: Float32Array;
  readonly glass_indices: Uint32Array;
  readonly glass_normals: Float32Array;
  readonly solid_indices: Uint32Array;
  readonly solid_normals: Float32Array;
  readonly water_indices: Uint32Array;
  readonly water_normals: Float32Array;
  readonly lava_positions: Float32Array;
  readonly lava_sky_light: Float32Array;
  readonly glass_positions: Float32Array;
  readonly glass_sky_light: Float32Array;
  /**
   * Get solid mesh positions as Float32Array
   */
  readonly solid_positions: Float32Array;
  readonly solid_sky_light: Float32Array;
  readonly water_positions: Float32Array;
  readonly water_sky_light: Float32Array;
  readonly glass_tint_types: Float32Array;
  readonly lava_block_light: Float32Array;
  readonly lava_tex_indices: Float32Array;
  readonly model_opaque_uvs: Float32Array;
  readonly solid_tint_types: Float32Array;
  readonly glass_block_light: Float32Array;
  readonly glass_tex_indices: Float32Array;
  readonly lava_packed_light: Uint8Array;
  readonly lava_vertex_count: number;
  readonly solid_block_light: Float32Array;
  readonly solid_tex_indices: Float32Array;
  readonly water_block_light: Float32Array;
  readonly water_tex_indices: Float32Array;
  readonly glass_packed_light: Uint8Array;
  readonly glass_vertex_count: number;
  readonly solid_packed_light: Uint8Array;
  readonly solid_vertex_count: number;
  readonly water_packed_light: Uint8Array;
  readonly water_vertex_count: number;
  readonly glass_tex_rotations: Float32Array;
  readonly model_opaque_colors: Float32Array;
  readonly solid_tex_rotations: Float32Array;
  readonly model_opaque_indices: Uint32Array;
  readonly model_opaque_normals: Float32Array;
  readonly model_transparent_uvs: Float32Array;
  readonly model_opaque_positions: Float32Array;
  readonly model_opaque_sky_light: Float32Array;
  readonly model_opaque_tint_types: Float32Array;
  readonly model_opaque_block_light: Float32Array;
  readonly model_opaque_tex_indices: Float32Array;
  readonly model_transparent_colors: Float32Array;
  readonly model_opaque_packed_light: Uint8Array;
  readonly model_opaque_vertex_count: number;
  readonly model_transparent_indices: Uint32Array;
  readonly model_transparent_normals: Float32Array;
  readonly model_transparent_positions: Float32Array;
  readonly model_transparent_sky_light: Float32Array;
  readonly model_transparent_tint_types: Float32Array;
  readonly model_transparent_block_light: Float32Array;
  readonly model_transparent_tex_indices: Float32Array;
  readonly model_transparent_packed_light: Uint8Array;
  readonly model_transparent_vertex_count: number;
  readonly lava_uvs: Float32Array;
  readonly water_uvs: Float32Array;
}

export class ProcessedChunk {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly lava_colors: Float32Array;
  readonly glass_colors: Float32Array;
  readonly lava_indices: Uint32Array;
  readonly lava_normals: Float32Array;
  readonly solid_colors: Float32Array;
  readonly water_colors: Float32Array;
  /**
   * Get error message if processing failed
   */
  readonly error_message: string;
  readonly glass_indices: Uint32Array;
  readonly glass_normals: Float32Array;
  readonly solid_indices: Uint32Array;
  readonly solid_normals: Float32Array;
  readonly water_indices: Uint32Array;
  readonly water_normals: Float32Array;
  /**
   * Number of non-air blocks decoded
   */
  readonly blocks_decoded: number;
  readonly lava_positions: Float32Array;
  readonly lava_sky_light: Float32Array;
  readonly glass_positions: Float32Array;
  readonly glass_sky_light: Float32Array;
  readonly solid_positions: Float32Array;
  readonly solid_sky_light: Float32Array;
  readonly water_positions: Float32Array;
  readonly water_sky_light: Float32Array;
  readonly glass_tint_types: Float32Array;
  readonly lava_block_light: Float32Array;
  readonly lava_tex_indices: Float32Array;
  readonly model_opaque_uvs: Float32Array;
  readonly solid_tint_types: Float32Array;
  readonly glass_block_light: Float32Array;
  readonly glass_tex_indices: Float32Array;
  readonly lava_packed_light: Uint8Array;
  readonly lava_vertex_count: number;
  /**
   * Get particle emitter data as flat array: [block_id, x, y, z, ...]
   */
  readonly particle_emitters: Int32Array;
  readonly solid_block_light: Float32Array;
  readonly solid_tex_indices: Float32Array;
  readonly water_block_light: Float32Array;
  readonly water_tex_indices: Float32Array;
  readonly glass_packed_light: Uint8Array;
  readonly glass_vertex_count: number;
  readonly solid_packed_light: Uint8Array;
  readonly solid_vertex_count: number;
  readonly water_packed_light: Uint8Array;
  readonly water_vertex_count: number;
  readonly glass_tex_rotations: Float32Array;
  readonly model_opaque_colors: Float32Array;
  readonly solid_tex_rotations: Float32Array;
  readonly model_opaque_indices: Uint32Array;
  readonly model_opaque_normals: Float32Array;
  readonly model_transparent_uvs: Float32Array;
  readonly model_opaque_positions: Float32Array;
  readonly model_opaque_sky_light: Float32Array;
  readonly particle_emitter_count: number;
  readonly model_opaque_tint_types: Float32Array;
  readonly model_opaque_block_light: Float32Array;
  readonly model_opaque_tex_indices: Float32Array;
  readonly model_transparent_colors: Float32Array;
  readonly model_opaque_packed_light: Uint8Array;
  readonly model_opaque_vertex_count: number;
  readonly model_transparent_indices: Uint32Array;
  readonly model_transparent_normals: Float32Array;
  readonly model_transparent_positions: Float32Array;
  readonly model_transparent_sky_light: Float32Array;
  readonly model_transparent_tint_types: Float32Array;
  readonly model_transparent_block_light: Float32Array;
  readonly model_transparent_tex_indices: Float32Array;
  readonly model_transparent_packed_light: Uint8Array;
  readonly model_transparent_vertex_count: number;
  /**
   * Chunk X coordinate
   */
  readonly chunk_x: number;
  /**
   * Chunk Z coordinate
   */
  readonly chunk_z: number;
  /**
   * Check if processing was successful
   */
  readonly success: boolean;
  readonly lava_uvs: Float32Array;
  readonly water_uvs: Float32Array;
}

/**
 * Initialize the WASM module (call once on startup)
 */
export function init(): void;

/**
 * Initialize the block registry from JavaScript
 * 
 * This should be called once after the BlockRegistry is loaded in JS.
 * The names and ids arrays must have the same length.
 * 
 * # Arguments
 * * `names` - Array of block names (e.g., ["minecraft:air", "minecraft:stone", ...])
 * * `ids` - Array of corresponding block IDs
 */
export function init_block_registry(names: string[], ids: Uint16Array): void;

/**
 * Initialize lookup tables from JS
 * Call this once after loading with block registry data
 */
export function init_lookups(is_opaque: Uint8Array, is_non_cube: Uint8Array, is_slab: Uint8Array, is_fluid: Uint8Array, is_glass: Uint8Array, is_ao_transparent: Uint8Array, is_rotatable: Uint8Array, is_directional: Uint8Array, color_r: Float32Array, color_g: Float32Array, color_b: Float32Array, face_tint_types: Uint8Array, texture_indices: Float32Array, water_still_idx: number, water_flow_idx: number, lava_still_idx: number, lava_flow_idx: number): number;

/**
 * Initialize model registry from JavaScript
 * 
 * Called once after state registry with serialized model geometry.
 * 
 * # Arguments
 * * `state_ids` - State IDs for each model
 * * `geometry_data` - Serialized model geometry (binary format)
 */
export function init_model_registry(state_ids: Uint16Array, geometry_data: Uint8Array): void;

/**
 * Initialize state registry from JavaScript
 * 
 * Called once at startup with all state strings and their IDs.
 * 
 * # Arguments
 * * `state_strings` - Newline-separated state strings
 * * `state_ids` - Corresponding state IDs
 */
export function init_state_registry(state_strings: string, state_ids: Uint16Array): void;

/**
 * Main entry point for meshing a chunk
 * 
 * Takes serialized grid data and returns mesh buffers
 * Optional bounds limit which blocks generate geometry (neighbors used for lookups only)
 */
export function mesh_chunk(grid_data: Uint8Array, light_data: Uint8Array, state_data: Uint8Array, lookup_ptr: number, lookup_len: number): MeshResult;

/**
 * Mesh chunk with explicit bounds
 * Bounds format: [min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z]
 */
export function mesh_chunk_bounded(grid_data: Uint8Array, light_data: Uint8Array, state_data: Uint8Array, lookup_ptr: number, lookup_len: number, min_chunk_x: number, min_chunk_z: number, max_chunk_x: number, max_chunk_z: number): MeshResult;

/**
 * Process a compressed chunk directly to mesh buffers
 * 
 * This is the unified pipeline entry point that handles:
 * 1. Decompression (zlib/gzip)
 * 2. NBT parsing
 * 3. Chunk decoding to grids
 * 4. Greedy meshing
 * 
 * # Arguments
 * * `compressed_data` - Raw compressed chunk data from region file
 * * `compression_type` - Compression type: 1=gzip, 2=zlib, 3=uncompressed
 * * `chunk_x` - Chunk X coordinate in world space
 * * `chunk_z` - Chunk Z coordinate in world space
 * 
 * # Returns
 * ProcessedChunk containing mesh buffers and metadata
 */
export function process_chunk(compressed_data: Uint8Array, compression_type: number, chunk_x: number, chunk_z: number): ProcessedChunk;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_meshresult_free: (a: number, b: number) => void;
  readonly __wbg_processedchunk_free: (a: number, b: number) => void;
  readonly init_lookups: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number) => number;
  readonly mesh_chunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly mesh_chunk_bounded: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => number;
  readonly meshresult_glass_block_light: (a: number) => [number, number];
  readonly meshresult_glass_colors: (a: number) => [number, number];
  readonly meshresult_glass_indices: (a: number) => [number, number];
  readonly meshresult_glass_normals: (a: number) => [number, number];
  readonly meshresult_glass_packed_light: (a: number) => [number, number];
  readonly meshresult_glass_positions: (a: number) => [number, number];
  readonly meshresult_glass_sky_light: (a: number) => [number, number];
  readonly meshresult_glass_tex_indices: (a: number) => [number, number];
  readonly meshresult_glass_tex_rotations: (a: number) => [number, number];
  readonly meshresult_glass_tint_types: (a: number) => [number, number];
  readonly meshresult_glass_vertex_count: (a: number) => number;
  readonly meshresult_lava_block_light: (a: number) => [number, number];
  readonly meshresult_lava_colors: (a: number) => [number, number];
  readonly meshresult_lava_indices: (a: number) => [number, number];
  readonly meshresult_lava_normals: (a: number) => [number, number];
  readonly meshresult_lava_packed_light: (a: number) => [number, number];
  readonly meshresult_lava_positions: (a: number) => [number, number];
  readonly meshresult_lava_sky_light: (a: number) => [number, number];
  readonly meshresult_lava_tex_indices: (a: number) => [number, number];
  readonly meshresult_lava_uvs: (a: number) => [number, number];
  readonly meshresult_lava_vertex_count: (a: number) => number;
  readonly meshresult_model_opaque_block_light: (a: number) => [number, number];
  readonly meshresult_model_opaque_colors: (a: number) => [number, number];
  readonly meshresult_model_opaque_indices: (a: number) => [number, number];
  readonly meshresult_model_opaque_normals: (a: number) => [number, number];
  readonly meshresult_model_opaque_packed_light: (a: number) => [number, number];
  readonly meshresult_model_opaque_positions: (a: number) => [number, number];
  readonly meshresult_model_opaque_sky_light: (a: number) => [number, number];
  readonly meshresult_model_opaque_tex_indices: (a: number) => [number, number];
  readonly meshresult_model_opaque_tint_types: (a: number) => [number, number];
  readonly meshresult_model_opaque_uvs: (a: number) => [number, number];
  readonly meshresult_model_opaque_vertex_count: (a: number) => number;
  readonly meshresult_model_transparent_block_light: (a: number) => [number, number];
  readonly meshresult_model_transparent_colors: (a: number) => [number, number];
  readonly meshresult_model_transparent_indices: (a: number) => [number, number];
  readonly meshresult_model_transparent_normals: (a: number) => [number, number];
  readonly meshresult_model_transparent_packed_light: (a: number) => [number, number];
  readonly meshresult_model_transparent_positions: (a: number) => [number, number];
  readonly meshresult_model_transparent_sky_light: (a: number) => [number, number];
  readonly meshresult_model_transparent_tex_indices: (a: number) => [number, number];
  readonly meshresult_model_transparent_tint_types: (a: number) => [number, number];
  readonly meshresult_model_transparent_uvs: (a: number) => [number, number];
  readonly meshresult_model_transparent_vertex_count: (a: number) => number;
  readonly meshresult_solid_block_light: (a: number) => [number, number];
  readonly meshresult_solid_colors: (a: number) => [number, number];
  readonly meshresult_solid_indices: (a: number) => [number, number];
  readonly meshresult_solid_normals: (a: number) => [number, number];
  readonly meshresult_solid_packed_light: (a: number) => [number, number];
  readonly meshresult_solid_positions: (a: number) => [number, number];
  readonly meshresult_solid_sky_light: (a: number) => [number, number];
  readonly meshresult_solid_tex_indices: (a: number) => [number, number];
  readonly meshresult_solid_tex_rotations: (a: number) => [number, number];
  readonly meshresult_solid_tint_types: (a: number) => [number, number];
  readonly meshresult_solid_vertex_count: (a: number) => number;
  readonly meshresult_water_block_light: (a: number) => [number, number];
  readonly meshresult_water_colors: (a: number) => [number, number];
  readonly meshresult_water_indices: (a: number) => [number, number];
  readonly meshresult_water_normals: (a: number) => [number, number];
  readonly meshresult_water_packed_light: (a: number) => [number, number];
  readonly meshresult_water_positions: (a: number) => [number, number];
  readonly meshresult_water_sky_light: (a: number) => [number, number];
  readonly meshresult_water_tex_indices: (a: number) => [number, number];
  readonly meshresult_water_uvs: (a: number) => [number, number];
  readonly meshresult_water_vertex_count: (a: number) => number;
  readonly process_chunk: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly processedchunk_blocks_decoded: (a: number) => number;
  readonly processedchunk_chunk_x: (a: number) => number;
  readonly processedchunk_chunk_z: (a: number) => number;
  readonly processedchunk_error_message: (a: number) => [number, number];
  readonly processedchunk_glass_block_light: (a: number) => [number, number];
  readonly processedchunk_glass_colors: (a: number) => [number, number];
  readonly processedchunk_glass_indices: (a: number) => [number, number];
  readonly processedchunk_glass_normals: (a: number) => [number, number];
  readonly processedchunk_glass_packed_light: (a: number) => [number, number];
  readonly processedchunk_glass_positions: (a: number) => [number, number];
  readonly processedchunk_glass_sky_light: (a: number) => [number, number];
  readonly processedchunk_glass_tex_indices: (a: number) => [number, number];
  readonly processedchunk_glass_tex_rotations: (a: number) => [number, number];
  readonly processedchunk_glass_tint_types: (a: number) => [number, number];
  readonly processedchunk_glass_vertex_count: (a: number) => number;
  readonly processedchunk_lava_block_light: (a: number) => [number, number];
  readonly processedchunk_lava_colors: (a: number) => [number, number];
  readonly processedchunk_lava_indices: (a: number) => [number, number];
  readonly processedchunk_lava_normals: (a: number) => [number, number];
  readonly processedchunk_lava_packed_light: (a: number) => [number, number];
  readonly processedchunk_lava_positions: (a: number) => [number, number];
  readonly processedchunk_lava_sky_light: (a: number) => [number, number];
  readonly processedchunk_lava_tex_indices: (a: number) => [number, number];
  readonly processedchunk_lava_uvs: (a: number) => [number, number];
  readonly processedchunk_lava_vertex_count: (a: number) => number;
  readonly processedchunk_model_opaque_block_light: (a: number) => [number, number];
  readonly processedchunk_model_opaque_colors: (a: number) => [number, number];
  readonly processedchunk_model_opaque_indices: (a: number) => [number, number];
  readonly processedchunk_model_opaque_normals: (a: number) => [number, number];
  readonly processedchunk_model_opaque_packed_light: (a: number) => [number, number];
  readonly processedchunk_model_opaque_positions: (a: number) => [number, number];
  readonly processedchunk_model_opaque_sky_light: (a: number) => [number, number];
  readonly processedchunk_model_opaque_tex_indices: (a: number) => [number, number];
  readonly processedchunk_model_opaque_tint_types: (a: number) => [number, number];
  readonly processedchunk_model_opaque_uvs: (a: number) => [number, number];
  readonly processedchunk_model_opaque_vertex_count: (a: number) => number;
  readonly processedchunk_model_transparent_block_light: (a: number) => [number, number];
  readonly processedchunk_model_transparent_colors: (a: number) => [number, number];
  readonly processedchunk_model_transparent_indices: (a: number) => [number, number];
  readonly processedchunk_model_transparent_normals: (a: number) => [number, number];
  readonly processedchunk_model_transparent_packed_light: (a: number) => [number, number];
  readonly processedchunk_model_transparent_positions: (a: number) => [number, number];
  readonly processedchunk_model_transparent_sky_light: (a: number) => [number, number];
  readonly processedchunk_model_transparent_tex_indices: (a: number) => [number, number];
  readonly processedchunk_model_transparent_tint_types: (a: number) => [number, number];
  readonly processedchunk_model_transparent_uvs: (a: number) => [number, number];
  readonly processedchunk_model_transparent_vertex_count: (a: number) => number;
  readonly processedchunk_particle_emitter_count: (a: number) => number;
  readonly processedchunk_particle_emitters: (a: number) => [number, number];
  readonly processedchunk_solid_block_light: (a: number) => [number, number];
  readonly processedchunk_solid_colors: (a: number) => [number, number];
  readonly processedchunk_solid_indices: (a: number) => [number, number];
  readonly processedchunk_solid_normals: (a: number) => [number, number];
  readonly processedchunk_solid_packed_light: (a: number) => [number, number];
  readonly processedchunk_solid_positions: (a: number) => [number, number];
  readonly processedchunk_solid_sky_light: (a: number) => [number, number];
  readonly processedchunk_solid_tex_indices: (a: number) => [number, number];
  readonly processedchunk_solid_tex_rotations: (a: number) => [number, number];
  readonly processedchunk_solid_tint_types: (a: number) => [number, number];
  readonly processedchunk_solid_vertex_count: (a: number) => number;
  readonly processedchunk_success: (a: number) => number;
  readonly processedchunk_water_block_light: (a: number) => [number, number];
  readonly processedchunk_water_colors: (a: number) => [number, number];
  readonly processedchunk_water_indices: (a: number) => [number, number];
  readonly processedchunk_water_normals: (a: number) => [number, number];
  readonly processedchunk_water_packed_light: (a: number) => [number, number];
  readonly processedchunk_water_positions: (a: number) => [number, number];
  readonly processedchunk_water_sky_light: (a: number) => [number, number];
  readonly processedchunk_water_tex_indices: (a: number) => [number, number];
  readonly processedchunk_water_uvs: (a: number) => [number, number];
  readonly processedchunk_water_vertex_count: (a: number) => number;
  readonly init: () => void;
  readonly init_model_registry: (a: number, b: number, c: number, d: number) => void;
  readonly init_state_registry: (a: number, b: number, c: number, d: number) => void;
  readonly init_block_registry: (a: number, b: number, c: number, d: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
