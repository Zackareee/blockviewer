import { useState, useCallback, useEffect, useRef } from 'react';
import { RegionViewer } from './viewer';
import { parseMCAFile } from './utils/mcaParser';
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
  
  // Rerender key - increment to force RegionViewer remount (useful after React hot-reload)
  const [rerenderKey, setRerenderKey] = useState(0);
  
  // Model meshes toggle (non-cube blocks like slabs, stairs, flowers)
  const [enableModelMeshes, setEnableModelMeshes] = useState(true);
  
  // Lighting toggle (lightmap-based lighting vs fixed face shading)
  const [enableLighting, setEnableLighting] = useState(true);
  
  // Debug mode - shows block info on hover
  const [debugMode, setDebugMode] = useState(false);
  const [hoveredBlock, setHoveredBlock] = useState(null);
  
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
  const [timeOfDay, setTimeOfDay] = useState(0.35); // Default to mid-morning
  
  // Brightness setting (0-100: 0=Moody, 100=Bright) - matches Minecraft's brightness slider
  const [brightness, setBrightness] = useState(50); // Default to 50% like typical Minecraft settings
  
  // RGSS anti-aliasing (Rotated Grid Super-Sampling) - Minecraft's texture smoothing
  const [enableRGSS, setEnableRGSS] = useState(true);
  
  // Clouds toggle
  const [cloudsEnabled, setCloudsEnabled] = useState(true);
  
  // Continuous glass (connected glass textures - removes borders between adjacent glass blocks)
  const [continuousGlass, setContinuousGlass] = useState(false);
  
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
  
  // Load default texture pack when mode changes to default
  useEffect(() => {
    if (textureMode === TEXTURE_MODE.DEFAULT_PACK && !texturePackInfo) {
      loadDefaultTexturePack();
    }
  }, [textureMode]);
  
  // Load the default bundled texture pack
  const loadDefaultTexturePack = useCallback(async () => {
    setTexturePackLoading(true);
    try {
      const pm = getDefaultPackManager();
      await pm.loadDefaultPack();
      setPackManager(pm); // Store for beacon beams etc.
      
      // Debug: Validate textures are loaded correctly
      pm.debugValidateTextures();
      
      const atlas = getTextureAtlas();
      await atlas.build(pm);
      
      // Pre-register all known blocks from BLOCK_COLORS to the registry
      // This is necessary because blocks are normally registered during chunk decoding,
      // but we need them registered now to build the texture index lookup
      const blockRegistry = getBlockRegistry();
      const blockNames = Object.keys(BLOCK_COLORS);
      console.log(`[App] Pre-registering ${blockNames.length} blocks from BLOCK_COLORS...`);
      
      for (const blockName of blockNames) {
        blockRegistry.registerBlock(blockName);
      }
      
      // Verify registration worked
      const registrySize = blockRegistry.idToInfo.length;
      console.log(`[App] Pre-registered ${blockNames.length} blocks, registry now has ${registrySize} entries`);
      
      // Log a few sample blocks to verify IDs
      const sampleBlocks = ['minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:oak_planks'];
      for (const name of sampleBlocks) {
        const id = blockRegistry.nameToId.get(name);
        console.log(`[App]   ${name} -> ID ${id}`);
      }
      
      // Build the TextureIndexLookup which maps (blockId, face) -> atlas index
      atlas.buildTextureIndexLookup(blockRegistry);
      
      // Build particle atlas for torch flames, smoke, etc.
      const pAtlas = getParticleAtlas();
      const particleBuildSuccess = await pAtlas.build(pm);
      console.log('[App] Particle atlas built:', particleBuildSuccess, 'isBuilt:', pAtlas.isBuilt, 'textures:', pAtlas.particleLookup?.size || 0);
      setParticleAtlas(pAtlas);
      
      // Set the material data (includes atlas, textureIndexLookup, and size)
      setTextureAtlas(atlas.getMaterialData());
      setTexturePackInfo(pm.getPackInfo());
      
      // Debug: generate atlas preview URL
      setAtlasDebugUrl(atlas.toDataURL());
      
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
      
      const atlas = getTextureAtlas();
      await atlas.build(customPack);
      
      // Pre-register all known blocks from BLOCK_COLORS to the registry
      const blockRegistry = getBlockRegistry();
      const blockNames = Object.keys(BLOCK_COLORS);
      console.log(`[App] Pre-registering ${blockNames.length} blocks for custom pack...`);
      
      for (const blockName of blockNames) {
        blockRegistry.registerBlock(blockName);
      }
      
      console.log(`[App] Registry now has ${blockRegistry.idToInfo.length} entries`);
      
      // Build the TextureIndexLookup which maps (blockId, face) -> atlas index
      atlas.buildTextureIndexLookup(blockRegistry);
      
      setTextureAtlas(atlas.getMaterialData());
      setTexturePackInfo(customPack.getPackInfo());
      setTextureMode(TEXTURE_MODE.CUSTOM_PACK);
      
      // Debug: generate atlas preview URL
      setAtlasDebugUrl(atlas.toDataURL());
      
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
        {buildProgress.isBuilding && (
          <div className="build-overlay">
            <div className="build-progress-container">
              {/* Region header */}
              <div className="streaming-region-header">
                <span>Region {buildProgress.current + 1} of {buildProgress.total}</span>
                {buildProgress.regionName && (
                  <span className="streaming-region-name">{buildProgress.regionName}</span>
                )}
              </div>
              
              {/* Stage indicators */}
              <div className="build-stages">
                {['processing', 'adding', 'particles'].map((stageName, idx) => {
                  const stageLabels = {
                    processing: '🧱 Processing',
                    adding: '🎨 Adding to Scene',
                    particles: '✨ Particles',
                  };
                  const stageOrder = ['processing', 'adding', 'particles'];
                  // Map internal stages to UI stages
                  const currentUIStage = ['parsing', 'decoding', 'meshing'].includes(buildProgress.stage) 
                    ? 'processing' 
                    : buildProgress.stage;
                  const currentIdx = stageOrder.indexOf(currentUIStage);
                  const thisIdx = stageOrder.indexOf(stageName);
                  const isActive = stageName === currentUIStage;
                  const isComplete = thisIdx < currentIdx || buildProgress.stage === 'complete';
                  
                  return (
                    <div 
                      key={stageName}
                      className={`build-stage ${isActive ? 'active' : ''} ${isComplete ? 'complete' : ''}`}
                    >
                      <div className="stage-header">
                        <span className="stage-icon">
                          {isComplete ? '✓' : isActive ? '◉' : '○'}
                        </span>
                        <span className="stage-label">{stageLabels[stageName]}</span>
                      </div>
                      {isActive && (
                        <div className={`stage-progress-bar ${stageName === 'processing' ? 'indeterminate' : ''}`}>
                          <div 
                            className="stage-progress-fill"
                            style={{ width: stageName === 'processing' ? '30%' : `${buildProgress.stageProgress || 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              
              {/* Overall progress bar */}
              <div className="build-progress-header">
                <span>{buildProgress.message || 'Processing...'}</span>
                <span>{Math.round((buildProgress.current / buildProgress.total) * 100)}%</span>
              </div>
              <div className="build-progress-bar">
                <div 
                  className="build-progress-fill"
                  style={{ 
                    width: `${((buildProgress.current + (buildProgress.stageProgress || 0) / 100) / buildProgress.total) * 100}%` 
                  }}
                />
              </div>
            </div>
          </div>
        )}
        {hasContent && !loading ? (
          <RegionViewer
            key={rerenderKey}
            chunks={chunks}
            regions={regionFiles}
            parseRegion={parseMCAFile}
            onBuildProgress={handleBuildProgress}
            enableModelMeshes={enableModelMeshes}
            enableLighting={enableLighting}
            debugMode={debugMode}
            onBlockHover={debugMode ? setHoveredBlock : null}
            onCameraUpdate={handleCameraUpdate}
            spectatorRef={spectatorRef}
            textureMode={textureMode}
            textureAtlas={textureAtlas}
            particleAtlas={particleAtlas}
            packManager={packManager}
            fov={fov}
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
          />
        ) : !loading && (
          <div className="empty-state">
            <div className="empty-icon">⛏️</div>
            <h2>Region Viewer</h2>
            <p>Upload MCA region files to visualize your world in 3D</p>
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
            {hasContent && (
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
                Default Pack
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
                  <>📥 Import Pack</>
                )}
              </span>
            </label>
          </div>
          
          {texturePackInfo && textureMode !== TEXTURE_MODE.SOLID_COLOR && (
            <div className="texture-pack-info">
              <span className="texture-pack-name">{texturePackInfo.name}</span>
              <span className="texture-pack-stats">
                {texturePackInfo.textureCount} textures
              </span>
            </div>
          )}
          
          {/* Debug: Atlas Preview */}
          {atlasDebugUrl && textureMode !== TEXTURE_MODE.SOLID_COLOR && (
            <div className="atlas-debug-preview">
              <div className="atlas-debug-label">Atlas Preview (debug)</div>
              <img 
                src={atlasDebugUrl} 
                alt="Texture Atlas" 
                style={{ 
                  width: '100%', 
                  maxWidth: '200px',
                  imageRendering: 'pixelated',
                  border: '1px solid #444',
                  borderRadius: '4px'
                }}
              />
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
                <span className="toggle-icon">📷</span>
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
                <span className="toggle-icon">🗺️</span>
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
                <span className="toggle-icon">✨</span>
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
                <span className="toggle-icon">☀️</span>
                Time of Day
              </span>
              <span className="fov-value" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {(() => {
                  // Convert 0-1 to Minecraft time (0=midnight, 6000=noon, 12000=sunset, 18000=midnight)
                  // Our timeOfDay: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
                  const hours = Math.floor(timeOfDay * 24);
                  const mins = Math.floor((timeOfDay * 24 - hours) * 60);
                  // Map to 6am = sunrise (0.25), noon = 0.5, 6pm = 0.75, midnight = 0
                  const displayHour = (hours + 6) % 24;
                  return `${displayHour.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
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
                <span className="toggle-icon">☀️</span>
                Gamma
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
          
          {/* Checkbox toggles */}
          <label className={`toggle-option ${enableModelMeshes ? 'enabled' : ''}`} style={{ marginTop: '0.75rem' }}>
            <input 
              type="checkbox"
              checked={enableModelMeshes}
              onChange={(e) => setEnableModelMeshes(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">🧱</span>
              Block Models
            </span>
          </label>
          <label className={`toggle-option ${enableLighting ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={enableLighting}
              onChange={(e) => setEnableLighting(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">💡</span>
              Smooth Lighting
            </span>
          </label>
          <label className={`toggle-option ${enableRGSS ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={enableRGSS}
              onChange={(e) => setEnableRGSS(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">✨</span>
              Anti-Aliasing
            </span>
          </label>
          <label className={`toggle-option ${fogEnabled ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={fogEnabled}
              onChange={(e) => setFogEnabled(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">🌫️</span>
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
              <span className="toggle-icon">☁️</span>
              Clouds
            </span>
          </label>
          <label className={`toggle-option ${continuousGlass ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={continuousGlass}
              onChange={(e) => setContinuousGlass(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">🪟</span>
              Continuous Glass
            </span>
          </label>
          <button 
            className="toggle-option enabled"
            style={{ 
              marginTop: '0.5rem', 
              width: '100%', 
              textAlign: 'left',
              cursor: 'pointer',
              border: 'none',
              background: 'rgba(255,255,255,0.05)',
            }}
            onClick={() => {
              // Cycle: all -> decreased -> minimal -> all
              const cycle = { 'all': 'decreased', 'decreased': 'minimal', 'minimal': 'all' };
              setParticleQuality(cycle[particleQuality]);
            }}
          >
            <span className="toggle-label">
              <span className="toggle-icon">✨</span>
              Particles: {particleQuality === 'all' ? 'All' : particleQuality === 'decreased' ? 'Decreased' : 'Minimal'}
            </span>
          </button>
          <label className={`toggle-option ${debugMode ? 'enabled' : ''}`} style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">🔍</span>
              Block Inspector
            </span>
          </label>
          
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
            <h3>Block Inspector</h3>
            {hoveredBlock ? (
              <div className="debug-block-info">
                {hoveredBlock.blockType && (
                  <div className="debug-row debug-row-highlight">
                    <span className="debug-label">Block</span>
                    <span className="debug-value debug-block-name">
                      {hoveredBlock.blockType.replace('minecraft:', '')}
                    </span>
                  </div>
                )}
                <div className="debug-row">
                  <span className="debug-label">Position</span>
                  <span className="debug-value">
                    {hoveredBlock.x}, {hoveredBlock.y}, {hoveredBlock.z}
                  </span>
                </div>
                <div className="debug-row">
                  <span className="debug-label">Chunk</span>
                  <span className="debug-value">
                    {Math.floor(hoveredBlock.x / 16)}, {Math.floor(hoveredBlock.z / 16)}
                  </span>
                </div>
                <div className="debug-row">
                  <span className="debug-label">Face</span>
                  <span className="debug-value">{hoveredBlock.face || 'N/A'}</span>
                </div>
                {hoveredBlock.color && (
                  <div className="debug-row">
                    <span className="debug-label">Color</span>
                    <span className="debug-value debug-color-value">
                      <span 
                        className="debug-color-swatch" 
                        style={{ backgroundColor: `rgb(${Math.round(hoveredBlock.color.r * 255)}, ${Math.round(hoveredBlock.color.g * 255)}, ${Math.round(hoveredBlock.color.b * 255)})` }}
                      />
                      RGB({Math.round(hoveredBlock.color.r * 255)}, {Math.round(hoveredBlock.color.g * 255)}, {Math.round(hoveredBlock.color.b * 255)})
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="debug-empty">
                <span className="debug-empty-icon">🎯</span>
                <p>Hover over a block to inspect</p>
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
