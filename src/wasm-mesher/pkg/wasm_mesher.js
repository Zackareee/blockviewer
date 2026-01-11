let wasm;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getBigUint64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

const MeshResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshresult_free(ptr >>> 0, 1));

const MeshSizesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshsizes_free(ptr >>> 0, 1));

const ProcessedChunkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_processedchunk_free(ptr >>> 0, 1));

const StreamingMeshResultWasmFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_streamingmeshresultwasm_free(ptr >>> 0, 1));

/**
 * Result containing all mesh buffers
 */
export class MeshResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MeshResult.prototype);
        obj.__wbg_ptr = ptr;
        MeshResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshresult_free(ptr, 0);
    }
    /**
     * @returns {Float32Array}
     */
    get lava_colors() {
        const ret = wasm.meshresult_lava_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_colors() {
        const ret = wasm.meshresult_glass_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get lava_indices() {
        const ret = wasm.meshresult_lava_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_normals() {
        const ret = wasm.meshresult_lava_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_colors() {
        const ret = wasm.meshresult_solid_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_colors() {
        const ret = wasm.meshresult_water_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get glass_indices() {
        const ret = wasm.meshresult_glass_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_normals() {
        const ret = wasm.meshresult_glass_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get solid_indices() {
        const ret = wasm.meshresult_solid_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_normals() {
        const ret = wasm.meshresult_solid_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get water_indices() {
        const ret = wasm.meshresult_water_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_normals() {
        const ret = wasm.meshresult_water_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_positions() {
        const ret = wasm.meshresult_lava_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_sky_light() {
        const ret = wasm.meshresult_lava_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_positions() {
        const ret = wasm.meshresult_glass_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_sky_light() {
        const ret = wasm.meshresult_glass_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get solid mesh positions as Float32Array
     * @returns {Float32Array}
     */
    get solid_positions() {
        const ret = wasm.meshresult_solid_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_sky_light() {
        const ret = wasm.meshresult_solid_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_positions() {
        const ret = wasm.meshresult_water_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_sky_light() {
        const ret = wasm.meshresult_water_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_tint_types() {
        const ret = wasm.meshresult_glass_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_block_light() {
        const ret = wasm.meshresult_lava_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_tex_indices() {
        const ret = wasm.meshresult_lava_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_uvs() {
        const ret = wasm.meshresult_model_opaque_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_tint_types() {
        const ret = wasm.meshresult_solid_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_block_light() {
        const ret = wasm.meshresult_glass_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_tex_indices() {
        const ret = wasm.meshresult_glass_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get lava_packed_light() {
        const ret = wasm.meshresult_lava_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get lava_vertex_count() {
        const ret = wasm.meshresult_lava_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_block_light() {
        const ret = wasm.meshresult_solid_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_tex_indices() {
        const ret = wasm.meshresult_solid_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_block_light() {
        const ret = wasm.meshresult_water_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_tex_indices() {
        const ret = wasm.meshresult_water_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get glass_packed_light() {
        const ret = wasm.meshresult_glass_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get glass_vertex_count() {
        const ret = wasm.meshresult_glass_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get solid_packed_light() {
        const ret = wasm.meshresult_solid_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get solid_vertex_count() {
        const ret = wasm.meshresult_solid_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get water_packed_light() {
        const ret = wasm.meshresult_water_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get water_vertex_count() {
        const ret = wasm.meshresult_water_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_tex_rotations() {
        const ret = wasm.meshresult_glass_tex_rotations(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_colors() {
        const ret = wasm.meshresult_model_opaque_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_tex_rotations() {
        const ret = wasm.meshresult_solid_tex_rotations(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get model_opaque_indices() {
        const ret = wasm.meshresult_model_opaque_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_normals() {
        const ret = wasm.meshresult_model_opaque_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_uvs() {
        const ret = wasm.meshresult_model_transparent_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_positions() {
        const ret = wasm.meshresult_model_opaque_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_sky_light() {
        const ret = wasm.meshresult_model_opaque_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_tint_types() {
        const ret = wasm.meshresult_model_opaque_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_block_light() {
        const ret = wasm.meshresult_model_opaque_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_tex_indices() {
        const ret = wasm.meshresult_model_opaque_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_colors() {
        const ret = wasm.meshresult_model_transparent_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get model_opaque_packed_light() {
        const ret = wasm.meshresult_model_opaque_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get model_opaque_vertex_count() {
        const ret = wasm.meshresult_model_opaque_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint32Array}
     */
    get model_transparent_indices() {
        const ret = wasm.meshresult_model_transparent_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_normals() {
        const ret = wasm.meshresult_model_transparent_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_positions() {
        const ret = wasm.meshresult_model_transparent_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_sky_light() {
        const ret = wasm.meshresult_model_transparent_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_tint_types() {
        const ret = wasm.meshresult_model_transparent_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_block_light() {
        const ret = wasm.meshresult_model_transparent_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_tex_indices() {
        const ret = wasm.meshresult_model_transparent_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get model_transparent_packed_light() {
        const ret = wasm.meshresult_model_transparent_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get model_transparent_vertex_count() {
        const ret = wasm.meshresult_model_transparent_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_uvs() {
        const ret = wasm.meshresult_lava_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_uvs() {
        const ret = wasm.meshresult_water_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) MeshResult.prototype[Symbol.dispose] = MeshResult.prototype.free;

/**
 * Metadata for zero-copy mesh result - only counts, no data copying
 */
export class MeshSizes {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MeshSizes.prototype);
        obj.__wbg_ptr = ptr;
        MeshSizesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshSizesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshsizes_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get solid_position_count() {
        const ret = wasm.__wbg_get_meshsizes_solid_position_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set solid_position_count(arg0) {
        wasm.__wbg_set_meshsizes_solid_position_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get solid_index_count() {
        const ret = wasm.__wbg_get_meshsizes_solid_index_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set solid_index_count(arg0) {
        wasm.__wbg_set_meshsizes_solid_index_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get solid_vertex_count() {
        const ret = wasm.__wbg_get_meshsizes_solid_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set solid_vertex_count(arg0) {
        wasm.__wbg_set_meshsizes_solid_vertex_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get water_position_count() {
        const ret = wasm.__wbg_get_meshsizes_water_position_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set water_position_count(arg0) {
        wasm.__wbg_set_meshsizes_water_position_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get water_index_count() {
        const ret = wasm.__wbg_get_meshsizes_water_index_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set water_index_count(arg0) {
        wasm.__wbg_set_meshsizes_water_index_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get water_vertex_count() {
        const ret = wasm.__wbg_get_meshsizes_water_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set water_vertex_count(arg0) {
        wasm.__wbg_set_meshsizes_water_vertex_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get lava_position_count() {
        const ret = wasm.__wbg_get_meshsizes_lava_position_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set lava_position_count(arg0) {
        wasm.__wbg_set_meshsizes_lava_position_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get lava_index_count() {
        const ret = wasm.__wbg_get_meshsizes_lava_index_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set lava_index_count(arg0) {
        wasm.__wbg_set_meshsizes_lava_index_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get lava_vertex_count() {
        const ret = wasm.__wbg_get_meshsizes_lava_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set lava_vertex_count(arg0) {
        wasm.__wbg_set_meshsizes_lava_vertex_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get glass_position_count() {
        const ret = wasm.__wbg_get_meshsizes_glass_position_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set glass_position_count(arg0) {
        wasm.__wbg_set_meshsizes_glass_position_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get glass_index_count() {
        const ret = wasm.__wbg_get_meshsizes_glass_index_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set glass_index_count(arg0) {
        wasm.__wbg_set_meshsizes_glass_index_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get glass_vertex_count() {
        const ret = wasm.__wbg_get_meshsizes_glass_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set glass_vertex_count(arg0) {
        wasm.__wbg_set_meshsizes_glass_vertex_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get model_opaque_position_count() {
        const ret = wasm.__wbg_get_meshsizes_model_opaque_position_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set model_opaque_position_count(arg0) {
        wasm.__wbg_set_meshsizes_model_opaque_position_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get model_opaque_index_count() {
        const ret = wasm.__wbg_get_meshsizes_model_opaque_index_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set model_opaque_index_count(arg0) {
        wasm.__wbg_set_meshsizes_model_opaque_index_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get model_opaque_vertex_count() {
        const ret = wasm.__wbg_get_meshsizes_model_opaque_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set model_opaque_vertex_count(arg0) {
        wasm.__wbg_set_meshsizes_model_opaque_vertex_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get model_transparent_position_count() {
        const ret = wasm.__wbg_get_meshsizes_model_transparent_position_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set model_transparent_position_count(arg0) {
        wasm.__wbg_set_meshsizes_model_transparent_position_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get model_transparent_index_count() {
        const ret = wasm.__wbg_get_meshsizes_model_transparent_index_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set model_transparent_index_count(arg0) {
        wasm.__wbg_set_meshsizes_model_transparent_index_count(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get model_transparent_vertex_count() {
        const ret = wasm.__wbg_get_meshsizes_model_transparent_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set model_transparent_vertex_count(arg0) {
        wasm.__wbg_set_meshsizes_model_transparent_vertex_count(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) MeshSizes.prototype[Symbol.dispose] = MeshSizes.prototype.free;

/**
 * Result of processing a compressed chunk
 */
export class ProcessedChunk {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProcessedChunk.prototype);
        obj.__wbg_ptr = ptr;
        ProcessedChunkFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProcessedChunkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_processedchunk_free(ptr, 0);
    }
    /**
     * @returns {Float32Array}
     */
    get lava_colors() {
        const ret = wasm.processedchunk_lava_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_colors() {
        const ret = wasm.processedchunk_glass_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get lava_indices() {
        const ret = wasm.processedchunk_lava_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_normals() {
        const ret = wasm.processedchunk_lava_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_colors() {
        const ret = wasm.processedchunk_solid_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_colors() {
        const ret = wasm.processedchunk_water_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get error message if processing failed
     * @returns {string}
     */
    get error_message() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processedchunk_error_message(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get glass_indices() {
        const ret = wasm.processedchunk_glass_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_normals() {
        const ret = wasm.processedchunk_glass_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get solid_indices() {
        const ret = wasm.processedchunk_solid_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_normals() {
        const ret = wasm.processedchunk_solid_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get water_indices() {
        const ret = wasm.processedchunk_water_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_normals() {
        const ret = wasm.processedchunk_water_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Number of non-air blocks decoded
     * @returns {number}
     */
    get blocks_decoded() {
        const ret = wasm.processedchunk_blocks_decoded(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_positions() {
        const ret = wasm.processedchunk_lava_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_sky_light() {
        const ret = wasm.processedchunk_lava_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_positions() {
        const ret = wasm.processedchunk_glass_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_sky_light() {
        const ret = wasm.processedchunk_glass_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_positions() {
        const ret = wasm.processedchunk_solid_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_sky_light() {
        const ret = wasm.processedchunk_solid_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_positions() {
        const ret = wasm.processedchunk_water_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_sky_light() {
        const ret = wasm.processedchunk_water_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_tint_types() {
        const ret = wasm.processedchunk_glass_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_block_light() {
        const ret = wasm.processedchunk_lava_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_tex_indices() {
        const ret = wasm.processedchunk_lava_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_uvs() {
        const ret = wasm.processedchunk_model_opaque_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_tint_types() {
        const ret = wasm.processedchunk_solid_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_block_light() {
        const ret = wasm.processedchunk_glass_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_tex_indices() {
        const ret = wasm.processedchunk_glass_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get lava_packed_light() {
        const ret = wasm.processedchunk_lava_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get lava_vertex_count() {
        const ret = wasm.processedchunk_lava_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get particle emitter data as flat array: [block_id, x, y, z, ...]
     * @returns {Int32Array}
     */
    get particle_emitters() {
        const ret = wasm.processedchunk_particle_emitters(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_block_light() {
        const ret = wasm.processedchunk_solid_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_tex_indices() {
        const ret = wasm.processedchunk_solid_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_block_light() {
        const ret = wasm.processedchunk_water_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_tex_indices() {
        const ret = wasm.processedchunk_water_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get glass_packed_light() {
        const ret = wasm.processedchunk_glass_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get glass_vertex_count() {
        const ret = wasm.processedchunk_glass_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get solid_packed_light() {
        const ret = wasm.processedchunk_solid_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get solid_vertex_count() {
        const ret = wasm.processedchunk_solid_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get water_packed_light() {
        const ret = wasm.processedchunk_water_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get water_vertex_count() {
        const ret = wasm.processedchunk_water_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get glass_tex_rotations() {
        const ret = wasm.processedchunk_glass_tex_rotations(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_colors() {
        const ret = wasm.processedchunk_model_opaque_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get solid_tex_rotations() {
        const ret = wasm.processedchunk_solid_tex_rotations(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get model_opaque_indices() {
        const ret = wasm.processedchunk_model_opaque_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_normals() {
        const ret = wasm.processedchunk_model_opaque_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_uvs() {
        const ret = wasm.processedchunk_model_transparent_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_positions() {
        const ret = wasm.processedchunk_model_opaque_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_sky_light() {
        const ret = wasm.processedchunk_model_opaque_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    get particle_emitter_count() {
        const ret = wasm.processedchunk_particle_emitter_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_tint_types() {
        const ret = wasm.processedchunk_model_opaque_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_block_light() {
        const ret = wasm.processedchunk_model_opaque_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_opaque_tex_indices() {
        const ret = wasm.processedchunk_model_opaque_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_colors() {
        const ret = wasm.processedchunk_model_transparent_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get model_opaque_packed_light() {
        const ret = wasm.processedchunk_model_opaque_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get model_opaque_vertex_count() {
        const ret = wasm.processedchunk_model_opaque_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint32Array}
     */
    get model_transparent_indices() {
        const ret = wasm.processedchunk_model_transparent_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_normals() {
        const ret = wasm.processedchunk_model_transparent_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_positions() {
        const ret = wasm.processedchunk_model_transparent_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_sky_light() {
        const ret = wasm.processedchunk_model_transparent_sky_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_tint_types() {
        const ret = wasm.processedchunk_model_transparent_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_block_light() {
        const ret = wasm.processedchunk_model_transparent_block_light(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get model_transparent_tex_indices() {
        const ret = wasm.processedchunk_model_transparent_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get model_transparent_packed_light() {
        const ret = wasm.processedchunk_model_transparent_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get model_transparent_vertex_count() {
        const ret = wasm.processedchunk_model_transparent_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Chunk X coordinate
     * @returns {number}
     */
    get chunk_x() {
        const ret = wasm.processedchunk_chunk_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * Chunk Z coordinate
     * @returns {number}
     */
    get chunk_z() {
        const ret = wasm.processedchunk_chunk_z(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if processing was successful
     * @returns {boolean}
     */
    get success() {
        const ret = wasm.processedchunk_success(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {Float32Array}
     */
    get lava_uvs() {
        const ret = wasm.processedchunk_lava_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get water_uvs() {
        const ret = wasm.processedchunk_water_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) ProcessedChunk.prototype[Symbol.dispose] = ProcessedChunk.prototype.free;

/**
 * Result from streaming mesh - includes boundary face info
 */
export class StreamingMeshResultWasm {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(StreamingMeshResultWasm.prototype);
        obj.__wbg_ptr = ptr;
        StreamingMeshResultWasmFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StreamingMeshResultWasmFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_streamingmeshresultwasm_free(ptr, 0);
    }
    /**
     * @returns {Float32Array}
     */
    get tint_types() {
        const ret = wasm.streamingmeshresultwasm_tint_types(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get tex_indices() {
        const ret = wasm.streamingmeshresultwasm_tex_indices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get packed_light() {
        const ret = wasm.streamingmeshresultwasm_packed_light(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get vertex_count() {
        const ret = wasm.meshresult_solid_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get tex_rotations() {
        const ret = wasm.streamingmeshresultwasm_tex_rotations(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    get boundary_neg_x_count() {
        const ret = wasm.streamingmeshresultwasm_boundary_neg_x_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get boundary_neg_z_count() {
        const ret = wasm.processedchunk_solid_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get boundary_pos_x_count() {
        const ret = wasm.streamingmeshresultwasm_boundary_pos_x_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get boundary_pos_z_count() {
        const ret = wasm.streamingmeshresultwasm_boundary_pos_z_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get colors() {
        const ret = wasm.streamingmeshresultwasm_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    get indices() {
        const ret = wasm.streamingmeshresultwasm_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get normals() {
        const ret = wasm.streamingmeshresultwasm_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get positions() {
        const ret = wasm.streamingmeshresultwasm_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) StreamingMeshResultWasm.prototype[Symbol.dispose] = StreamingMeshResultWasm.prototype.free;

/**
 * Clear the cached mesh result (call if you don't need to write it)
 */
export function clear_cached_result() {
    wasm.clear_cached_result();
}

/**
 * Pre-compute mesh sizes before allocating buffers
 * @param {Uint8Array} grid_data
 * @param {Uint8Array} light_data
 * @param {Uint8Array} state_data
 * @param {number} min_chunk_x
 * @param {number} min_chunk_z
 * @param {number} max_chunk_x
 * @param {number} max_chunk_z
 * @returns {MeshSizes}
 */
export function compute_mesh_sizes(grid_data, light_data, state_data, min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z) {
    const ptr0 = passArray8ToWasm0(grid_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(light_data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(state_data, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.compute_mesh_sizes(ptr0, len0, ptr1, len1, ptr2, len2, min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z);
    return MeshSizes.__wrap(ret);
}

/**
 * Expose hash function to JavaScript for pre-computing hashes
 * @param {string} state_string
 * @returns {bigint}
 */
export function compute_state_hash(state_string) {
    const ptr0 = passStringToWasm0(state_string, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_state_hash(ptr0, len0);
    return BigInt.asUintN(64, ret);
}

/**
 * Compute multiple state hashes at once (more efficient for bulk operations)
 * @param {string} state_strings
 * @returns {BigUint64Array}
 */
export function compute_state_hashes(state_strings) {
    const ptr0 = passStringToWasm0(state_strings, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_state_hashes(ptr0, len0);
    var v2 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * Initialize the WASM module (call once on startup)
 */
export function init() {
    wasm.init();
}

/**
 * Initialize the block registry from JavaScript
 *
 * This should be called once after the BlockRegistry is loaded in JS.
 * The names and ids arrays must have the same length.
 *
 * # Arguments
 * * `names` - Array of block names (e.g., ["minecraft:air", "minecraft:stone", ...])
 * * `ids` - Array of corresponding block IDs
 * @param {string[]} names
 * @param {Uint16Array} ids
 */
export function init_block_registry(names, ids) {
    const ptr0 = passArrayJsValueToWasm0(names, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray16ToWasm0(ids, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.init_block_registry(ptr0, len0, ptr1, len1);
}

/**
 * Initialize hash-based model registry from JavaScript
 *
 * This uses state string hashes for lookup, eliminating the need for
 * synchronized state IDs between main thread and workers.
 *
 * # Arguments
 * * `state_strings` - Newline-separated state strings
 * * `geometry_data` - Serialized model geometry (binary format, same as init_model_registry)
 * @param {string} state_strings
 * @param {Uint8Array} geometry_data
 */
export function init_hash_model_registry(state_strings, geometry_data) {
    const ptr0 = passStringToWasm0(state_strings, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(geometry_data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.init_hash_model_registry(ptr0, len0, ptr1, len1);
}

/**
 * Initialize hash-based model registry with pre-computed hashes
 *
 * More efficient than init_hash_model_registry as hashes are pre-computed
 * on the JavaScript side.
 *
 * # Arguments
 * * `state_hashes` - Array of 64-bit FNV-1a hashes of state strings
 * * `geometry_data` - Serialized model geometry (binary format)
 * @param {BigUint64Array} state_hashes
 * @param {Uint8Array} geometry_data
 */
export function init_hash_model_registry_precomputed(state_hashes, geometry_data) {
    const ptr0 = passArray64ToWasm0(state_hashes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(geometry_data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.init_hash_model_registry_precomputed(ptr0, len0, ptr1, len1);
}

/**
 * Initialize lookup tables from JS
 * Call this once after loading with block registry data
 * @param {Uint8Array} is_opaque
 * @param {Uint8Array} is_non_cube
 * @param {Uint8Array} is_slab
 * @param {Uint8Array} is_fluid
 * @param {Uint8Array} is_glass
 * @param {Uint8Array} is_ao_transparent
 * @param {Uint8Array} is_rotatable
 * @param {Uint8Array} is_directional
 * @param {Float32Array} color_r
 * @param {Float32Array} color_g
 * @param {Float32Array} color_b
 * @param {Uint8Array} face_tint_types
 * @param {Float32Array} texture_indices
 * @param {number} water_still_idx
 * @param {number} water_flow_idx
 * @param {number} lava_still_idx
 * @param {number} lava_flow_idx
 * @returns {number}
 */
export function init_lookups(is_opaque, is_non_cube, is_slab, is_fluid, is_glass, is_ao_transparent, is_rotatable, is_directional, color_r, color_g, color_b, face_tint_types, texture_indices, water_still_idx, water_flow_idx, lava_still_idx, lava_flow_idx) {
    const ptr0 = passArray8ToWasm0(is_opaque, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(is_non_cube, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(is_slab, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(is_fluid, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(is_glass, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(is_ao_transparent, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray8ToWasm0(is_rotatable, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray8ToWasm0(is_directional, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArrayF32ToWasm0(color_r, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ptr9 = passArrayF32ToWasm0(color_g, wasm.__wbindgen_malloc);
    const len9 = WASM_VECTOR_LEN;
    const ptr10 = passArrayF32ToWasm0(color_b, wasm.__wbindgen_malloc);
    const len10 = WASM_VECTOR_LEN;
    const ptr11 = passArray8ToWasm0(face_tint_types, wasm.__wbindgen_malloc);
    const len11 = WASM_VECTOR_LEN;
    const ptr12 = passArrayF32ToWasm0(texture_indices, wasm.__wbindgen_malloc);
    const len12 = WASM_VECTOR_LEN;
    const ret = wasm.init_lookups(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, ptr11, len11, ptr12, len12, water_still_idx, water_flow_idx, lava_still_idx, lava_flow_idx);
    return ret >>> 0;
}

/**
 * Initialize model registry from JavaScript
 *
 * Called once after state registry with serialized model geometry.
 *
 * # Arguments
 * * `state_ids` - State IDs for each model
 * * `geometry_data` - Serialized model geometry (binary format)
 * @param {Uint16Array} state_ids
 * @param {Uint8Array} geometry_data
 */
export function init_model_registry(state_ids, geometry_data) {
    const ptr0 = passArray16ToWasm0(state_ids, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(geometry_data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.init_model_registry(ptr0, len0, ptr1, len1);
}

/**
 * Initialize state registry from JavaScript
 *
 * Called once at startup with all state strings and their IDs.
 *
 * # Arguments
 * * `state_strings` - Newline-separated state strings
 * * `state_ids` - Corresponding state IDs
 * @param {string} state_strings
 * @param {Uint16Array} state_ids
 */
export function init_state_registry(state_strings, state_ids) {
    const ptr0 = passStringToWasm0(state_strings, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray16ToWasm0(state_ids, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.init_state_registry(ptr0, len0, ptr1, len1);
}

/**
 * Check if parallel meshing is available
 * @returns {boolean}
 */
export function is_parallel_available() {
    const ret = wasm.is_parallel_available();
    return ret !== 0;
}

/**
 * Main entry point for meshing a chunk
 *
 * Takes serialized grid data and returns mesh buffers
 * Optional bounds limit which blocks generate geometry (neighbors used for lookups only)
 * @param {Uint8Array} grid_data
 * @param {Uint8Array} light_data
 * @param {Uint8Array} state_data
 * @param {number} lookup_ptr
 * @param {number} lookup_len
 * @returns {MeshResult}
 */
export function mesh_chunk(grid_data, light_data, state_data, lookup_ptr, lookup_len) {
    const ptr0 = passArray8ToWasm0(grid_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(light_data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(state_data, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.mesh_chunk(ptr0, len0, ptr1, len1, ptr2, len2, lookup_ptr, lookup_len);
    return MeshResult.__wrap(ret);
}

/**
 * Mesh chunk with explicit bounds
 * Bounds format: [min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z]
 * @param {Uint8Array} grid_data
 * @param {Uint8Array} light_data
 * @param {Uint8Array} state_data
 * @param {number} lookup_ptr
 * @param {number} lookup_len
 * @param {number} min_chunk_x
 * @param {number} min_chunk_z
 * @param {number} max_chunk_x
 * @param {number} max_chunk_z
 * @returns {MeshResult}
 */
export function mesh_chunk_bounded(grid_data, light_data, state_data, lookup_ptr, lookup_len, min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z) {
    const ptr0 = passArray8ToWasm0(grid_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(light_data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(state_data, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.mesh_chunk_bounded(ptr0, len0, ptr1, len1, ptr2, len2, lookup_ptr, lookup_len, min_chunk_x, min_chunk_z, max_chunk_x, max_chunk_z);
    return MeshResult.__wrap(ret);
}

/**
 * Mesh a single chunk in streaming mode (for deferred boundary repair)
 * @param {Uint8Array} grid_data
 * @param {Uint8Array} light_data
 * @param {number} chunk_x
 * @param {number} chunk_z
 * @returns {StreamingMeshResultWasm}
 */
export function mesh_chunk_streaming(grid_data, light_data, chunk_x, chunk_z) {
    const ptr0 = passArray8ToWasm0(grid_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(light_data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.mesh_chunk_streaming(ptr0, len0, ptr1, len1, chunk_x, chunk_z);
    return StreamingMeshResultWasm.__wrap(ret);
}

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
 * @param {Uint8Array} compressed_data
 * @param {number} compression_type
 * @param {number} chunk_x
 * @param {number} chunk_z
 * @returns {ProcessedChunk}
 */
export function process_chunk(compressed_data, compression_type, chunk_x, chunk_z) {
    const ptr0 = passArray8ToWasm0(compressed_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_chunk(ptr0, len0, compression_type, chunk_x, chunk_z);
    return ProcessedChunk.__wrap(ret);
}

/**
 * Write cached mesh data to pre-allocated JS typed arrays (zero-copy path)
 * Call this immediately after compute_mesh_sizes with appropriately sized arrays.
 *
 * Buffer layout per mesh type:
 * - positions: Float32Array (vertex_count * 3)
 * - normals: Float32Array (vertex_count * 3)
 * - colors: Float32Array (vertex_count * 3)
 * - tex_indices: Float32Array (vertex_count)
 * - tex_rotations: Float32Array (vertex_count)
 * - tint_types: Float32Array (vertex_count)
 * - packed_light: Uint8Array (vertex_count)
 * - indices: Uint32Array (index_count)
 * @param {Float32Array} solid_positions
 * @param {Float32Array} solid_normals
 * @param {Float32Array} solid_colors
 * @param {Float32Array} solid_tex_indices
 * @param {Float32Array} solid_tex_rotations
 * @param {Float32Array} solid_tint_types
 * @param {Uint8Array} solid_packed_light
 * @param {Uint32Array} solid_indices
 * @param {Float32Array} water_positions
 * @param {Float32Array} water_normals
 * @param {Float32Array} water_colors
 * @param {Float32Array} water_uvs
 * @param {Float32Array} water_tex_indices
 * @param {Uint8Array} water_packed_light
 * @param {Uint32Array} water_indices
 * @param {Float32Array} lava_positions
 * @param {Float32Array} lava_normals
 * @param {Float32Array} lava_colors
 * @param {Float32Array} lava_uvs
 * @param {Float32Array} lava_tex_indices
 * @param {Uint8Array} lava_packed_light
 * @param {Uint32Array} lava_indices
 * @param {Float32Array} glass_positions
 * @param {Float32Array} glass_normals
 * @param {Float32Array} glass_colors
 * @param {Float32Array} glass_tex_indices
 * @param {Float32Array} glass_tex_rotations
 * @param {Float32Array} glass_tint_types
 * @param {Uint8Array} glass_packed_light
 * @param {Uint32Array} glass_indices
 * @returns {boolean}
 */
export function write_mesh_to_buffers(solid_positions, solid_normals, solid_colors, solid_tex_indices, solid_tex_rotations, solid_tint_types, solid_packed_light, solid_indices, water_positions, water_normals, water_colors, water_uvs, water_tex_indices, water_packed_light, water_indices, lava_positions, lava_normals, lava_colors, lava_uvs, lava_tex_indices, lava_packed_light, lava_indices, glass_positions, glass_normals, glass_colors, glass_tex_indices, glass_tex_rotations, glass_tint_types, glass_packed_light, glass_indices) {
    var ptr0 = passArrayF32ToWasm0(solid_positions, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(solid_normals, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = passArrayF32ToWasm0(solid_colors, wasm.__wbindgen_malloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = passArrayF32ToWasm0(solid_tex_indices, wasm.__wbindgen_malloc);
    var len3 = WASM_VECTOR_LEN;
    var ptr4 = passArrayF32ToWasm0(solid_tex_rotations, wasm.__wbindgen_malloc);
    var len4 = WASM_VECTOR_LEN;
    var ptr5 = passArrayF32ToWasm0(solid_tint_types, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    var ptr6 = passArray8ToWasm0(solid_packed_light, wasm.__wbindgen_malloc);
    var len6 = WASM_VECTOR_LEN;
    var ptr7 = passArray32ToWasm0(solid_indices, wasm.__wbindgen_malloc);
    var len7 = WASM_VECTOR_LEN;
    var ptr8 = passArrayF32ToWasm0(water_positions, wasm.__wbindgen_malloc);
    var len8 = WASM_VECTOR_LEN;
    var ptr9 = passArrayF32ToWasm0(water_normals, wasm.__wbindgen_malloc);
    var len9 = WASM_VECTOR_LEN;
    var ptr10 = passArrayF32ToWasm0(water_colors, wasm.__wbindgen_malloc);
    var len10 = WASM_VECTOR_LEN;
    var ptr11 = passArrayF32ToWasm0(water_uvs, wasm.__wbindgen_malloc);
    var len11 = WASM_VECTOR_LEN;
    var ptr12 = passArrayF32ToWasm0(water_tex_indices, wasm.__wbindgen_malloc);
    var len12 = WASM_VECTOR_LEN;
    var ptr13 = passArray8ToWasm0(water_packed_light, wasm.__wbindgen_malloc);
    var len13 = WASM_VECTOR_LEN;
    var ptr14 = passArray32ToWasm0(water_indices, wasm.__wbindgen_malloc);
    var len14 = WASM_VECTOR_LEN;
    var ptr15 = passArrayF32ToWasm0(lava_positions, wasm.__wbindgen_malloc);
    var len15 = WASM_VECTOR_LEN;
    var ptr16 = passArrayF32ToWasm0(lava_normals, wasm.__wbindgen_malloc);
    var len16 = WASM_VECTOR_LEN;
    var ptr17 = passArrayF32ToWasm0(lava_colors, wasm.__wbindgen_malloc);
    var len17 = WASM_VECTOR_LEN;
    var ptr18 = passArrayF32ToWasm0(lava_uvs, wasm.__wbindgen_malloc);
    var len18 = WASM_VECTOR_LEN;
    var ptr19 = passArrayF32ToWasm0(lava_tex_indices, wasm.__wbindgen_malloc);
    var len19 = WASM_VECTOR_LEN;
    var ptr20 = passArray8ToWasm0(lava_packed_light, wasm.__wbindgen_malloc);
    var len20 = WASM_VECTOR_LEN;
    var ptr21 = passArray32ToWasm0(lava_indices, wasm.__wbindgen_malloc);
    var len21 = WASM_VECTOR_LEN;
    var ptr22 = passArrayF32ToWasm0(glass_positions, wasm.__wbindgen_malloc);
    var len22 = WASM_VECTOR_LEN;
    var ptr23 = passArrayF32ToWasm0(glass_normals, wasm.__wbindgen_malloc);
    var len23 = WASM_VECTOR_LEN;
    var ptr24 = passArrayF32ToWasm0(glass_colors, wasm.__wbindgen_malloc);
    var len24 = WASM_VECTOR_LEN;
    var ptr25 = passArrayF32ToWasm0(glass_tex_indices, wasm.__wbindgen_malloc);
    var len25 = WASM_VECTOR_LEN;
    var ptr26 = passArrayF32ToWasm0(glass_tex_rotations, wasm.__wbindgen_malloc);
    var len26 = WASM_VECTOR_LEN;
    var ptr27 = passArrayF32ToWasm0(glass_tint_types, wasm.__wbindgen_malloc);
    var len27 = WASM_VECTOR_LEN;
    var ptr28 = passArray8ToWasm0(glass_packed_light, wasm.__wbindgen_malloc);
    var len28 = WASM_VECTOR_LEN;
    var ptr29 = passArray32ToWasm0(glass_indices, wasm.__wbindgen_malloc);
    var len29 = WASM_VECTOR_LEN;
    const ret = wasm.write_mesh_to_buffers(ptr0, len0, solid_positions, ptr1, len1, solid_normals, ptr2, len2, solid_colors, ptr3, len3, solid_tex_indices, ptr4, len4, solid_tex_rotations, ptr5, len5, solid_tint_types, ptr6, len6, solid_packed_light, ptr7, len7, solid_indices, ptr8, len8, water_positions, ptr9, len9, water_normals, ptr10, len10, water_colors, ptr11, len11, water_uvs, ptr12, len12, water_tex_indices, ptr13, len13, water_packed_light, ptr14, len14, water_indices, ptr15, len15, lava_positions, ptr16, len16, lava_normals, ptr17, len17, lava_colors, ptr18, len18, lava_uvs, ptr19, len19, lava_tex_indices, ptr20, len20, lava_packed_light, ptr21, len21, lava_indices, ptr22, len22, glass_positions, ptr23, len23, glass_normals, ptr24, len24, glass_colors, ptr25, len25, glass_tex_indices, ptr26, len26, glass_tex_rotations, ptr27, len27, glass_tint_types, ptr28, len28, glass_packed_light, ptr29, len29, glass_indices);
    return ret !== 0;
}

/**
 * Write model mesh data to pre-allocated buffers
 * @param {Float32Array} opaque_positions
 * @param {Float32Array} opaque_normals
 * @param {Float32Array} opaque_colors
 * @param {Float32Array} opaque_uvs
 * @param {Float32Array} opaque_tex_indices
 * @param {Uint8Array} opaque_packed_light
 * @param {Uint32Array} opaque_indices
 * @param {Float32Array} transparent_positions
 * @param {Float32Array} transparent_normals
 * @param {Float32Array} transparent_colors
 * @param {Float32Array} transparent_uvs
 * @param {Float32Array} transparent_tex_indices
 * @param {Uint8Array} transparent_packed_light
 * @param {Uint32Array} transparent_indices
 * @returns {boolean}
 */
export function write_model_mesh_to_buffers(opaque_positions, opaque_normals, opaque_colors, opaque_uvs, opaque_tex_indices, opaque_packed_light, opaque_indices, transparent_positions, transparent_normals, transparent_colors, transparent_uvs, transparent_tex_indices, transparent_packed_light, transparent_indices) {
    var ptr0 = passArrayF32ToWasm0(opaque_positions, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(opaque_normals, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = passArrayF32ToWasm0(opaque_colors, wasm.__wbindgen_malloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = passArrayF32ToWasm0(opaque_uvs, wasm.__wbindgen_malloc);
    var len3 = WASM_VECTOR_LEN;
    var ptr4 = passArrayF32ToWasm0(opaque_tex_indices, wasm.__wbindgen_malloc);
    var len4 = WASM_VECTOR_LEN;
    var ptr5 = passArray8ToWasm0(opaque_packed_light, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    var ptr6 = passArray32ToWasm0(opaque_indices, wasm.__wbindgen_malloc);
    var len6 = WASM_VECTOR_LEN;
    var ptr7 = passArrayF32ToWasm0(transparent_positions, wasm.__wbindgen_malloc);
    var len7 = WASM_VECTOR_LEN;
    var ptr8 = passArrayF32ToWasm0(transparent_normals, wasm.__wbindgen_malloc);
    var len8 = WASM_VECTOR_LEN;
    var ptr9 = passArrayF32ToWasm0(transparent_colors, wasm.__wbindgen_malloc);
    var len9 = WASM_VECTOR_LEN;
    var ptr10 = passArrayF32ToWasm0(transparent_uvs, wasm.__wbindgen_malloc);
    var len10 = WASM_VECTOR_LEN;
    var ptr11 = passArrayF32ToWasm0(transparent_tex_indices, wasm.__wbindgen_malloc);
    var len11 = WASM_VECTOR_LEN;
    var ptr12 = passArray8ToWasm0(transparent_packed_light, wasm.__wbindgen_malloc);
    var len12 = WASM_VECTOR_LEN;
    var ptr13 = passArray32ToWasm0(transparent_indices, wasm.__wbindgen_malloc);
    var len13 = WASM_VECTOR_LEN;
    const ret = wasm.write_model_mesh_to_buffers(ptr0, len0, opaque_positions, ptr1, len1, opaque_normals, ptr2, len2, opaque_colors, ptr3, len3, opaque_uvs, ptr4, len4, opaque_tex_indices, ptr5, len5, opaque_packed_light, ptr6, len6, opaque_indices, ptr7, len7, transparent_positions, ptr8, len8, transparent_normals, ptr9, len9, transparent_colors, ptr10, len10, transparent_uvs, ptr11, len11, transparent_tex_indices, ptr12, len12, transparent_packed_light, ptr13, len13, transparent_indices);
    return ret !== 0;
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg___wbindgen_copy_to_typed_array_db832bc4df7216c1 = function(arg0, arg1, arg2) {
        new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg___wbindgen_string_get_a2a31e16edf96e42 = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_log_1d990106d99dacb7 = function(arg0) {
        console.log(arg0);
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedBigUint64ArrayMemory0 = null;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('wasm_mesher_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
