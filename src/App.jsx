import { useState, useCallback, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { RegionViewer } from './viewer';
import { parseMCAFile, parseEntityRegionFile } from './utils/mcaParser';
import { extractSpawnFromLevelDat } from './utils/nbtParser';
import { 
  getDefaultPackManager, 
  getCustomPackManager,
  getTextureAtlas,
  TEXTURE_MODE 
} from './assets';
import { getParticleAtlas } from './assets/ParticleAtlas';
import { getBlockColorsNumeric, BLOCK_COLORS } from './data/blockColors';
import { getBlockRegistry } from './mesh/BlockRegistry';
import { getRandomRotationRegistry } from './assets/RandomRotationRegistry';
import { getModelResolver } from './assets/ModelResolver';
import { getBlockstateResolver } from './assets/BlockstateResolver';
import { getModelTextureMapper } from './assets/ModelTextureMapper';
import './App.css';

function App() {
  const [chunks, setChunks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  
  // Sidebar collapsed state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  
  // Build progress for region rendering
  // stage: 'parsing' | 'decoding' | 'meshing' | 'adding' | 'particles' | 'complete'
  const [buildProgress, setBuildProgress] = useState({ 
    current: 0, 
    total: 0, 
    isBuilding: false, 
    message: '',
    stage: null,        // Current processing stage
    stageProgress: 0,   // Progress within current stage (0-100)
    regionName: '',     // Current region being processed
  });
  
  // Streaming region loading state
  const [streamingState, setStreamingState] = useState({
    isStreaming: false,
    currentRegionIndex: 0,
    totalRegions: 0,
    currentRegionName: ''
  });
  
  // Region files for progressive loading
  const [regionFiles, setRegionFiles] = useState([]);
  
  // Entity region files (separate from chunk region files in MC 1.17+)
  const [entityRegionFiles, setEntityRegionFiles] = useState([]);
  
  // World spawn coordinates from level.dat (if available)
  const [worldSpawn, setWorldSpawn] = useState(null);
  
  // Current dimension ID ('overworld', 'the_nether', 'the_end', or custom 'namespace:name')
  const [currentDimension, setCurrentDimension] = useState('overworld');
  
  // Dimension picker state (for world zips with multiple dimensions)
  const [dimensionPicker, setDimensionPicker] = useState({
    show: false,
    dimensions: [],  // Array of { id, name, regionCount, path }
    pendingZip: null, // JSZip instance
    isAddMode: false, // Whether we're adding to existing or replacing
  });
  
  // Rerender key - increment to force RegionViewer remount (useful after React hot-reload)
  const [rerenderKey, setRerenderKey] = useState(0);
  
  // Model meshes toggle (non-cube blocks like slabs, stairs, flowers)
  const [enableModelMeshes, setEnableModelMeshes] = useState(true);
  
  // Lighting toggle (lightmap-based lighting vs fixed face shading)
  const [enableLighting, setEnableLighting] = useState(true);
  
  // Debug mode - shows block info on hover
  const [debugMode, setDebugMode] = useState(false);
  const [hoveredBlock, setHoveredBlock] = useState(null);
  const [lockedBlock, setLockedBlock] = useState(null); // Block locked by clicking
  const [blockDetails, setBlockDetails] = useState(null); // Comprehensive block details (fetched on click)
  const chunkManagerRef = useRef(null); // Ref to ChunkManager for block details lookup
  
  // Camera FOV (vertical degrees) - Minecraft uses vertical FOV internally
  // Default 60, but can be adjusted to match specific Minecraft screenshots
  const [fov, setFov] = useState(70);
  
  // Chunk render distance - chunks beyond this are hidden until player moves closer
  // 0 = unlimited (show all chunks), value is in chunks (1 chunk = 16 blocks)
  // Detail distance (partial blocks) is tied to this value
  const [renderDistance, setRenderDistance] = useState(8);
  
  // Particle render distance - particles beyond this distance are not spawned
  // Value is in chunks (1 chunk = 16 blocks), default 3 chunks = 48 blocks
  const [particleDistance, setParticleDistance] = useState(3);
  
  // Particle quality setting - matches Minecraft's particle options
  // 'all' = 100%, 'decreased' = 67%, 'minimal' = 10%
  const [particleQuality, setParticleQuality] = useState('all');
  
  // Distance fog (Minecraft-style haze at render distance)
  const [fogEnabled, setFogEnabled] = useState(true);
  
  // Time of day (0-1: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset)
  const [timeOfDay, setTimeOfDay] = useState(0.5); // Default to midday (noon)
  
  // Brightness setting (0-100: 0=Moody, 100=Bright) - matches Minecraft's brightness slider
  const [brightness, setBrightness] = useState(50); // Default to 50% like typical Minecraft settings
  
  // RGSS anti-aliasing (Rotated Grid Super-Sampling) - Minecraft's texture smoothing
  const [enableRGSS, setEnableRGSS] = useState(true);
  
  // Clouds toggle
  const [cloudsEnabled, setCloudsEnabled] = useState(true);
  
  // Continuous glass (connected glass textures - removes borders between adjacent glass blocks)
  const [continuousGlass, setContinuousGlass] = useState(false);
  
  // Chunk streaming mode - loads chunks around player position instead of entire regions
  const [chunkStreamingEnabled, setChunkStreamingEnabled] = useState(true);
  // Stream distance is automatically derived from render distance (render + 2 buffer)
  
  // Chunk loading speed (concurrency) - higher = faster loading but may cause frame drops
  // 1 = smoothest (1 chunk at a time), 8 = fastest (8 chunks simultaneously)
  const [chunkLoadingSpeed, setChunkLoadingSpeed] = useState(3);
  
  // Target resolution (controls rendering DPR)
  // 'native' = full resolution, or a vertical pixel count like 720, 1080, 1440, 2160
  const [targetResolution, setTargetResolution] = useState('native');
  
  // Camera state for coordinates display (Minecraft spectator mode)
  const [cameraState, setCameraState] = useState({
    x: 0, y: 100, z: 0,
    pitch: 0, yaw: 0,
    direction: 'south',
    axis: 'Towards positive Z',
  });
  
  // Command input for /teleport commands
  const [commandInput, setCommandInput] = useState('');
  const [commandError, setCommandError] = useState(null);
  
  // Ref for spectator controls teleport function
  const spectatorRef = useRef(null);
  
  // Texture pack state
  const [textureMode, setTextureMode] = useState(TEXTURE_MODE.DEFAULT_PACK);
  const [texturePackLoading, setTexturePackLoading] = useState(false);
  const [texturePackInfo, setTexturePackInfo] = useState(null);
  const [textureAtlas, setTextureAtlas] = useState(null);
  const [particleAtlas, setParticleAtlas] = useState(null);
  const [packManager, setPackManager] = useState(null); // Texture pack manager for beacon beams etc.
  const [atlasDebugUrl, setAtlasDebugUrl] = useState(null); // Debug: atlas preview
  const [particleAtlasDebugUrl, setParticleAtlasDebugUrl] = useState(null); // Debug: particle atlas preview
  
  // Load default texture pack when mode changes to default
  useEffect(() => {
    if (textureMode === TEXTURE_MODE.DEFAULT_PACK && !texturePackInfo) {
      loadDefaultTexturePack();
    }
  }, [textureMode]);
  
  // Expose settings setters for E2E testing
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__appSettings = {
        setCloudsEnabled,
        setSmoothLighting: setEnableLighting,
        setDayNightCycle: (enabled) => {
          // When disabled, freeze time at noon (0.5)
          // The actual animation is controlled elsewhere, but we can set a fixed time
          if (!enabled) {
            setTimeOfDay(0.5);
          }
        },
        setTimeOfDay,
        setFogEnabled,
        setRenderDistance,
        setFov,
      };
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete window.__appSettings;
      }
    };
  }, []);
  
  // Load the default bundled texture pack
  const loadDefaultTexturePack = useCallback(async () => {
    setTexturePackLoading(true);
    try {
      const pm = getDefaultPackManager();
      await pm.loadDefaultPack();
      setPackManager(pm); // Store for beacon beams etc.
      
      // Debug: Validate textures are loaded correctly
      pm.debugValidateTextures();
      
      // Preload all block models from the texture pack for data-driven texture mapping
      // This enables synchronous model lookup via resolveSync() in TextureIndexLookup
      const modelResolver = getModelResolver();
      await modelResolver.preloadAllModels(pm);
      
      // Initialize blockstate resolver with pack manager for variant lookup
      const blockstateResolver = getBlockstateResolver();
      blockstateResolver.setPackManager(pm);
      
      // Initialize ModelTextureMapper with preloaded resolvers
      const modelTextureMapper = getModelTextureMapper();
      modelTextureMapper.init(modelResolver, blockstateResolver);
      
      const atlas = getTextureAtlas();
      await atlas.build(pm);
      
      // Pre-register all known blocks from BLOCK_COLORS to the registry
      // This is necessary because blocks are normally registered during chunk decoding,
      // but we need them registered now to build the texture index lookup
      const blockRegistry = getBlockRegistry();
      const blockNames = Object.keys(BLOCK_COLORS);
      
      for (const blockName of blockNames) {
        blockRegistry.registerBlock(blockName);
      }
      
      // Build the TextureIndexLookup which maps (blockId, face) -> atlas index
      atlas.buildTextureIndexLookup(blockRegistry);
      
      // Build particle atlas for torch flames, smoke, etc.
      const pAtlas = getParticleAtlas();
      await pAtlas.build(pm);
      // Wrap in new object to trigger React state change (atlas is singleton, same reference)
      setParticleAtlas({ atlas: pAtlas, version: Date.now() });
      
      // Set the material data (includes atlas, textureIndexLookup, and size)
      setTextureAtlas(atlas.getMaterialData());
      setTexturePackInfo(pm.getPackInfo());
      
      // Debug: generate atlas preview URLs
      setAtlasDebugUrl(atlas.toDataURL());
      setParticleAtlasDebugUrl(pAtlas.toDataURL());
      
      console.log('[App] Default texture pack loaded');
    } catch (err) {
      console.error('[App] Failed to load default texture pack:', err);
      setError('Failed to load default texture pack');
      setTextureMode(TEXTURE_MODE.SOLID_COLOR);
    } finally {
      setTexturePackLoading(false);
    }
  }, []);
  
  // Handle custom texture pack upload
  const handleTexturePackUpload = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    setTexturePackLoading(true);
    try {
      // First ensure default pack is loaded as fallback
      const defaultPack = getDefaultPackManager();
      if (!defaultPack.isLoaded) {
        await defaultPack.loadDefaultPack();
      }
      
      const customPack = getCustomPackManager();
      await customPack.loadFromZip(file, file.name.replace('.zip', ''));
      
      // Apply random rotation overrides from texture pack if available
      const rotationRegistry = getRandomRotationRegistry();
      rotationRegistry.clearPackOverrides(); // Clear any previous pack overrides
      const packRotationBlocks = customPack.getRandomRotationBlocks();
      if (packRotationBlocks) {
        rotationRegistry.addPackOverrides(packRotationBlocks);
      }
      
      // Preload models from custom pack for data-driven texture mapping
      const modelResolver = getModelResolver();
      await modelResolver.preloadAllModels(customPack);
      
      // Initialize blockstate resolver with custom pack
      const blockstateResolver = getBlockstateResolver();
      blockstateResolver.setPackManager(customPack);
      
      // Re-initialize ModelTextureMapper with updated resolvers
      // Clear cache since we're loading a new pack
      const modelTextureMapper = getModelTextureMapper();
      modelTextureMapper.clearCache();
      modelTextureMapper.init(modelResolver, blockstateResolver);
      
      const atlas = getTextureAtlas();
      await atlas.build(customPack);
      
      // Pre-register all known blocks from BLOCK_COLORS to the registry
      const blockRegistry = getBlockRegistry();
      const blockNames = Object.keys(BLOCK_COLORS);
      
      for (const blockName of blockNames) {
        blockRegistry.registerBlock(blockName);
      }
      
      // Build the TextureIndexLookup which maps (blockId, face) -> atlas index
      atlas.buildTextureIndexLookup(blockRegistry);
      
      // Rebuild particle atlas for the custom texture pack
      const pAtlas = getParticleAtlas();
      await pAtlas.build(customPack);
      // Wrap in new object to trigger React state change (atlas is singleton, same reference)
      setParticleAtlas({ atlas: pAtlas, version: Date.now() });
      
      setTextureAtlas(atlas.getMaterialData());
      setPackManager(customPack); // Update pack manager reference for beacon beams etc.
      setTexturePackInfo(customPack.getPackInfo());
      setTextureMode(TEXTURE_MODE.CUSTOM_PACK);
      
      // Debug: generate atlas preview URLs
      setAtlasDebugUrl(atlas.toDataURL());
      setParticleAtlasDebugUrl(pAtlas.toDataURL());
      
      console.log('[App] Custom texture pack loaded:', file.name);
    } catch (err) {
      console.error('[App] Failed to load texture pack:', err);
      setError('Failed to load texture pack: ' + err.message);
    } finally {
      setTexturePackLoading(false);
      event.target.value = '';
    }
  }, []);

  const handleBuildProgress = useCallback((progressInfo) => {
    // Support both old API (4 args) and new API (object)
    if (typeof progressInfo === 'number') {
      // Legacy API: (current, total, isBuilding, message)
      const [current, total, isBuilding, message = ''] = arguments;
      setBuildProgress(prev => ({ 
        ...prev,
        current, 
        total, 
        isBuilding, 
        message,
      }));
    } else {
      // New API: { current, total, isBuilding, message, stage, stageProgress, regionName }
      setBuildProgress(prev => ({ 
        ...prev,
        ...progressInfo,
      }));
    }
  }, []);

  // Auto-hide the loading overlay after 'complete' stage is shown for a moment
  useEffect(() => {
    if (buildProgress.stage === 'complete') {
      const timer = setTimeout(() => {
        setBuildProgress(prev => ({ ...prev, stage: null }));
      }, 500); // Show "complete" for 500ms before hiding
      return () => clearTimeout(timer);
    }
  }, [buildProgress.stage]);

  // Throttle camera updates to avoid excessive re-renders
  const lastCameraUpdateRef = useRef(0);
  const handleCameraUpdate = useCallback((state) => {
    const now = Date.now();
    if (now - lastCameraUpdateRef.current > 50) { // 20 FPS max for UI updates
      lastCameraUpdateRef.current = now;
      setCameraState(state);
    }
  }, []);
  
  // Handle command input (e.g., /teleport x y z pitch yaw)
  const handleCommandSubmit = useCallback((e) => {
    if (e.key !== 'Enter') return;
    
    const cmd = commandInput.trim();
    if (!cmd) return;
    
    setCommandError(null);
    
    // Parse /teleport or /tp command
    const teleportMatch = cmd.match(/^\/(teleport|tp)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?(?:\s+(-?[\d.]+))?$/i);
    
    if (teleportMatch) {
      const x = parseFloat(teleportMatch[2]);
      const y = parseFloat(teleportMatch[3]);
      const z = parseFloat(teleportMatch[4]);
      // Minecraft format: /tp x y z yaw pitch (yaw comes first!)
      const yaw = teleportMatch[5] !== undefined ? parseFloat(teleportMatch[5]) : cameraState.yaw;
      const pitch = teleportMatch[6] !== undefined ? parseFloat(teleportMatch[6]) : cameraState.pitch;
      
      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        setCommandError('Invalid coordinates');
        return;
      }
      
      if (spectatorRef.current) {
        spectatorRef.current.teleport(x, y, z, yaw, pitch);
        setCommandInput('');
      }
    } else if (cmd.startsWith('/')) {
      setCommandError('Usage: /teleport x y z [yaw] [pitch]');
    } else {
      setCommandError('Commands start with /');
    }
    
    e.target.blur();
  }, [commandInput, cameraState]);

  // Parse region coordinates from filename (e.g., "r.-1.2.mca" -> { x: -1, z: 2 })
  const parseRegionCoords = useCallback((filename) => {
    const match = filename.match(/r\.(-?\d+)\.(-?\d+)\.mca$/i);
    if (match) {
      return { x: parseInt(match[1], 10), z: parseInt(match[2], 10) };
    }
    return { x: 0, z: 0 }; // Default if pattern doesn't match
  }, []);

  // Scan a world zip file for all available dimensions
  // Returns { zip, dimensions } where dimensions is array of { id, name, regionCount, path }
  const scanDimensionsFromZip = useCallback(async (zipFile) => {
    try {
      const zip = await JSZip.loadAsync(zipFile);
      
      // Find all region folders in the zip
      // Minecraft dimension paths:
      // - Overworld: region/ or worldname/region/
      // - Nether: DIM-1/region/ or worldname/DIM-1/region/
      // - The End: DIM1/region/ or worldname/DIM1/region/
      // - Custom dimensions: dimensions/namespace/name/region/
      
      const dimensionMap = new Map(); // path -> { id, name, files }
      
      for (const [path, file] of Object.entries(zip.files)) {
        if (!path.endsWith('.mca') || file.dir) continue;
        
        // Extract the region folder path
        const regionIdx = path.lastIndexOf('region/');
        if (regionIdx === -1) continue;
        
        const regionPath = path.substring(0, regionIdx + 'region/'.length);
        const filename = path.substring(regionPath.length);
        
        // Skip files in subdirectories of region/
        if (filename.includes('/')) continue;
        
        // Get or create dimension entry
        if (!dimensionMap.has(regionPath)) {
          // Determine dimension name from path
          let dimensionId = 'overworld';
          let dimensionName = 'Overworld';
          
          if (regionPath.includes('DIM-1/')) {
            dimensionId = 'the_nether';
            dimensionName = 'The Nether';
          } else if (regionPath.includes('DIM1/')) {
            dimensionId = 'the_end';
            dimensionName = 'The End';
          } else if (regionPath.includes('dimensions/')) {
            // Custom dimension: dimensions/namespace/name/region/
            const match = regionPath.match(/dimensions\/([^/]+)\/([^/]+)\/region\//);
            if (match) {
              dimensionId = `${match[1]}:${match[2]}`;
              dimensionName = match[2].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            }
          }
          
          dimensionMap.set(regionPath, {
            id: dimensionId,
            name: dimensionName,
            path: regionPath,
            files: [],
          });
        }
        
        dimensionMap.get(regionPath).files.push({ path, filename, zipFile: file });
      }
      
      if (dimensionMap.size === 0) {
        console.log('[App] No region folders found in zip');
        return null;
      }
      
      // Convert to array and add region count
      const dimensions = Array.from(dimensionMap.values()).map(dim => ({
        id: dim.id,
        name: dim.name,
        path: dim.path,
        regionCount: dim.files.length,
        files: dim.files,
      }));
      
      // Sort: Overworld first, then Nether, then End, then custom
      const order = { 'overworld': 0, 'the_nether': 1, 'the_end': 2 };
      dimensions.sort((a, b) => {
        const orderA = order[a.id] ?? 3;
        const orderB = order[b.id] ?? 3;
        return orderA - orderB || a.name.localeCompare(b.name);
      });
      
      console.log(`[App] Found ${dimensions.length} dimension(s) in zip:`, dimensions.map(d => `${d.name} (${d.regionCount} regions)`));
      
      // Try to find and parse level.dat for world spawn coordinates
      let spawn = null;
      for (const [path, file] of Object.entries(zip.files)) {
        if (path.endsWith('level.dat') && !file.dir) {
          try {
            const levelDatBuffer = await file.async('arraybuffer');
            spawn = extractSpawnFromLevelDat(levelDatBuffer);
            if (spawn) {
              console.log(`[App] Extracted world spawn from ${path}: (${spawn.x}, ${spawn.y}, ${spawn.z})`);
            }
            break; // Only use the first level.dat found
          } catch (e) {
            console.warn('[App] Failed to parse level.dat:', e);
          }
        }
      }
      
      return { zip, dimensions, spawn };
    } catch (err) {
      console.error('[App] Failed to scan dimensions from zip:', err);
      return null;
    }
  }, []);

  // Create lazy-loading File objects from a dimension's region files
  const createLazyRegionFiles = useCallback((dimensionFiles) => {
    return dimensionFiles.map(({ filename, zipFile }) => {
      let cachedBuffer = null;
      
      return {
        name: filename,
        arrayBuffer: async () => {
          if (cachedBuffer) {
            return cachedBuffer;
          }
          cachedBuffer = await zipFile.async('arraybuffer');
          return cachedBuffer;
        },
      };
    });
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
    } catch (e) {
      console.error('Failed to parse file:', e);
      setError(e.message);
      setStreamingState({ isStreaming: false, currentRegionIndex: 0, totalRegions: 0, currentRegionName: '' });
    } finally {
      setLoading(false);
    }
  }, [parseRegionCoords, regionFiles]);

  // Handle dimension selection from picker
  const handleDimensionSelect = useCallback(async (dimension) => {
    const { isAddMode, spawn } = dimensionPicker;
    
    // Close picker
    setDimensionPicker(prev => ({ ...prev, show: false }));
    
    // Set world spawn if found (only when replacing or if we don't have one)
    if (spawn && (!isAddMode || !worldSpawn)) {
      setWorldSpawn(spawn);
    }
    
    // Track current dimension for sky/fog rendering
    if (!isAddMode) {
      setCurrentDimension(dimension.id);
    }
    
    // Create lazy region files for selected dimension
    const lazyFiles = createLazyRegionFiles(dimension.files);
    
    console.log(`[App] Loading dimension: ${dimension.name} (${lazyFiles.length} regions)`);
    
    // Process the region files
    await processRegionFiles(lazyFiles, isAddMode);
  }, [dimensionPicker, createLazyRegionFiles, processRegionFiles, worldSpawn]);

  // Cancel dimension picker
  const handleDimensionCancel = useCallback(() => {
    setDimensionPicker({ show: false, dimensions: [], pendingZip: null, isAddMode: false });
  }, []);

  // Handle file upload (replace existing)
  const handleFileUpload = useCallback(async (event) => {
    const files = Array.from(event.target.files);
    
    // Check if any file is a zip (potential world save)
    let filesToProcess = [];
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        // Scan zip for dimensions
        setLoading(true);
        const result = await scanDimensionsFromZip(file);
        setLoading(false);
        
        if (!result) {
          setError('No region files found in zip. Expected a world save with a region/ folder.');
          continue;
        }
        
        const { dimensions, spawn } = result;
        
        // Set world spawn if found in level.dat
        if (spawn) {
          setWorldSpawn(spawn);
        } else {
          setWorldSpawn(null); // Clear old spawn when loading new world
        }
        
        if (dimensions.length === 1) {
          // Only one dimension - load it directly
          const lazyFiles = createLazyRegionFiles(dimensions[0].files);
          filesToProcess.push(...lazyFiles);
          // Track dimension for sky/fog rendering
          setCurrentDimension(dimensions[0].id);
        } else if (dimensions.length > 1) {
          // Multiple dimensions - show picker (spawn stored in result for later)
          setDimensionPicker({
            show: true,
            dimensions,
            pendingZip: result.zip,
            spawn, // Store spawn for use when dimension is selected
            isAddMode: false,
          });
          // Don't process other files - user needs to pick dimension first
          event.target.value = '';
          return;
        }
      } else {
        filesToProcess.push(file);
        // Clear spawn when loading standalone region files (no level.dat)
        setWorldSpawn(null);
        // Default to overworld for standalone region files
        setCurrentDimension('overworld');
      }
    }
    
    if (filesToProcess.length > 0) {
      await processRegionFiles(filesToProcess, false);
    }
    
    // Reset file input so same file can be selected again
    event.target.value = '';
  }, [processRegionFiles, scanDimensionsFromZip, createLazyRegionFiles]);

  // Handle adding region files (append to existing)
  const handleAddRegionFiles = useCallback(async (event) => {
    const files = Array.from(event.target.files);
    
    // Check if any file is a zip (potential world save)
    let filesToProcess = [];
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        // Scan zip for dimensions
        setLoading(true);
        const result = await scanDimensionsFromZip(file);
        setLoading(false);
        
        if (!result) {
          setError('No region files found in zip. Expected a world save with a region/ folder.');
          continue;
        }
        
        const { dimensions, spawn } = result;
        
        // When adding regions, only update spawn if we don't have one yet
        if (spawn && !worldSpawn) {
          setWorldSpawn(spawn);
        }
        
        if (dimensions.length === 1) {
          // Only one dimension - load it directly
          const lazyFiles = createLazyRegionFiles(dimensions[0].files);
          filesToProcess.push(...lazyFiles);
        } else if (dimensions.length > 1) {
          // Multiple dimensions - show picker
          setDimensionPicker({
            show: true,
            dimensions,
            pendingZip: result.zip,
            spawn, // Store spawn for use when dimension is selected
            isAddMode: true,
          });
          // Don't process other files - user needs to pick dimension first
          event.target.value = '';
          return;
        }
      } else {
        filesToProcess.push(file);
      }
    }
    
    if (filesToProcess.length > 0) {
      await processRegionFiles(filesToProcess, true);
    }
    
    // Reset file input so same file can be selected again
    event.target.value = '';
  }, [processRegionFiles, scanDimensionsFromZip, createLazyRegionFiles, worldSpawn]);

  // Handle entity region file upload
  const handleEntityRegionUpload = useCallback(async (event) => {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    
    const newEntityRegions = files.map(file => {
      const regionCoords = parseRegionCoords(file.name);
      return {
        file,
        regionX: regionCoords.x,
        regionZ: regionCoords.z,
      };
    });
    
    // Add to existing entity regions (or replace if none exist)
    if (entityRegionFiles.length === 0) {
      setEntityRegionFiles(newEntityRegions);
    } else {
      // Filter out duplicates
      const existingKeys = new Set(entityRegionFiles.map(r => `${r.regionX},${r.regionZ}`));
      const uniqueNew = newEntityRegions.filter(r => !existingKeys.has(`${r.regionX},${r.regionZ}`));
      setEntityRegionFiles(prev => [...prev, ...uniqueNew]);
    }
    
    console.log(`[App] Added ${newEntityRegions.length} entity region files`);
    
    // Reset file input so same file can be selected again
    event.target.value = '';
  }, [parseRegionCoords, entityRegionFiles]);

  const hasContent = chunks.length > 0 || regionFiles.length > 0;

  return (
    <div className="app">
      {/* Viewer */}
      <div className="viewer-container">
        {loading && (
          <div className="loading-overlay">
            <div className="spinner large"></div>
            <p>Processing regions...</p>
          </div>
        )}
        
        {/* Dimension Picker Modal */}
        {dimensionPicker.show && (
          <div className="dimension-picker-overlay">
            <div className="dimension-picker-modal">
              <h2>Select Dimension</h2>
              <p className="dimension-picker-subtitle">This world contains multiple dimensions</p>
              <div className="dimension-list">
                {dimensionPicker.dimensions.map((dim) => (
                  <button
                    key={dim.id}
                    className="dimension-option"
                    onClick={() => handleDimensionSelect(dim)}
                  >
                    <span className="dimension-icon">
                      {dim.id === 'overworld' ? '🌍' : 
                       dim.id === 'the_nether' ? '🔥' : 
                       dim.id === 'the_end' ? '🌌' : '✨'}
                    </span>
                    <span className="dimension-info">
                      <span className="dimension-name">{dim.name}</span>
                      <span className="dimension-regions">{dim.regionCount} region{dim.regionCount !== 1 ? 's' : ''}</span>
                    </span>
                  </button>
                ))}
              </div>
              <button className="dimension-cancel" onClick={handleDimensionCancel}>
                Cancel
              </button>
            </div>
          </div>
        )}
        
        {(buildProgress.isBuilding || buildProgress.stage === 'complete') && (
          <div className="build-overlay">
            <div className="build-progress-container">
              {/* Simple progress bar */}
              {(() => {
                // Calculate overall progress (0-100%)
                // For streaming: 'streaming' phase is 0-50%, 'meshing' phase is 50-100%
                // For progressive: parsing(0-10%), decoding(10-20%), meshing(20-50%), adding(50-90%), particles(90-100%)
                const overallProgress = (() => {
                  const stage = buildProgress.stage;
                  const stageProgress = buildProgress.stageProgress || 0;
                  
                  if (stage === 'streaming') {
                    // Chunk loading: 0-50%
                    const ratio = buildProgress.total > 0 ? buildProgress.current / buildProgress.total : 0;
                    return Math.round(ratio * 50);
                  }
                  if (stage === 'meshing') {
                    // Mesh building: 50-100%
                    return 50 + Math.round(stageProgress * 0.5);
                  }
                  if (stage === 'parsing') return 5;
                  if (stage === 'decoding') return 15;
                  if (stage === 'adding') return 50 + Math.round(stageProgress * 0.4);
                  if (stage === 'particles') return 90 + Math.round(stageProgress * 0.1);
                  if (stage === 'complete') return 100;
                  return 0;
                })();
                
                return (
                  <>
                    <div className="build-progress-header">
                      <span>{buildProgress.message || 'Loading...'}</span>
                      <span>{overallProgress}%</span>
                    </div>
                    <div className="build-progress-bar">
                      <div 
                        className="build-progress-fill"
                        style={{ width: `${overallProgress}%` }}
                      />
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        )}
        {hasContent && !loading ? (
          <RegionViewer
            key={rerenderKey}
            chunks={chunks}
            regions={regionFiles}
            entityRegions={entityRegionFiles}
            parseRegion={parseMCAFile}
            parseEntityRegion={parseEntityRegionFile}
            onBuildProgress={handleBuildProgress}
            enableModelMeshes={enableModelMeshes}
            enableLighting={enableLighting}
            debugMode={debugMode}
            onBlockHover={debugMode && !lockedBlock ? setHoveredBlock : null}
            onBlockClick={debugMode ? (block) => {
              setLockedBlock(block);
              setHoveredBlock(block); // Also set hovered so it shows in the UI
              // Fetch comprehensive block details from ChunkManager
              if (chunkManagerRef.current) {
                const details = chunkManagerRef.current.getBlockDetails(block.x, block.y, block.z);
                setBlockDetails(details);
              }
            } : null}
            chunkManagerRef={chunkManagerRef}
            onCameraUpdate={handleCameraUpdate}
            spectatorRef={spectatorRef}
            textureMode={textureMode}
            textureAtlas={textureAtlas}
            particleAtlas={particleAtlas}
            packManager={packManager}
            worldSpawn={worldSpawn}
            fov={fov}
            targetResolution={targetResolution}
            partialBlockDistance={renderDistance === 0 ? 0 : renderDistance * 16}
            renderDistance={renderDistance}
            particleDistance={particleDistance}
            particleQuality={particleQuality}
            fogEnabled={fogEnabled}
            timeOfDay={timeOfDay}
            brightness={brightness}
            enableRGSS={enableRGSS}
            cloudsEnabled={cloudsEnabled}
            continuousGlass={continuousGlass}
            enableChunkStreaming={chunkStreamingEnabled}
            chunkStreamDistance={renderDistance === 0 ? 16 : renderDistance} // Use render distance for streaming
            chunkLoadingSpeed={chunkLoadingSpeed}
            dimension={currentDimension}
          />
        ) : !loading && (
          <div className="empty-state">
            <div className="empty-icon">⛏️</div>
            <h2>Region Viewer</h2>
            <p>Upload MCA region files or a world .zip to visualize in 3D</p>
          </div>
        )}
      </div>

      {/* Sidebar Toggle Button */}
      <button 
        className={`sidebar-toggle ${sidebarCollapsed ? 'collapsed' : ''}`}
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      >
        <span className="sidebar-toggle-arrow">›</span>
      </button>

      {/* Control Panel */}
      <div className={`control-panel ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="panel-header">
          <h1>Block Viewer</h1>
          <span className="version">v2.0</span>
        </div>

        {/* Compact Coordinates Display */}
        <section className="panel-section coordinates-section-compact">
          <div className="coords-compact">
            <span className="coords-xyz">
              {cameraState.x.toFixed(1)}, {cameraState.y.toFixed(1)}, {cameraState.z.toFixed(1)}
            </span>
            <span className="coords-facing">
              {cameraState.direction} ({cameraState.yaw.toFixed(0)}°, {cameraState.pitch.toFixed(0)}°)
            </span>
          </div>
          <input
            type="text"
            className="command-input"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={handleCommandSubmit}
            placeholder="/tp x y z [yaw] [pitch]"
            spellCheck={false}
          />
          {commandError && (
            <div className="command-error">{commandError}</div>
          )}
        </section>

        {/* File Upload */}
        <section className="panel-section">
          <h3>Region Files</h3>
          <div className="file-upload-group">
            {/* Main region loading row */}
            <div className="file-upload-row">
              <label className="file-upload">
                <input 
                  type="file" 
                  accept=".mca,.mcr,.zip"
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
              {hasContent && (
                <label className="file-upload file-upload-add">
                  <input 
                    type="file" 
                    accept=".mca,.mcr,.zip"
                    onChange={handleAddRegionFiles}
                    disabled={loading}
                    multiple
                  />
                  <span className="upload-button upload-button-secondary">
                    {loading ? '...' : '➕ Add'}
                  </span>
                </label>
              )}
            </div>
            {/* Entity region file upload - hidden until fully implemented */}
            {/* <label className="file-upload file-upload-entity">
              <input 
                type="file" 
                accept=".mca"
                onChange={handleEntityRegionUpload}
                disabled={loading}
                multiple
              />
              <span className="upload-button upload-button-entity" title="Load entity region files from world/entities/ folder (item frames, paintings, armor stands)">
                {loading ? '...' : '🖼️ Load Entities'}
              </span>
            </label> */}
          </div>
          {fileName && (
            <div className="file-info">
              <span className="file-name">{fileName}</span>
              <span className="chunk-count">
                {regionFiles.length > 0 ? `${regionFiles.length} regions` : `${chunks.length} chunks`}
              </span>
            </div>
          )}
          {hasContent && (
            <button 
              className="rerender-button"
              onClick={() => setRerenderKey(k => k + 1)}
              title="Rebuild scene from loaded regions (useful after React hot-reload)"
            >
              🔄 Rerender
            </button>
          )}
          {error && <div className="error-message">⚠️ {error}</div>}
        </section>

        {/* Texture Pack */}
        <section className="panel-section">
          <h3>Textures</h3>
          <div className="texture-mode-selector">
            <label className={`texture-mode-option ${textureMode === TEXTURE_MODE.DEFAULT_PACK ? 'active' : ''}`}>
              <input
                type="radio"
                name="textureMode"
                value={TEXTURE_MODE.DEFAULT_PACK}
                checked={textureMode === TEXTURE_MODE.DEFAULT_PACK}
                onChange={() => setTextureMode(TEXTURE_MODE.DEFAULT_PACK)}
                disabled={texturePackLoading}
              />
              <span className="texture-mode-label">
                <span className="texture-mode-icon">📦</span>
                Vanilla Resource Pack
              </span>
            </label>
            <label className={`texture-mode-option ${textureMode === TEXTURE_MODE.SOLID_COLOR ? 'active' : ''}`}>
              <input
                type="radio"
                name="textureMode"
                value={TEXTURE_MODE.SOLID_COLOR}
                checked={textureMode === TEXTURE_MODE.SOLID_COLOR}
                onChange={() => setTextureMode(TEXTURE_MODE.SOLID_COLOR)}
                disabled={texturePackLoading}
              />
              <span className="texture-mode-label">
                <span className="texture-mode-icon">🎨</span>
                Solid Colors
              </span>
            </label>
          </div>
          
          <div className="texture-pack-import">
            <label className="file-upload file-upload-texture">
              <input
                type="file"
                accept=".zip"
                onChange={handleTexturePackUpload}
                disabled={texturePackLoading}
              />
              <span className="upload-button upload-button-secondary">
                {texturePackLoading ? (
                  <>
                    <span className="spinner"></span>
                    Loading...
                  </>
                ) : (
                  <>📥 Load Resource Pack</>
                )}
              </span>
            </label>
          </div>
          
          {texturePackInfo && textureMode !== TEXTURE_MODE.SOLID_COLOR && (
            <div className="texture-pack-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span className="texture-pack-name">{texturePackInfo.name}</span>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  {atlasDebugUrl && (
                    <button
                      onClick={() => window.open(atlasDebugUrl, '_blank')}
                      title="View block texture atlas"
                      style={{
                        padding: '0.2rem 0.4rem',
                        background: 'var(--bg-hover)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--text-muted)',
                        fontSize: '0.7rem',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.borderColor = 'var(--accent-primary)';
                        e.target.style.color = 'var(--text-primary)';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.borderColor = 'var(--border-subtle)';
                        e.target.style.color = 'var(--text-muted)';
                      }}
                    >
                      Blocks
                    </button>
                  )}
                  {particleAtlasDebugUrl && (
                    <button
                      onClick={() => window.open(particleAtlasDebugUrl, '_blank')}
                      title="View particle texture atlas"
                      style={{
                        padding: '0.2rem 0.4rem',
                        background: 'var(--bg-hover)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--text-muted)',
                        fontSize: '0.7rem',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.borderColor = 'var(--accent-primary)';
                        e.target.style.color = 'var(--text-primary)';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.borderColor = 'var(--border-subtle)';
                        e.target.style.color = 'var(--text-muted)';
                      }}
                    >
                      Particles
                    </button>
                  )}
                </div>
              </div>
              <span className="texture-pack-stats">
                {texturePackInfo.textureCount} textures
              </span>
            </div>
          )}
        </section>

        {/* Render Options */}
        <section className="panel-section">
          <h3>Render Options</h3>
          
          {/* FOV Control - for matching Minecraft screenshots */}
          <div className="fov-control" style={{ marginTop: '0.75rem' }}>
            <div className="fov-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="toggle-label">
                FOV
              </span>
              <span className="fov-value" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{fov}°</span>
            </div>
            <input 
              type="range"
              min="30"
              max="110"
              value={fov}
              onChange={(e) => setFov(parseInt(e.target.value, 10))}
              style={{ width: '100%', marginTop: '0.25rem' }}
            />
          </div>
          
          {/* Render Distance Control */}
          <div className="fov-control" style={{ marginTop: '0.75rem' }}>
            <div className="fov-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="toggle-label">
                Render Distance
              </span>
              <span className="fov-value" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {renderDistance === 0 ? '∞' : `${renderDistance} chunks`}
              </span>
            </div>
            <input 
              type="range"
              min="3"
              max="65"
              step="1"
              value={renderDistance === 0 ? 65 : renderDistance}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                // If slider is at max (65), set to 0 for unlimited
                setRenderDistance(val > 64 ? 0 : val);
              }}
              style={{ width: '100%', marginTop: '0.25rem' }}
            />
          </div>
          
          {/* Particle Distance Control */}
          <div className="fov-control" style={{ marginTop: '0.75rem' }}>
            <div className="fov-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="toggle-label">
                Particle Distance
              </span>
              <span className="fov-value" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {particleDistance} chunks
              </span>
            </div>
            <input 
              type="range"
              min="1"
              max="16"
              step="1"
              value={particleDistance}
              onChange={(e) => setParticleDistance(parseInt(e.target.value, 10))}
              style={{ width: '100%', marginTop: '0.25rem' }}
            />
          </div>
          
          {/* Time of Day Control */}
          <div className="fov-control" style={{ marginTop: '0.75rem' }}>
            <div className="fov-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="toggle-label">
                Time of Day
              </span>
              <span className="fov-value" style={{ fontFamily: 'monospace', fontSize: '0.85rem', textAlign: 'right' }}>
                {(() => {
                  // timeOfDay: 0=midnight (00:00), 0.5=noon (12:00), 1=midnight (24:00)
                  const totalMins = Math.round(timeOfDay * 24 * 60);
                  const hours = Math.floor(totalMins / 60) % 24;
                  const mins = totalMins % 60;
                  // Minecraft ticks: 0=6am, 6000=noon, 12000=6pm, 18000=midnight
                  // Convert from our timeOfDay (0=midnight) to MC ticks (0=6am)
                  const mcTicks = Math.round(((timeOfDay - 0.25 + 1) % 1) * 24000);
                  return (
                    <>
                      {hours.toString().padStart(2, '0')}:{mins.toString().padStart(2, '0')}
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: '0.4rem' }}>
                        ({mcTicks.toLocaleString()}t)
                      </span>
                    </>
                  );
                })()}
              </span>
            </div>
            <input 
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(parseFloat(e.target.value))}
              style={{ width: '100%', marginTop: '0.25rem' }}
            />
          </div>
          
          {/* Brightness Slider - matches Minecraft's brightness setting */}
          <div className="toggle-item" style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="toggle-label">
                Brightness
              </span>
              <span className="fov-value" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {brightness === 0 ? 'Moody' : brightness === 100 ? 'Bright' : `${brightness}%`}
              </span>
            </div>
            <input 
              type="range"
              min="0"
              max="100"
              step="1"
              value={brightness}
              onChange={(e) => setBrightness(parseInt(e.target.value, 10))}
              style={{ width: '100%', marginTop: '0.25rem' }}
            />
          </div>
          
          {/* Resolution Control */}
          <div className="fov-control" style={{ marginTop: '0.75rem' }}>
            <div className="fov-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="toggle-label">
                Resolution
              </span>
            </div>
            <select
              value={targetResolution}
              onChange={(e) => setTargetResolution(e.target.value)}
              style={{ marginTop: '0.35rem' }}
            >
              <option value="native">Native</option>
              <option value="2160">4K (2160p)</option>
              <option value="1440">1440p</option>
              <option value="1080">1080p</option>
              <option value="720">720p</option>
            </select>
          </div>
          
          {/* Checkbox toggles */}
          
          <button 
            className={`toggle-option ${particleQuality !== 'off' ? 'enabled' : ''}`}
            style={{ 
              marginTop: '0.75rem', 
              width: '100%', 
              textAlign: 'left',
              cursor: 'pointer',
            }}
            onClick={() => {
              // Cycle: all -> decreased -> minimal -> off -> all
              const cycle = { 'all': 'decreased', 'decreased': 'minimal', 'minimal': 'off', 'off': 'all' };
              setParticleQuality(cycle[particleQuality]);
            }}
          >
            <span className="toggle-label">
              Particles: {particleQuality === 'all' ? 'All' : particleQuality === 'decreased' ? 'Decreased' : particleQuality === 'minimal' ? 'Minimal' : 'Off'}
            </span>
          </button>
          
          <label className={`toggle-option ${enableLighting ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={enableLighting}
              onChange={(e) => setEnableLighting(e.target.checked)}
            />
            <span className="toggle-label">
              Smooth Lighting
            </span>
          </label>
          <label className={`toggle-option ${fogEnabled ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={fogEnabled}
              onChange={(e) => setFogEnabled(e.target.checked)}
            />
            <span className="toggle-label">
              Fog
            </span>
          </label>
          <label className={`toggle-option ${cloudsEnabled ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={cloudsEnabled}
              onChange={(e) => setCloudsEnabled(e.target.checked)}
            />
            <span className="toggle-label">
              Clouds
            </span>
          </label>
          <label className={`toggle-option ${enableRGSS ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={enableRGSS}
              onChange={(e) => setEnableRGSS(e.target.checked)}
            />
            <span className="toggle-label">
              Anti-Aliasing
            </span>
          </label>
          <label className={`toggle-option ${continuousGlass ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={continuousGlass}
              onChange={(e) => setContinuousGlass(e.target.checked)}
            />
            <span className="toggle-label">
              Continuous Glass
              <span style={{ 
                fontSize: '0.6rem', 
                background: 'rgba(99, 102, 241, 0.4)', 
                padding: '0.1rem 0.35rem', 
                borderRadius: '3px',
                marginLeft: '0.3rem',
                fontWeight: '600',
                letterSpacing: '0.5px',
              }}>BETA</span>
            </span>
          </label>
          <label className={`toggle-option ${debugMode ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
            />
            <span className="toggle-label">
              Block Inspector
              <span style={{ 
                fontSize: '0.6rem', 
                background: 'rgba(99, 102, 241, 0.4)', 
                padding: '0.1rem 0.35rem', 
                borderRadius: '3px',
                marginLeft: '0.3rem',
                fontWeight: '600',
                letterSpacing: '0.5px',
              }}>BETA</span>
            </span>
          </label>
          
          {/* Chunk Streaming Mode */}
          <div 
            className={`toggle-option ${chunkStreamingEnabled ? 'enabled' : ''}`} 
            style={{ marginTop: '0.5rem', flexDirection: 'column', alignItems: 'stretch' }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', cursor: 'pointer', width: '100%' }}>
              <input 
                type="checkbox"
                checked={chunkStreamingEnabled}
                onChange={(e) => setChunkStreamingEnabled(e.target.checked)}
              />
              <span className="toggle-label">
                Chunk Streaming
                <span style={{ 
                  fontSize: '0.6rem', 
                  background: 'rgba(99, 102, 241, 0.4)', 
                  padding: '0.1rem 0.35rem', 
                  borderRadius: '3px',
                  marginLeft: '0.3rem',
                  fontWeight: '600',
                  letterSpacing: '0.5px',
                }}>BETA</span>
              </span>
            </label>
            
            {/* Expanded content when enabled */}
            {chunkStreamingEnabled && (
              <div style={{ 
                marginTop: '0.75rem', 
                paddingTop: '0.75rem', 
                borderTop: '1px solid rgba(255,255,255,0.1)',
                width: '100%',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>
                    Loading Speed
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-primary)' }}>
                    {chunkLoadingSpeed === 1 ? 'Smooth' : chunkLoadingSpeed <= 2 ? 'Balanced' : chunkLoadingSpeed <= 4 ? 'Fast' : 'Fastest'}
                  </span>
                </div>
                <input 
                  type="range"
                  min="1"
                  max="8"
                  step="1"
                  value={chunkLoadingSpeed}
                  onChange={(e) => setChunkLoadingSpeed(parseInt(e.target.value, 10))}
                  style={{ width: '100%', marginTop: '0.35rem' }}
                />
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem', opacity: 0.7 }}>
                  How many chunks to process at once
                </div>
              </div>
            )}
          </div>
          
          {/* Debug Page Link */}
          <a 
            href="#debug" 
            style={{ 
              display: 'block',
              marginTop: '0.75rem',
              padding: '0.5rem 0.75rem',
              background: 'rgba(96, 165, 250, 0.15)',
              border: '1px solid rgba(96, 165, 250, 0.3)',
              borderRadius: '4px',
              color: '#60a5fa',
              textDecoration: 'none',
              fontSize: '0.85rem',
              textAlign: 'center'
            }}
          >
            🧪 Partial Block Debug Page
          </a>
        </section>
        
        {/* Debug Info Panel */}
        {debugMode && (
          <section className="panel-section debug-panel">
            <h3>
              Block Inspector
              {lockedBlock && (
                <button
                  onClick={() => {
                    setLockedBlock(null);
                    setHoveredBlock(null);
                    setBlockDetails(null);
                  }}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.15rem 0.5rem',
                    fontSize: '0.7rem',
                    background: 'rgba(239, 68, 68, 0.3)',
                    border: '1px solid rgba(239, 68, 68, 0.5)',
                    borderRadius: '4px',
                    color: '#fca5a5',
                    cursor: 'pointer',
                    fontWeight: '500',
                  }}
                >
                  Unlock
                </button>
              )}
            </h3>
            {lockedBlock && blockDetails ? (
              <div className="debug-block-info">
                {/* Block Name - Prominent */}
                <div className="debug-row debug-row-highlight">
                  <span className="debug-label">Block</span>
                  <span className="debug-value debug-block-name">
                    {blockDetails.displayName}
                  </span>
                </div>
                
                {/* Position */}
                <div className="debug-section-header">Position</div>
                <div className="debug-row">
                  <span className="debug-label">World</span>
                  <span className="debug-value">
                    {blockDetails.position.x}, {blockDetails.position.y}, {blockDetails.position.z}
                  </span>
                </div>
                <div className="debug-row">
                  <span className="debug-label">Chunk</span>
                  <span className="debug-value">
                    {blockDetails.chunk.x}, {blockDetails.chunk.z}
                  </span>
                </div>
                <div className="debug-row">
                  <span className="debug-label">Local</span>
                  <span className="debug-value">
                    {blockDetails.localPosition.x}, {blockDetails.localPosition.y}, {blockDetails.localPosition.z}
                  </span>
                </div>
                {lockedBlock.face && (
                  <div className="debug-row">
                    <span className="debug-label">Face</span>
                    <span className="debug-value">{lockedBlock.face}</span>
                  </div>
                )}
                
                {/* Properties */}
                <div className="debug-section-header">Properties</div>
                <div className="debug-row">
                  <span className="debug-label">Category</span>
                  <span className="debug-value">{blockDetails.categoryName}</span>
                </div>
                <div className="debug-row">
                  <span className="debug-label">Render</span>
                  <span className="debug-value">{blockDetails.renderType}</span>
                </div>
                {blockDetails.isRotatable && (
                  <div className="debug-row">
                    <span className="debug-label">Axis</span>
                    <span className="debug-value">{blockDetails.axisName}</span>
                  </div>
                )}
                {blockDetails.isFluid && (
                  <div className="debug-row">
                    <span className="debug-label">Fluid Level</span>
                    <span className="debug-value">{blockDetails.fluidLevel}</span>
                  </div>
                )}
                {blockDetails.isWaterlogged && (
                  <div className="debug-row">
                    <span className="debug-label">Waterlogged</span>
                    <span className="debug-value">Yes</span>
                  </div>
                )}
                
                {/* Block State Properties (facing, half, powered, etc.) */}
                {blockDetails.blockState && Object.keys(blockDetails.blockState).length > 0 && (
                  <>
                    <div className="debug-section-header">Block State</div>
                    {Object.entries(blockDetails.blockState).map(([key, value]) => (
                      <div className="debug-row" key={key}>
                        <span className="debug-label">{key}</span>
                        <span className="debug-value">{String(value)}</span>
                      </div>
                    ))}
                  </>
                )}
                
                {/* Block Entity NBT Data (chests, signs, beacons, etc.) */}
                {blockDetails.blockEntity && Object.keys(blockDetails.blockEntity).length > 0 && (
                  <>
                    <div className="debug-section-header">Block Entity (NBT)</div>
                    {Object.entries(blockDetails.blockEntity).map(([key, value]) => (
                      <div className="debug-row" key={key}>
                        <span className="debug-label">{key}</span>
                        <span className="debug-value debug-nbt-value">
                          {typeof value === 'object' ? JSON.stringify(value, null, 0) : String(value)}
                        </span>
                      </div>
                    ))}
                  </>
                )}
                
                {/* Technical */}
                <div className="debug-section-header">Technical</div>
                <div className="debug-row">
                  <span className="debug-label">ID</span>
                  <span className="debug-value debug-id">{blockDetails.name}</span>
                </div>
                <div className="debug-row">
                  <span className="debug-label">Block ID</span>
                  <span className="debug-value">{blockDetails.rawBlockId}</span>
                </div>
                
                {lockedBlock.color && (
                  <div className="debug-row">
                    <span className="debug-label">Color</span>
                    <span className="debug-value debug-color-value">
                      <span 
                        className="debug-color-swatch" 
                        style={{ backgroundColor: `rgb(${Math.round(lockedBlock.color.r * 255)}, ${Math.round(lockedBlock.color.g * 255)}, ${Math.round(lockedBlock.color.b * 255)})` }}
                      />
                      RGB({Math.round(lockedBlock.color.r * 255)}, {Math.round(lockedBlock.color.g * 255)}, {Math.round(lockedBlock.color.b * 255)})
                    </span>
                  </div>
                )}
                
                {/* Locked indicator */}
                <div className="debug-locked-indicator" style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  marginTop: '0.75rem',
                  padding: '0.3rem 0.5rem',
                  background: 'rgba(34, 197, 94, 0.2)',
                  border: '1px solid rgba(34, 197, 94, 0.4)',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  color: '#86efac',
                }}>
                  <span>🔒</span> Locked - click canvas to resume
                </div>
              </div>
            ) : (
              <div className="debug-empty">
                <span className="debug-empty-icon">🎯</span>
                <p>Click on a block to inspect it</p>
              </div>
            )}
          </section>
        )}

        {/* Instructions */}
        <section className="panel-section instructions">
          <h3>Controls</h3>
          <p className="controls-hint">Click on viewer to enable controls</p>
          <ul>
            <li><kbd>Mouse</kbd> Look around</li>
            <li><kbd>W A S D</kbd> Move</li>
            <li><kbd>Space</kbd> Up</li>
            <li><kbd>Shift</kbd> Down</li>
            <li><kbd>Ctrl</kbd> Sprint (2x)</li>
            <li><kbd>Scroll</kbd> Speed (0.06x–32x)</li>
            <li><kbd>Esc</kbd> Release mouse</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

export default App;
