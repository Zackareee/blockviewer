import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import ChunkViewer from './components/ChunkViewer';
import { RegionViewer } from './viewer';
import { parseMCAFile, extractBlocks } from './utils/mcaParser';
import { getCollisionWorkerManager, CollisionSet } from './utils/collisionWorkerManager';
import './App.css';

// Build collision world from blocks with Y filtering (uses optimized CollisionSet)
function buildCollisionSet(blocks, filterMinY = -64, filterMaxY = 320) {
  const world = new CollisionSet();
  for (const block of blocks) {
    const y = Math.floor(block.y);
    if (y >= filterMinY && y <= filterMaxY) {
      world.add(Math.floor(block.x), y, Math.floor(block.z));
    }
  }
  return world;
}

// Helper to get Y range without stack overflow for large arrays
function getYRange(blocks) {
  if (blocks.length === 0) return { min: -64, max: 320 };
  
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < blocks.length; i++) {
    const y = blocks[i].y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  
  return { 
    min: min === Infinity ? -64 : min, 
    max: max === -Infinity ? 320 : max 
  };
}

function App() {
  const [chunks, setChunks] = useState([]);
  const [selectedChunkIndices, setSelectedChunkIndices] = useState(new Set([0])); // Support multiple selection
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  
  // View mode: 'chunk' or 'region'
  const [viewMode, setViewMode] = useState('chunk');
  
  // Region data - chunks with their blocks kept separate
  const [regionChunkData, setRegionChunkData] = useState(null);
  
  // Chunk data for multi-chunk view (similar to region but for selected chunks)
  const [chunkViewData, setChunkViewData] = useState(null);
  
  // Layer slicing controls
  const [minY, setMinY] = useState(-64);
  const [maxY, setMaxY] = useState(320);
  const [autoRotate, setAutoRotate] = useState(false);
  
  // Build progress for region rendering
  const [buildProgress, setBuildProgress] = useState({ current: 0, total: 0, isBuilding: false, message: '' });
  
  // Streaming region loading state
  const [streamingState, setStreamingState] = useState({
    isStreaming: false,
    currentRegionIndex: 0,
    totalRegions: 0,
    currentRegionName: ''
  });
  
  // Camera mode: 'freecam' or 'walk'
  const [cameraMode, setCameraMode] = useState('freecam');
  
  // Collision world for walking mode
  const [collisionWorld, setCollisionWorld] = useState(null);
  const [collisionCenter, setCollisionCenter] = useState({ x: 0, y: 0, z: 0 });
  
  // Player position for display
  const [playerPosition, setPlayerPosition] = useState(null);
  
  // Walk mode FOV (field of view)
  const [walkFov, setWalkFov] = useState(70);
  
  // Sprint state for FOV effect
  const [isSprinting, setIsSprinting] = useState(false);
  
  // Drag painting state for chunk selection
  const [isDragging, setIsDragging] = useState(false);
  const [dragMode, setDragMode] = useState(null); // 'add' or 'remove'
  const dragSelectionRef = useRef(new Set());
  
  // Viewer engine: 'classic' or 'new' (high-performance)
  const [viewerEngine, setViewerEngine] = useState('new');
  
  // Region files for progressive loading (new viewer multi-region)
  const [regionFiles, setRegionFiles] = useState([]);
  
  // Y-slider drag state
  const [ySliderDragging, setYSliderDragging] = useState(null); // 'min' | 'max' | null
  const ySliderTrackRef = useRef(null);
  
  const handleBuildProgress = useCallback((current, total, isBuilding, message = '') => {
    setBuildProgress({ current, total, isBuilding, message });
  }, []);

  // Handle streaming progress updates from ChunkedRegion
  const handleStreamingProgress = useCallback((currentRegionIndex, totalRegions, currentRegionName) => {
    setStreamingState({
      isStreaming: currentRegionIndex < totalRegions,
      currentRegionIndex,
      totalRegions,
      currentRegionName
    });
  }, []);

  // Track the Y range used for the last collision build to avoid unnecessary rebuilds
  const lastCollisionYRangeRef = useRef({ minY: null, maxY: null });
  const collisionRebuildTimeoutRef = useRef(null);
  
  // Store chunk refs for dynamic collision building
  const [collisionChunkRefs, setCollisionChunkRefs] = useState(null);
  
  // Track player's current chunk for collision rebuilding
  const [playerChunk, setPlayerChunk] = useState({ x: 0, z: 0 });
  const lastPlayerChunkRef = useRef({ x: 0, z: 0 });
  const collisionBuildInProgress = useRef(false);
  const pendingChunkChange = useRef(null);
  const chunkChangeTimeoutRef = useRef(null);
  
  // Player velocity for prefetching (reported by FirstPersonControls)
  const playerVelocityRef = useRef({ x: 0, z: 0 });
  
  // Collision radius in chunks (4 chunks = 64 blocks in each direction for safety)
  const COLLISION_RADIUS_CHUNKS = 4;
  
  // Get collision worker manager
  const collisionManagerRef = useRef(null);
  if (!collisionManagerRef.current) {
    collisionManagerRef.current = getCollisionWorkerManager();
  }

  // Build localized collision world around a position using web worker (non-blocking)
  const buildLocalCollisionWorld = useCallback(async (chunkRefs, center, playerX, playerZ, filterMinY, filterMaxY, showProgress = true) => {
    const manager = collisionManagerRef.current;
    if (!manager) return new Set();
    
    console.log(`=== Building Local Collision World (Worker) ===`);
    console.log(`Center: (${center.x}, ${center.z})`);
    console.log(`Player mesh pos: (${playerX.toFixed(1)}, ${playerZ.toFixed(1)})`);
    
    if (showProgress) {
      setBuildProgress({ current: 0, total: 1, isBuilding: true, message: 'Building collision...' });
    }
    
    try {
      // Use the collision worker manager - this runs off the main thread
      const world = await manager.buildLocalCollision(
        chunkRefs,
        center,
        playerX,
        playerZ,
        filterMinY,
        filterMaxY,
        COLLISION_RADIUS_CHUNKS
      );
      
      console.log(`Built local collision with ${world.size} blocks (off-thread)`);
      return world;
    } catch (e) {
      console.error('Failed to build collision:', e);
      return new Set();
    }
  }, []);

  // Handle player chunk change - rebuild collision around new position (async, non-blocking)
  // Uses debouncing to prevent rapid rebuilds when moving quickly
  const handlePlayerChunkChange = useCallback((newChunkX, newChunkZ, playerX, playerZ) => {
    // Store the latest chunk change request
    pendingChunkChange.current = { newChunkX, newChunkZ, playerX, playerZ };
    
    // If already building, the pending change will be picked up after current build
    if (collisionBuildInProgress.current) return;
    
    // Debounce: wait a short time before building to batch rapid movements
    if (chunkChangeTimeoutRef.current) {
      clearTimeout(chunkChangeTimeoutRef.current);
    }
    
    chunkChangeTimeoutRef.current = setTimeout(async () => {
      const pending = pendingChunkChange.current;
      if (!pending) return;
      
      const { newChunkX: chunkX, newChunkZ: chunkZ, playerX: pX, playerZ: pZ } = pending;
      pendingChunkChange.current = null;
      
      // Check if chunk actually changed
      if (chunkX === lastPlayerChunkRef.current.x && chunkZ === lastPlayerChunkRef.current.z) {
        return;
      }
      
      lastPlayerChunkRef.current = { x: chunkX, z: chunkZ };
      setPlayerChunk({ x: chunkX, z: chunkZ });
      
      if (!collisionChunkRefs || collisionChunkRefs.length === 0) return;
      
      collisionBuildInProgress.current = true;
      
      try {
        // Build collision in worker (non-blocking)
        const world = await buildLocalCollisionWorld(
          collisionChunkRefs,
          collisionCenter,
          pX,
          pZ,
          minY,
          maxY,
          false // Don't show progress for dynamic rebuilds
        );
        
        setCollisionWorld(world);
        
        // Trigger prefetch in movement direction (non-blocking, fire-and-forget)
        const manager = collisionManagerRef.current;
        if (manager) {
          manager.prefetchInDirection(
            collisionChunkRefs,
            collisionCenter,
            pX,
            pZ,
            playerVelocityRef.current.x,
            playerVelocityRef.current.z,
            minY,
            maxY,
            2 // Look 2 chunks ahead
          );
        }
      } finally {
        collisionBuildInProgress.current = false;
        setBuildProgress({ current: 0, total: 0, isBuilding: false, message: '' });
        
        // Check if another chunk change happened while we were building
        if (pendingChunkChange.current) {
          const next = pendingChunkChange.current;
          handlePlayerChunkChange(next.newChunkX, next.newChunkZ, next.playerX, next.playerZ);
        }
      }
    }, 16); // ~1 frame delay to batch rapid movements
  }, [collisionChunkRefs, collisionCenter, minY, maxY, buildLocalCollisionWorld]);

  // Handle player velocity updates (for prefetching)
  const handlePlayerVelocity = useCallback((velocityX, velocityZ) => {
    playerVelocityRef.current = { x: velocityX, z: velocityZ };
  }, []);

  // Handle camera mode change
  const handleCameraModeChange = useCallback(async (mode) => {
    if (mode === cameraMode) return;
    
    if (mode === 'walk') {
      // Build collision world for walking (async, localized around spawn)
      let world = null;
      let center = { x: 0, y: 64, z: 0 };
      let chunkRefs = null;
      
      if (viewMode === 'region' && regionChunkData) {
        setBuildProgress({ current: 0, total: 1, isBuilding: true, message: 'Building collision...' });
        center = regionChunkData.center;
        chunkRefs = regionChunkData.chunkRefs;
        
        // Build localized collision around spawn (0, 0 in mesh space)
        world = await buildLocalCollisionWorld(
          chunkRefs,
          center,
          0, // playerX at spawn
          0, // playerZ at spawn
          minY,
          maxY,
          true
        );
        
        setBuildProgress({ current: 0, total: 0, isBuilding: false, message: '' });
      } else if (chunkViewData) {
        setBuildProgress({ current: 0, total: 1, isBuilding: true, message: 'Building collision...' });
        center = chunkViewData.center;
        chunkRefs = chunkViewData.chunkRefs;
        
        // Build localized collision around spawn
        world = await buildLocalCollisionWorld(
          chunkRefs,
          center,
          0,
          0,
          minY,
          maxY,
          true
        );
        
        setBuildProgress({ current: 0, total: 0, isBuilding: false, message: '' });
      } else if (blocks.length > 0) {
        // Single chunk view - fast enough to do synchronously
        world = buildCollisionSet(blocks, minY, maxY);
        // Calculate center from blocks
        let minX = Infinity, maxX = -Infinity;
        let minYBlock = Infinity, maxYBlock = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const b of blocks) {
          if (b.x < minX) minX = b.x;
          if (b.x > maxX) maxX = b.x;
          if (b.y < minYBlock) minYBlock = b.y;
          if (b.y > maxYBlock) maxYBlock = b.y;
          if (b.z < minZ) minZ = b.z;
          if (b.z > maxZ) maxZ = b.z;
        }
        center = {
          x: (minX + maxX) / 2,
          y: (minYBlock + maxYBlock) / 2,
          z: (minZ + maxZ) / 2
        };
        chunkRefs = null; // No dynamic updates for single chunk
      }
      
      if (!world || world.size === 0) {
        console.error('Failed to build collision world! viewMode:', viewMode, 'regionChunkData:', !!regionChunkData, 'chunkViewData:', !!chunkViewData, 'blocks:', blocks.length);
        return; // Don't switch to walk mode without collision
      }
      
      // Set collision data and mode together in same render
      console.log('=== Setting Collision State ===');
      console.log('Collision world size:', world.size);
      console.log('Collision center being set:', JSON.stringify(center));
      setCollisionWorld(world);
      setCollisionCenter(center);
      setCollisionChunkRefs(chunkRefs); // Store for dynamic rebuilding
      lastCollisionYRangeRef.current = { minY, maxY }; // Track what we built
      lastPlayerChunkRef.current = { x: 0, z: 0 }; // Reset chunk tracking
      setCameraMode(mode);
    } else {
      setPlayerPosition(null);
      setCollisionChunkRefs(null);
      setIsSprinting(false); // Reset sprint state
      setCameraMode(mode);
      // Clear collision cache when exiting walk mode
      collisionManagerRef.current?.clearCache();
    }
  }, [cameraMode, viewMode, regionChunkData, chunkViewData, blocks, minY, maxY, buildLocalCollisionWorld]);

  // Rebuild collision world when Y range changes while in walk mode (debounced)
  useEffect(() => {
    // Only rebuild if in walk mode
    if (cameraMode !== 'walk') return;
    
    // Check if Y range actually changed from what we last built
    if (lastCollisionYRangeRef.current.minY === minY && 
        lastCollisionYRangeRef.current.maxY === maxY) {
      return; // No change, don't rebuild
    }
    
    // Clear any pending rebuild
    if (collisionRebuildTimeoutRef.current) {
      clearTimeout(collisionRebuildTimeoutRef.current);
    }
    
    // Debounce the rebuild by 500ms
    collisionRebuildTimeoutRef.current = setTimeout(async () => {
      console.log('Rebuilding collision for Y range change:', minY, 'to', maxY);
      
      if (!collisionChunkRefs || collisionChunkRefs.length === 0) return;
      
      setBuildProgress({ current: 0, total: 1, isBuilding: true, message: 'Rebuilding collision...' });
      
      // Get player position for localized rebuild
      const playerX = playerPosition?.x ? playerPosition.x - collisionCenter.x : 0;
      const playerZ = playerPosition?.z ? playerPosition.z - collisionCenter.z : 0;
      
      const world = await buildLocalCollisionWorld(
        collisionChunkRefs,
        collisionCenter,
        playerX,
        playerZ,
        minY,
        maxY,
        true
      );
      
      setBuildProgress({ current: 0, total: 0, isBuilding: false, message: '' });
      setCollisionWorld(world);
      lastCollisionYRangeRef.current = { minY, maxY };
    }, 500);
    
    return () => {
      if (collisionRebuildTimeoutRef.current) {
        clearTimeout(collisionRebuildTimeoutRef.current);
      }
      if (chunkChangeTimeoutRef.current) {
        clearTimeout(chunkChangeTimeoutRef.current);
      }
    };
  }, [minY, maxY, cameraMode, collisionChunkRefs, collisionCenter, playerPosition, buildLocalCollisionWorld]);

  const handlePlayerPosition = useCallback((pos) => {
    setPlayerPosition(pos);
  }, []);

  // Handle sprint state change for FOV effect
  const handlePlayerSprint = useCallback((sprinting) => {
    setIsSprinting(sprinting);
  }, []);

  // Calculate effective FOV (10% increase when sprinting)
  const effectiveFov = useMemo(() => {
    return isSprinting ? walkFov * 1.1 : walkFov;
  }, [walkFov, isSprinting]);

  // Calculate actual Y range from blocks (capped at 320 max for slider)
  // Use loop instead of spread to avoid stack overflow with large arrays
  const yRange = useMemo(() => {
    if (blocks.length === 0) return { min: -64, max: 320 };
    
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < blocks.length; i++) {
      const y = blocks[i].y;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    
    return {
      min: min === Infinity ? -64 : min,
      max: max === -Infinity ? 320 : Math.min(320, max)
    };
  }, [blocks]);

  // Parse region coordinates from filename (e.g., "r.-1.2.mca" -> { x: -1, z: 2 })
  const parseRegionCoords = useCallback((filename) => {
    const match = filename.match(/r\.(-?\d+)\.(-?\d+)\.mca$/i);
    if (match) {
      return { x: parseInt(match[1], 10), z: parseInt(match[2], 10) };
    }
    return { x: 0, z: 0 }; // Default if pattern doesn't match
  }, []);

  // Prepare region data - keeps raw chunk data, extracts blocks lazily
  // Now supports chunks from multiple region files with world coordinates
  const prepareRegionData = useCallback((allChunks) => {
    console.log(`Preparing ${allChunks.length} chunks for lazy extraction...`);
    
    // Find min/max chunk coordinates (these are already world coordinates)
    let minChunkX = Infinity, maxChunkX = -Infinity;
    let minChunkZ = Infinity, maxChunkZ = -Infinity;
    
    for (let i = 0; i < allChunks.length; i++) {
      if (allChunks[i].x < minChunkX) minChunkX = allChunks[i].x;
      if (allChunks[i].x > maxChunkX) maxChunkX = allChunks[i].x;
      if (allChunks[i].z < minChunkZ) minChunkZ = allChunks[i].z;
      if (allChunks[i].z > maxChunkZ) maxChunkZ = allChunks[i].z;
    }
    
    // Store raw chunk references (not extracted blocks) for lazy loading
    // Normalize chunk coordinates relative to the minimum
    const chunkRefs = allChunks.map(chunk => ({
      chunkX: chunk.x - minChunkX,
      chunkZ: chunk.z - minChunkZ,
      rawData: chunk // Keep raw chunk data for lazy extraction
    }));
    
    // Calculate region center (based on actual chunk bounds)
    const centerX = ((maxChunkX - minChunkX + 1) * 16) / 2;
    const centerZ = ((maxChunkZ - minChunkZ + 1) * 16) / 2;
    const centerY = 64; // Default center Y
    
    console.log(`Prepared ${chunkRefs.length} chunk references spanning chunks (${minChunkX},${minChunkZ}) to (${maxChunkX},${maxChunkZ})`);
    
    return {
      chunkRefs,
      totalChunks: chunkRefs.length,
      center: { x: centerX, y: centerY, z: centerZ },
      yRange: { min: -64, max: 320 } // Default range, will be refined
    };
  }, []);

  // Core file processing logic (shared between load and add)
  const processRegionFiles = useCallback(async (files, isAddMode = false) => {
    if (files.length === 0) return;

    setLoading(true);
    setError(null);
    
    // Display filename(s)
    const existingCount = isAddMode ? regionFiles.length : 0;
    if (files.length === 1) {
      setFileName(isAddMode ? `${existingCount + 1} region files` : files[0].name);
    } else {
      setFileName(`${existingCount + files.length} region files`);
    }

    try {
      // For new viewer: use progressive loading
      // For classic viewer with 3+ files: use streaming
      const totalFiles = isAddMode ? existingCount + files.length : files.length;
      const useProgressiveLoading = totalFiles > 1 && viewerEngine === 'new';
      const useStreaming = totalFiles >= 3 && viewerEngine === 'classic';
      
      if (useProgressiveLoading) {
        // New viewer progressive loading - defer parsing to RegionViewer
        console.log(`${isAddMode ? 'Adding' : 'Loading'} ${files.length} regions for progressive loading...`);
        
        const newRegionInfos = files.map(file => {
          const regionCoords = parseRegionCoords(file.name);
          return {
            file,
            regionX: regionCoords.x,
            regionZ: regionCoords.z,
          };
        });
        
        // Filter out duplicates (same region coordinates)
        const existingKeys = new Set(regionFiles.map(r => `${r.regionX},${r.regionZ}`));
        const uniqueNewRegions = newRegionInfos.filter(r => !existingKeys.has(`${r.regionX},${r.regionZ}`));
        
        if (uniqueNewRegions.length < newRegionInfos.length) {
          console.log(`Skipped ${newRegionInfos.length - uniqueNewRegions.length} duplicate regions`);
        }
        
        if (isAddMode) {
          // Append to existing regions
          setRegionFiles(prev => [...prev, ...uniqueNewRegions]);
        } else {
          // Replace all regions
          setRegionFiles(uniqueNewRegions);
          setChunks([]); // Clear chunks - RegionViewer will load progressively
        }
        
        setViewMode('region');
        setBlocks([]);
        setRegionChunkData(null);
        setMinY(-64);
        setMaxY(320);
        setLoading(false);
        return;
        
      } else if (useStreaming) {
        console.log(`Streaming ${files.length} region files to avoid memory issues...`);
        
        setStreamingState({
          isStreaming: true,
          currentRegionIndex: 0,
          totalRegions: files.length,
          currentRegionName: files[0].name
        });
        
        // We'll process regions one at a time and build meshes incrementally
        // First, compute the overall chunk bounds by reading headers only
        const regionMetas = [];
        for (const file of files) {
          const regionCoords = parseRegionCoords(file.name);
          regionMetas.push({
            file,
            regionX: regionCoords.x,
            regionZ: regionCoords.z,
            chunkOffsetX: regionCoords.x * 32,
            chunkOffsetZ: regionCoords.z * 32
          });
        }
        
        // Calculate bounds from region coordinates (each region is 32x32 chunks)
        let minChunkX = Infinity, maxChunkX = -Infinity;
        let minChunkZ = Infinity, maxChunkZ = -Infinity;
        for (const meta of regionMetas) {
          const startX = meta.regionX * 32;
          const startZ = meta.regionZ * 32;
          const endX = startX + 31;
          const endZ = startZ + 31;
          if (startX < minChunkX) minChunkX = startX;
          if (endX > maxChunkX) maxChunkX = endX;
          if (startZ < minChunkZ) minChunkZ = startZ;
          if (endZ > maxChunkZ) maxChunkZ = endZ;
        }
        
        // Calculate region center
        const centerX = ((maxChunkX - minChunkX + 1) * 16) / 2;
        const centerZ = ((maxChunkZ - minChunkZ + 1) * 16) / 2;
        const centerY = 64;
        
        // Prepare streaming region data - files to process, no raw data loaded yet
        const streamingRegionData = {
          regionFiles: regionMetas,
          chunkRefs: [], // Will be populated as we stream
          totalChunks: 0, // Will be updated
          center: { x: centerX, y: centerY, z: centerZ },
          yRange: { min: -64, max: 320 },
          minChunkX,
          minChunkZ,
          isStreaming: true,
          currentRegionIndex: 0
        };
        
        setViewMode('region');
        setRegionChunkData(streamingRegionData);
        setChunks([]);
        setRegionFiles([]); // Clear progressive loading state
        setSelectedChunkIndices(new Set());
        setChunkViewData(null);
        setBlocks([]);
        setMinY(-64);
        setMaxY(320);
        
      } else {
        // Load all files in parallel into memory
        // For fast viewer or small file counts, this gives better performance
        if (files.length >= 3) {
          console.log(`Loading ${files.length} region files in parallel for fast renderer...`);
        }
        
        const allChunks = [];
        
        for (const file of files) {
          // Parse region coordinates from filename
          const regionCoords = parseRegionCoords(file.name);
          
          // Each region contains 32x32 chunks, so chunk offset is region * 32
          const chunkOffsetX = regionCoords.x * 32;
          const chunkOffsetZ = regionCoords.z * 32;
          
          console.log(`Parsing ${file.name} (region ${regionCoords.x}, ${regionCoords.z}) with chunk offset (${chunkOffsetX}, ${chunkOffsetZ})`);
          
          const parsedChunks = await parseMCAFile(file);
          
          // Add world coordinate offset to each chunk
          for (const chunk of parsedChunks) {
            // The chunk's x/z are local to the region (0-31), add world offset
            allChunks.push({
              ...chunk,
              x: chunk.x + chunkOffsetX,
              z: chunk.z + chunkOffsetZ
            });
          }
        }
        
        if (allChunks.length === 0) {
          throw new Error('No chunks found in file(s)');
        }

        console.log(`Total chunks loaded: ${allChunks.length} from ${files.length} region file(s)`);

        setChunks(allChunks);
        setRegionFiles([]); // Clear progressive loading state
        setSelectedChunkIndices(new Set([0]));
        setChunkViewData(null);
        
        // If multiple files, default to region view
        if (files.length > 1) {
          setViewMode('region');
          const regionData = prepareRegionData(allChunks);
          setRegionChunkData(regionData);
          setBlocks([]);
          setMinY(regionData.yRange.min);
          setMaxY(Math.min(320, regionData.yRange.max));
        } else {
          setViewMode('chunk');
          // Extract blocks from first chunk
          const firstChunkBlocks = extractBlocks(allChunks[0]);
          setBlocks(firstChunkBlocks);
          
          // Reset Y range to show all blocks (capped at 320)
          if (firstChunkBlocks.length > 0) {
            const { min, max } = getYRange(firstChunkBlocks);
            setMinY(min);
            setMaxY(Math.min(320, max));
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse file:', e);
      setError(e.message);
      setStreamingState({ isStreaming: false, currentRegionIndex: 0, totalRegions: 0, currentRegionName: '' });
    } finally {
      setLoading(false);
    }
  }, [parseRegionCoords, prepareRegionData, regionFiles, viewerEngine]);

  // Handle file upload (replace existing)
  const handleFileUpload = useCallback(async (event) => {
    const files = Array.from(event.target.files);
    await processRegionFiles(files, false);
    // Reset file input so same file can be selected again
    event.target.value = '';
  }, [processRegionFiles]);

  // Handle adding region files (append to existing)
  const handleAddRegionFiles = useCallback(async (event) => {
    const files = Array.from(event.target.files);
    await processRegionFiles(files, true);
    // Reset file input so same file can be selected again
    event.target.value = '';
  }, [processRegionFiles]);

  // Prepare chunk view data for multiple selected chunks (similar to region data)
  const prepareChunkViewData = useCallback((selectedChunks) => {
    if (selectedChunks.length === 0) return null;
    
    // Find min/max chunk coordinates for centering
    let minChunkX = Infinity, maxChunkX = -Infinity;
    let minChunkZ = Infinity, maxChunkZ = -Infinity;
    
    for (const chunk of selectedChunks) {
      if (chunk.x < minChunkX) minChunkX = chunk.x;
      if (chunk.x > maxChunkX) maxChunkX = chunk.x;
      if (chunk.z < minChunkZ) minChunkZ = chunk.z;
      if (chunk.z > maxChunkZ) maxChunkZ = chunk.z;
    }
    
    // Create chunk refs with normalized coordinates
    const chunkRefs = selectedChunks.map(chunk => ({
      chunkX: chunk.x - minChunkX,
      chunkZ: chunk.z - minChunkZ,
      rawData: chunk
    }));
    
    // Calculate center
    const centerX = ((maxChunkX - minChunkX + 1) * 16) / 2;
    const centerZ = ((maxChunkZ - minChunkZ + 1) * 16) / 2;
    const centerY = 64;
    
    return {
      chunkRefs,
      totalChunks: chunkRefs.length,
      center: { x: centerX, y: centerY, z: centerZ },
      yRange: { min: -64, max: 320 }
    };
  }, []);

  const handleChunkSelect = useCallback((index, event) => {
    if (index < 0 || index >= chunks.length) return;
    
    setViewMode('chunk');
    
    let newSelection;
    if (event?.ctrlKey || event?.metaKey) {
      // Ctrl/Cmd click: toggle selection
      newSelection = new Set(selectedChunkIndices);
      if (newSelection.has(index)) {
        newSelection.delete(index);
        // Ensure at least one chunk is selected
        if (newSelection.size === 0) {
          newSelection.add(index);
        }
      } else {
        newSelection.add(index);
      }
    } else if (event?.shiftKey && selectedChunkIndices.size > 0) {
      // Shift click: range selection
      const lastSelected = Math.max(...selectedChunkIndices);
      const start = Math.min(lastSelected, index);
      const end = Math.max(lastSelected, index);
      newSelection = new Set(selectedChunkIndices);
      for (let i = start; i <= end; i++) {
        newSelection.add(i);
      }
    } else {
      // Normal click: single selection
      newSelection = new Set([index]);
    }
    
    setSelectedChunkIndices(newSelection);
    
    // Get selected chunks
    const selectedChunks = Array.from(newSelection).map(i => chunks[i]).filter(Boolean);
    
    if (selectedChunks.length === 1) {
      // Single chunk: extract blocks directly
      const chunkBlocks = extractBlocks(selectedChunks[0]);
      setBlocks(chunkBlocks);
      setChunkViewData(null);
      
      if (chunkBlocks.length > 0) {
        const { min, max } = getYRange(chunkBlocks);
        setMinY(min);
        setMaxY(Math.min(320, max));
      }
    } else {
      // Multiple chunks: prepare chunk view data (similar to region)
      const viewData = prepareChunkViewData(selectedChunks);
      setChunkViewData(viewData);
      setBlocks([]);
      setMinY(-64);
      setMaxY(320);
    }
  }, [chunks, selectedChunkIndices, prepareChunkViewData]);

  // Drag painting handlers for chunk selection
  const handleDragStart = useCallback((index) => {
    const isCurrentlySelected = selectedChunkIndices.has(index);
    setIsDragging(true);
    setDragMode(isCurrentlySelected ? 'remove' : 'add');
    dragSelectionRef.current = new Set(selectedChunkIndices);
    
    // Toggle the initial cell
    if (isCurrentlySelected) {
      dragSelectionRef.current.delete(index);
    } else {
      dragSelectionRef.current.add(index);
    }
    setSelectedChunkIndices(new Set(dragSelectionRef.current));
  }, [selectedChunkIndices]);

  const handleDragEnter = useCallback((index) => {
    if (!isDragging) return;
    
    if (dragMode === 'add') {
      dragSelectionRef.current.add(index);
    } else {
      dragSelectionRef.current.delete(index);
    }
    setSelectedChunkIndices(new Set(dragSelectionRef.current));
  }, [isDragging, dragMode]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    
    setIsDragging(false);
    setDragMode(null);
    
    // Update the view based on final selection
    const selectedChunks = Array.from(dragSelectionRef.current).map(i => chunks[i]).filter(Boolean);
    
    // Ensure at least one chunk is selected
    if (selectedChunks.length === 0 && chunks.length > 0) {
      setSelectedChunkIndices(new Set([0]));
      const chunkBlocks = extractBlocks(chunks[0]);
      setBlocks(chunkBlocks);
      setChunkViewData(null);
      return;
    }
    
    if (selectedChunks.length === 1) {
      const chunkBlocks = extractBlocks(selectedChunks[0]);
      setBlocks(chunkBlocks);
      setChunkViewData(null);
      
      if (chunkBlocks.length > 0) {
        const { min, max } = getYRange(chunkBlocks);
        setMinY(min);
        setMaxY(Math.min(320, max));
      }
    } else if (selectedChunks.length > 1) {
      const viewData = prepareChunkViewData(selectedChunks);
      setChunkViewData(viewData);
      setBlocks([]);
      setMinY(-64);
      setMaxY(320);
    }
  }, [isDragging, chunks, prepareChunkViewData]);

  // Global mouse up listener to end drag even outside the grid
  useEffect(() => {
    const handleMouseUp = () => {
      if (isDragging) {
        handleDragEnd();
      }
    };
    
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [isDragging, handleDragEnd]);

  // Y-slider handlers
  const handleYSliderMouseDown = useCallback((handle, e) => {
    e.preventDefault();
    setYSliderDragging(handle);
  }, []);

  const handleYSliderMouseMove = useCallback((e) => {
    if (!ySliderDragging || !ySliderTrackRef.current) return;
    
    const track = ySliderTrackRef.current;
    const rect = track.getBoundingClientRect();
    const trackHeight = rect.height;
    
    // Calculate position from bottom (0) to top (1) - inverted because Y increases upward
    const relativeY = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / trackHeight));
    
    // Map to Y range (-64 to 320)
    const yValue = Math.round(-64 + relativeY * 384);
    
    if (ySliderDragging === 'max') {
      setMaxY(Math.max(yValue, minY + 1));
    } else {
      setMinY(Math.min(yValue, maxY - 1));
    }
  }, [ySliderDragging, minY, maxY]);

  const handleYSliderMouseUp = useCallback(() => {
    setYSliderDragging(null);
  }, []);

  // Global listeners for Y-slider dragging
  useEffect(() => {
    if (ySliderDragging) {
      window.addEventListener('mousemove', handleYSliderMouseMove);
      window.addEventListener('mouseup', handleYSliderMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleYSliderMouseMove);
        window.removeEventListener('mouseup', handleYSliderMouseUp);
      };
    }
  }, [ySliderDragging, handleYSliderMouseMove, handleYSliderMouseUp]);

  // Calculate handle positions as percentages (from bottom)
  const maxYPercent = ((maxY + 64) / 384) * 100;
  const minYPercent = ((minY + 64) / 384) * 100;

  const handleViewModeChange = useCallback((mode) => {
    if (mode === viewMode) return;
    
    setViewMode(mode);
    setLoading(true);
    
    // Use setTimeout to allow UI to update before heavy computation
    setTimeout(() => {
      try {
        if (mode === 'region') {
          const regionData = prepareRegionData(chunks);
          setRegionChunkData(regionData);
          setBlocks([]); // Clear single-chunk blocks
          setMinY(regionData.yRange.min);
          setMaxY(Math.min(320, regionData.yRange.max));
        } else {
          setRegionChunkData(null);
          // Get first selected chunk
          const firstIndex = Math.min(...selectedChunkIndices);
          const selectedChunks = Array.from(selectedChunkIndices).map(i => chunks[i]).filter(Boolean);
          
          if (selectedChunks.length === 1) {
            const chunkBlocks = extractBlocks(selectedChunks[0]);
            setBlocks(chunkBlocks);
            setChunkViewData(null);
            
            if (chunkBlocks.length > 0) {
              const { min, max } = getYRange(chunkBlocks);
              setMinY(min);
              setMaxY(Math.min(320, max));
            }
          } else if (selectedChunks.length > 1) {
            const viewData = prepareChunkViewData(selectedChunks);
            setChunkViewData(viewData);
            setBlocks([]);
            setMinY(-64);
            setMaxY(320);
          } else {
            // No selection, select first chunk
            if (chunks.length > 0) {
              const chunkBlocks = extractBlocks(chunks[0]);
              setBlocks(chunkBlocks);
              setChunkViewData(null);
              setSelectedChunkIndices(new Set([0]));
            }
          }
        }
      } catch (e) {
        console.error('Failed to extract blocks:', e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 50);
  }, [viewMode, chunks, selectedChunkIndices, prepareRegionData, prepareChunkViewData]);

  const blockCount = useMemo(() => {
    return blocks.filter(b => b.y >= minY && b.y <= maxY).length;
  }, [blocks, minY, maxY]);

  return (
    <div className="app">
      {/* Viewer */}
      <div className="viewer-container">
        {loading && (
          <div className="loading-overlay">
            <div className="spinner large"></div>
            <p>Processing chunks...</p>
          </div>
        )}
        {buildProgress.isBuilding && (
          <div className="build-overlay">
            <div className="build-progress-container">
              {streamingState.isStreaming && (
                <div className="streaming-region-header">
                  <span>Region {streamingState.currentRegionIndex + 1} of {streamingState.totalRegions}</span>
                  <span className="streaming-region-name">{streamingState.currentRegionName}</span>
                </div>
              )}
              <div className="build-progress-header">
                <span>{buildProgress.message || 'Building chunk meshes...'}</span>
                <span>{buildProgress.current} / {buildProgress.total}</span>
              </div>
              <div className="build-progress-bar">
                <div 
                  className="build-progress-fill"
                  style={{ width: `${(buildProgress.current / buildProgress.total) * 100}%` }}
                />
              </div>
              <p className="build-progress-hint">
                {buildProgress.current < buildProgress.total 
                  ? `${Math.round((buildProgress.current / buildProgress.total) * 100)}% complete`
                  : 'Finalizing...'}
              </p>
            </div>
          </div>
        )}
        {(blocks.length > 0 || regionChunkData || chunkViewData || chunks.length > 0 || regionFiles.length > 0) && !loading ? (
          <>
            {viewerEngine === 'new' && viewMode === 'region' && (chunks.length > 0 || regionFiles.length > 0) ? (
              <RegionViewer
                chunks={chunks}
                regions={regionFiles}
                parseRegion={parseMCAFile}
                minY={minY}
                maxY={maxY}
                autoRotate={autoRotate}
                onBuildProgress={handleBuildProgress}
              />
            ) : (
              <ChunkViewer 
                blocks={blocks} 
                minY={minY} 
                maxY={maxY}
                autoRotate={autoRotate}
                isRegion={viewMode === 'region'}
                regionChunkData={regionChunkData}
                chunkViewData={chunkViewData}
                onBuildProgress={handleBuildProgress}
                cameraMode={cameraMode}
                collisionWorld={collisionWorld}
                regionCenter={collisionCenter}
                onPlayerPosition={handlePlayerPosition}
                onPlayerChunkChange={handlePlayerChunkChange}
                onPlayerVelocity={handlePlayerVelocity}
                onPlayerSprint={handlePlayerSprint}
                walkFov={effectiveFov}
                onStreamingProgress={handleStreamingProgress}
              />
            )}
            {cameraMode === 'walk' && viewerEngine !== 'new' && (
              <>
                <div className="walk-crosshair" />
                <div className="walk-hint-overlay">
                  Click to start walking • ESC to release cursor
                </div>
              </>
            )}
          </>
        ) : !loading && (
          <div className="empty-state">
            <div className="empty-icon">⛏️</div>
            <h2>Chunk Viewer</h2>
            <p>Upload an MCA region file to visualize chunks in 3D</p>
          </div>
        )}
      </div>

      {/* Y-Layer Vertical Slider */}
      {(blocks.length > 0 || regionChunkData || chunkViewData) && (
        <div className="y-slider-container">
          <span className="y-slider-label">Y Layer</span>
          <div className="y-slider-track-container">
            <div 
              className="y-slider-track" 
              ref={ySliderTrackRef}
              onClick={(e) => {
                if (!ySliderTrackRef.current) return;
                const rect = ySliderTrackRef.current.getBoundingClientRect();
                const relativeY = 1 - (e.clientY - rect.top) / rect.height;
                const yValue = Math.round(-64 + relativeY * 384);
                // Set whichever handle is closer
                const distToMax = Math.abs(yValue - maxY);
                const distToMin = Math.abs(yValue - minY);
                if (distToMax < distToMin) {
                  setMaxY(Math.max(yValue, minY + 1));
                } else {
                  setMinY(Math.min(yValue, maxY - 1));
                }
              }}
            >
              {/* Range highlight */}
              <div 
                className="y-slider-range"
                style={{
                  bottom: `${minYPercent}%`,
                  top: `${100 - maxYPercent}%`
                }}
              />
              {/* Max handle (top) */}
              <div 
                className={`y-slider-handle max-handle ${ySliderDragging === 'max' ? 'dragging' : ''}`}
                style={{ bottom: `calc(${maxYPercent}% - 10px)` }}
                onMouseDown={(e) => handleYSliderMouseDown('max', e)}
              >
                <span className="y-slider-value">{maxY}</span>
              </div>
              {/* Min handle (bottom) */}
              <div 
                className={`y-slider-handle min-handle ${ySliderDragging === 'min' ? 'dragging' : ''}`}
                style={{ bottom: `calc(${minYPercent}% - 10px)` }}
                onMouseDown={(e) => handleYSliderMouseDown('min', e)}
              >
                <span className="y-slider-value">{minY}</span>
              </div>
            </div>
            {/* Tick marks */}
            <div className="y-slider-ticks">
              <span className="y-slider-tick">320</span>
              <span className="y-slider-tick">192</span>
              <span className="y-slider-tick">64</span>
              <span className="y-slider-tick">-64</span>
            </div>
          </div>
          <div className="y-slider-quick-buttons">
            <button 
              className="y-slider-quick-btn"
              onClick={() => { setMinY(yRange.min); setMaxY(yRange.max); }}
              title="Reset to full range"
            >
              Full
            </button>
            <button 
              className="y-slider-quick-btn"
              onClick={() => {
                const mid = Math.floor((yRange.min + yRange.max) / 2);
                setMinY(mid - 8);
                setMaxY(mid + 8);
              }}
              title="Show middle 16 layers"
            >
              Mid
            </button>
            <button 
              className="y-slider-quick-btn"
              onClick={() => { setMinY(yRange.max - 16); setMaxY(yRange.max); }}
              title="Show top 16 layers"
            >
              Top
            </button>
          </div>
        </div>
      )}

      {/* Control Panel */}
      <div className="control-panel">
        <div className="panel-header">
          <h1>Block Viewer</h1>
          <span className="version">v1.6</span>
        </div>

        {/* File Upload */}
        <section className="panel-section">
          <h3>Region File</h3>
          <div className="file-upload-group">
            <label className="file-upload">
              <input 
                type="file" 
                accept=".mca,.mcr"
                onChange={handleFileUpload}
                disabled={loading}
                multiple
              />
              <span className="upload-button">
                {loading ? (
                  <>
                    <span className="spinner"></span>
                    Loading...
                  </>
                ) : (
                  <>📁 Load Region(s)</>
                )}
              </span>
            </label>
            {(regionFiles.length > 0 || chunks.length > 0) && (
              <label className="file-upload file-upload-add">
                <input 
                  type="file" 
                  accept=".mca,.mcr"
                  onChange={handleAddRegionFiles}
                  disabled={loading}
                  multiple
                />
                <span className="upload-button upload-button-secondary">
                  {loading ? '...' : '➕ Add More'}
                </span>
              </label>
            )}
          </div>
          {fileName && (
            <div className="file-info">
              <span className="file-name">{fileName}</span>
              <span className="chunk-count">
                {regionFiles.length > 0 ? `${regionFiles.length} regions` : `${chunks.length} chunks`}
              </span>
            </div>
          )}
          {error && <div className="error-message">⚠️ {error}</div>}
        </section>

        {/* View Mode Toggle */}
        {chunks.length > 0 && (
          <section className="panel-section">
            <h3>View Mode</h3>
            <div className="view-mode-toggle">
              <button
                className={`mode-btn ${viewMode === 'chunk' ? 'active' : ''}`}
                onClick={() => handleViewModeChange('chunk')}
                disabled={loading}
              >
                Single Chunk
              </button>
              <button
                className={`mode-btn ${viewMode === 'region' ? 'active' : ''}`}
                onClick={() => handleViewModeChange('region')}
                disabled={loading}
              >
                Entire Region
              </button>
            </div>
            
            {/* Viewer Engine Toggle */}
            <div className="viewer-engine-toggle" style={{ marginTop: '12px' }}>
              <span className="toggle-section-label" style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', opacity: 0.8 }}>
                Renderer Engine
              </span>
              <div className="mode-buttons">
                <button
                  className={`mode-btn small ${viewerEngine === 'new' ? 'active' : ''}`}
                  onClick={() => setViewerEngine('new')}
                  title="High-performance viewer with GPU-based Y slicing"
                >
                  ⚡ Fast
                </button>
                <button
                  className={`mode-btn small ${viewerEngine === 'classic' ? 'active' : ''}`}
                  onClick={() => setViewerEngine('classic')}
                  title="Original viewer with walk mode support"
                >
                  🎮 Classic
                </button>
              </div>
              {viewerEngine === 'new' && (
                <p className="hint-text" style={{ marginTop: '6px', fontSize: '0.75rem' }}>
                  GPU Y-slicing: instant layer changes
                </p>
              )}
            </div>
          </section>
        )}

        {/* Chunk Selection - only show when in chunk mode */}
        {chunks.length > 0 && viewMode === 'chunk' && (() => {
          // Calculate grid bounds
          let minX = Infinity, maxX = -Infinity;
          let minZ = Infinity, maxZ = -Infinity;
          for (const chunk of chunks) {
            if (chunk.x < minX) minX = chunk.x;
            if (chunk.x > maxX) maxX = chunk.x;
            if (chunk.z < minZ) minZ = chunk.z;
            if (chunk.z > maxZ) maxZ = chunk.z;
          }
          
          const gridWidth = maxX - minX + 1;
          const gridHeight = maxZ - minZ + 1;
          
          // Create lookup map: "x,z" -> chunk index
          const chunkMap = new Map();
          chunks.forEach((chunk, index) => {
            chunkMap.set(`${chunk.x},${chunk.z}`, index);
          });
          
          // Generate grid cells
          const gridCells = [];
          for (let z = minZ; z <= maxZ; z++) {
            for (let x = minX; x <= maxX; x++) {
              const key = `${x},${z}`;
              const index = chunkMap.get(key);
              gridCells.push({ x, z, index, exists: index !== undefined });
            }
          }
          
          return (
            <section className="panel-section">
              <h3>Chunk Selection ({selectedChunkIndices.size} selected)</h3>
              <p className="selection-hint">Click and drag to paint selection</p>
              <div className="chunk-map-container">
                <div 
                  className="chunk-map-grid"
                  style={{
                    gridTemplateColumns: `repeat(${gridWidth}, 1fr)`,
                    gridTemplateRows: `repeat(${gridHeight}, 1fr)`
                  }}
                >
                  {gridCells.map(({ x, z, index, exists }) => (
                    exists ? (
                      <button
                        key={`${x}-${z}`}
                        className={`chunk-cell ${selectedChunkIndices.has(index) ? 'active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleDragStart(index);
                        }}
                        onMouseEnter={() => handleDragEnter(index)}
                        onClick={(e) => {
                          // Only handle click if not dragging (for keyboard/touch)
                          if (!isDragging) {
                            handleChunkSelect(index, e);
                          }
                        }}
                        title={`Chunk (${x}, ${z})`}
                      />
                    ) : (
                      <div key={`${x}-${z}`} className="chunk-cell empty" />
                    )
                  ))}
                </div>
                <div className="chunk-map-legend">
                  <span className="legend-item">
                    <span className="legend-swatch available"></span>
                    Available
                  </span>
                  <span className="legend-item">
                    <span className="legend-swatch selected"></span>
                    Selected
                  </span>
                </div>
              </div>
              {selectedChunkIndices.size > 1 && (
                <button 
                  className="clear-selection-btn"
                  onClick={() => {
                    const firstIndex = Math.min(...selectedChunkIndices);
                    handleChunkSelect(firstIndex);
                  }}
                >
                  Clear multi-selection
                </button>
              )}
            </section>
          );
        })()}


        {/* View Options */}
        {(blocks.length > 0 || regionChunkData) && (
          <section className="panel-section">
            <h3>View Options</h3>
            
            {/* Camera Mode Toggle */}
            <div className="camera-mode-toggle">
              <span className="toggle-section-label">Camera Mode</span>
              <div className="mode-buttons">
                <button
                  className={`mode-btn small ${cameraMode === 'freecam' ? 'active' : ''}`}
                  onClick={() => handleCameraModeChange('freecam')}
                >
                  🎥 Freecam
                </button>
                <button
                  className={`mode-btn small ${cameraMode === 'walk' ? 'active' : ''}`}
                  onClick={() => handleCameraModeChange('walk')}
                >
                  🚶 Walk
                </button>
              </div>
            </div>
            
            {cameraMode === 'walk' && playerPosition && (
              <div className="player-position">
                <span className="position-label">Position:</span>
                <span className="position-value">
                  X: {Math.floor(playerPosition.x)} Y: {Math.floor(playerPosition.y)} Z: {Math.floor(playerPosition.z)}
                </span>
              </div>
            )}
            
            {cameraMode === 'walk' && (
              <div className="fov-slider">
                <label>
                  <span className="fov-label">FOV: {walkFov}°</span>
                  <input
                    type="range"
                    min="50"
                    max="120"
                    value={walkFov}
                    onChange={(e) => setWalkFov(Number(e.target.value))}
                    className="slider"
                  />
                </label>
                <div className="fov-presets">
                  <button 
                    className={`fov-preset-btn ${walkFov === 70 ? 'active' : ''}`}
                    onClick={() => setWalkFov(70)}
                  >
                    Normal
                  </button>
                  <button 
                    className={`fov-preset-btn ${walkFov === 90 ? 'active' : ''}`}
                    onClick={() => setWalkFov(90)}
                  >
                    Wide
                  </button>
                  <button 
                    className={`fov-preset-btn ${walkFov === 110 ? 'active' : ''}`}
                    onClick={() => setWalkFov(110)}
                  >
                    Quake Pro
                  </button>
                </div>
              </div>
            )}
            
            {cameraMode === 'freecam' && (
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={autoRotate}
                  onChange={(e) => setAutoRotate(e.target.checked)}
                />
                <span className="toggle-label">Auto Rotate</span>
              </label>
            )}
            
            {viewMode === 'region' && cameraMode === 'freecam' && (
              <p className="hint-text">
                💡 Chunks load dynamically as you move the camera. Zoom in to see more detail.
              </p>
            )}
            
            {cameraMode === 'walk' && (
              <p className="hint-text">
                🎮 Click to lock cursor. WASD to move, Space to jump, ESC to unlock.
              </p>
            )}
          </section>
        )}

        {/* Stats */}
        {(blocks.length > 0 || regionChunkData) && (
          <section className="panel-section stats">
            <h3>Statistics</h3>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-value">
                  {viewMode === 'region' 
                    ? `${regionChunkData?.totalChunks || 0} chunks`
                    : blockCount.toLocaleString()
                  }
                </span>
                <span className="stat-label">Total Blocks</span>
              </div>
              <div className="stat">
                <span className="stat-value">
                  {viewMode === 'region' 
                    ? (regionChunkData?.chunkRefs?.length || 0)
                    : 1
                  }
                </span>
                <span className="stat-label">Chunks</span>
              </div>
              <div className="stat">
                <span className="stat-value">
                  {maxY - minY + 1}
                </span>
                <span className="stat-label">Y Layers</span>
              </div>
            </div>
          </section>
        )}

        {/* Instructions */}
        <section className="panel-section instructions">
          <h3>Controls</h3>
          {cameraMode === 'freecam' ? (
            <ul>
              <li><kbd>Drag</kbd> Rotate view</li>
              <li><kbd>Scroll</kbd> Zoom in/out</li>
              <li><kbd>Right Drag</kbd> Pan view</li>
            </ul>
          ) : (
            <ul>
              <li><kbd>W A S D</kbd> Move</li>
              <li><kbd>Mouse</kbd> Look around</li>
              <li><kbd>Space</kbd> Jump</li>
              <li><kbd>Esc</kbd> Unlock cursor</li>
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default App;
