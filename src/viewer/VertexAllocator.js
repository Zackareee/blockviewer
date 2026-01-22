/**
 * VertexAllocator - Free-list allocator for vertex slots in DataTextures
 * 
 * Manages allocation of contiguous vertex ranges in a fixed-size texture.
 * Uses a free-list algorithm to handle allocation and deallocation efficiently.
 * 
 * For DataTexture rendering, we need to pack vertices from multiple super-chunks
 * into a single large texture. This allocator tracks which slots are free/used.
 */

/**
 * A free block in the allocator
 */
class FreeBlock {
  constructor(offset, size) {
    this.offset = offset;
    this.size = size;
  }
}

/**
 * VertexAllocator - Manages vertex slot allocation in DataTextures
 */
export class VertexAllocator {
  /**
   * @param {number} maxVertices - Maximum number of vertices the texture can hold
   */
  constructor(maxVertices) {
    this.maxVertices = maxVertices;
    this.usedVertices = 0;
    
    // Free list sorted by offset
    // Start with one big free block covering the whole texture
    this.freeList = [new FreeBlock(0, maxVertices)];
    
    // Track allocations: objectId -> { offset, count }
    this.allocations = new Map();
    
    // Next object ID
    this.nextObjectId = 1;
    
    // Stats
    this.totalAllocations = 0;
    this.totalDeallocations = 0;
    this.fragmentedBlocks = 0;
  }
  
  /**
   * Allocate a contiguous range of vertices
   * Uses first-fit algorithm for simplicity
   * 
   * @param {number} count - Number of vertices to allocate
   * @returns {number|null} - Object ID if successful, null if no space
   */
  allocate(count) {
    if (count <= 0) return null;
    
    // Find first free block that fits
    for (let i = 0; i < this.freeList.length; i++) {
      const block = this.freeList[i];
      
      if (block.size >= count) {
        const offset = block.offset;
        const objectId = this.nextObjectId++;
        
        // Update or remove the free block
        if (block.size === count) {
          // Exact fit - remove the block
          this.freeList.splice(i, 1);
        } else {
          // Split the block
          block.offset += count;
          block.size -= count;
        }
        
        // Track the allocation
        this.allocations.set(objectId, { offset, count });
        this.usedVertices += count;
        this.totalAllocations++;
        
        return objectId;
      }
    }
    
    // No space found
    return null;
  }
  
  /**
   * Free a previously allocated range
   * 
   * @param {number} objectId - Object ID returned from allocate()
   * @returns {boolean} - True if freed successfully
   */
  free(objectId) {
    const allocation = this.allocations.get(objectId);
    if (!allocation) return false;
    
    const { offset, count } = allocation;
    this.allocations.delete(objectId);
    this.usedVertices -= count;
    this.totalDeallocations++;
    
    // Insert back into free list and merge adjacent blocks
    this._insertFreeBlock(offset, count);
    
    return true;
  }
  
  /**
   * Insert a free block and merge with adjacent blocks
   */
  _insertFreeBlock(offset, size) {
    // Find insertion point (keep sorted by offset)
    let insertIdx = 0;
    while (insertIdx < this.freeList.length && this.freeList[insertIdx].offset < offset) {
      insertIdx++;
    }
    
    // Check if we can merge with previous block
    let merged = false;
    if (insertIdx > 0) {
      const prev = this.freeList[insertIdx - 1];
      if (prev.offset + prev.size === offset) {
        // Merge with previous
        prev.size += size;
        merged = true;
        
        // Check if we can also merge with next
        if (insertIdx < this.freeList.length) {
          const next = this.freeList[insertIdx];
          if (prev.offset + prev.size === next.offset) {
            prev.size += next.size;
            this.freeList.splice(insertIdx, 1);
          }
        }
      }
    }
    
    if (!merged) {
      // Check if we can merge with next block
      if (insertIdx < this.freeList.length) {
        const next = this.freeList[insertIdx];
        if (offset + size === next.offset) {
          next.offset = offset;
          next.size += size;
          merged = true;
        }
      }
    }
    
    if (!merged) {
      // Insert new block
      this.freeList.splice(insertIdx, 0, new FreeBlock(offset, size));
    }
    
    this.fragmentedBlocks = this.freeList.length;
  }
  
  /**
   * Get allocation info for an object
   * 
   * @param {number} objectId - Object ID
   * @returns {{ offset: number, count: number }|null}
   */
  getAllocation(objectId) {
    return this.allocations.get(objectId) || null;
  }
  
  /**
   * Check if there's enough space for an allocation
   * 
   * @param {number} count - Number of vertices needed
   * @returns {boolean}
   */
  canAllocate(count) {
    for (const block of this.freeList) {
      if (block.size >= count) return true;
    }
    return false;
  }
  
  /**
   * Get the largest contiguous free block size
   * 
   * @returns {number}
   */
  getLargestFreeBlock() {
    let largest = 0;
    for (const block of this.freeList) {
      if (block.size > largest) largest = block.size;
    }
    return largest;
  }
  
  /**
   * Calculate fragmentation ratio (0 = no fragmentation, 1 = fully fragmented)
   * 
   * @returns {number}
   */
  getFragmentationRatio() {
    const freeSpace = this.maxVertices - this.usedVertices;
    if (freeSpace === 0) return 0;
    
    const largestBlock = this.getLargestFreeBlock();
    return 1 - (largestBlock / freeSpace);
  }
  
  /**
   * Get allocation statistics
   * 
   * @returns {Object}
   */
  getStats() {
    return {
      maxVertices: this.maxVertices,
      usedVertices: this.usedVertices,
      freeVertices: this.maxVertices - this.usedVertices,
      utilizationPercent: ((this.usedVertices / this.maxVertices) * 100).toFixed(1),
      allocations: this.allocations.size,
      freeBlocks: this.freeList.length,
      largestFreeBlock: this.getLargestFreeBlock(),
      fragmentationRatio: this.getFragmentationRatio().toFixed(3),
      totalAllocations: this.totalAllocations,
      totalDeallocations: this.totalDeallocations,
    };
  }
  
  /**
   * Defragment by compacting all allocations to the beginning
   * Returns a map of objectId -> { oldOffset, newOffset, count }
   * Caller must update textures accordingly
   * 
   * @returns {Map<number, { oldOffset: number, newOffset: number, count: number }>}
   */
  defragment() {
    const moves = new Map();
    
    // Sort allocations by current offset
    const sortedAllocations = [...this.allocations.entries()]
      .sort((a, b) => a[1].offset - b[1].offset);
    
    let nextOffset = 0;
    
    for (const [objectId, alloc] of sortedAllocations) {
      if (alloc.offset !== nextOffset) {
        // Need to move this allocation
        moves.set(objectId, {
          oldOffset: alloc.offset,
          newOffset: nextOffset,
          count: alloc.count,
        });
        alloc.offset = nextOffset;
      }
      nextOffset += alloc.count;
    }
    
    // Rebuild free list - now just one big block at the end
    if (nextOffset < this.maxVertices) {
      this.freeList = [new FreeBlock(nextOffset, this.maxVertices - nextOffset)];
    } else {
      this.freeList = [];
    }
    
    this.fragmentedBlocks = this.freeList.length;
    
    return moves;
  }
  
  /**
   * Reset the allocator to initial state
   */
  reset() {
    this.freeList = [new FreeBlock(0, this.maxVertices)];
    this.allocations.clear();
    this.usedVertices = 0;
    this.totalAllocations = 0;
    this.totalDeallocations = 0;
    this.fragmentedBlocks = 0;
    this.nextObjectId = 1;
  }
}
