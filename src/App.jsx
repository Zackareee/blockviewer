import { useState, useCallback, useEffect } from 'react';
import { RegionViewer } from './viewer';
import { parseMCAFile } from './utils/mcaParser';
import { 
  getDefaultPackManager, 
  getCustomPackManager,
  getTextureAtlas,
  TEXTURE_MODE 
} from './assets';
import { getBlockColorsNumeric, BLOCK_COLORS } from './data/blockColors';
import { getBlockRegistry } from './mesh/BlockRegistry';
import './App.css';

function App() {
  const [chunks, setChunks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  
  // Build progress for region rendering
  const [buildProgress, setBuildProgress] = useState({ current: 0, total: 0, isBuilding: false, message: '' });
  
  // Streaming region loading state
  const [streamingState, setStreamingState] = useState({
    isStreaming: false,
    currentRegionIndex: 0,
    totalRegions: 0,
    currentRegionName: ''
  });
  
  // Region files for progressive loading
  const [regionFiles, setRegionFiles] = useState([]);
  
  // Model meshes toggle (non-cube blocks like slabs, stairs, flowers)
  const [enableModelMeshes, setEnableModelMeshes] = useState(true);
  
  // Debug mode - shows block info on hover
  const [debugMode, setDebugMode] = useState(false);
  const [hoveredBlock, setHoveredBlock] = useState(null);
  
  // Texture pack state
  const [textureMode, setTextureMode] = useState(TEXTURE_MODE.SOLID_COLOR);
  const [texturePackLoading, setTexturePackLoading] = useState(false);
  const [texturePackInfo, setTexturePackInfo] = useState(null);
  const [textureAtlas, setTextureAtlas] = useState(null);
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
      const packManager = getDefaultPackManager();
      await packManager.loadDefaultPack();
      
      // Debug: Validate textures are loaded correctly
      packManager.debugValidateTextures();
      
      const atlas = getTextureAtlas();
      await atlas.build(packManager);
      
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
      
      // Set the material data (includes atlas, textureIndexLookup, and size)
      setTextureAtlas(atlas.getMaterialData());
      setTexturePackInfo(packManager.getPackInfo());
      
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

  const handleBuildProgress = useCallback((current, total, isBuilding, message = '') => {
    setBuildProgress({ current, total, isBuilding, message });
  }, []);

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
        {hasContent && !loading ? (
          <RegionViewer
            chunks={chunks}
            regions={regionFiles}
            parseRegion={parseMCAFile}
            onBuildProgress={handleBuildProgress}
            enableModelMeshes={enableModelMeshes}
            debugMode={debugMode}
            onBlockHover={debugMode ? setHoveredBlock : null}
            textureMode={textureMode}
            textureAtlas={textureAtlas}
          />
        ) : !loading && (
          <div className="empty-state">
            <div className="empty-icon">⛏️</div>
            <h2>Region Viewer</h2>
            <p>Upload MCA region files to visualize your world in 3D</p>
          </div>
        )}
      </div>

      {/* Control Panel */}
      <div className="control-panel">
        <div className="panel-header">
          <h1>Block Viewer</h1>
          <span className="version">v2.0</span>
        </div>

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
          {error && <div className="error-message">⚠️ {error}</div>}
        </section>

        {/* Texture Pack */}
        <section className="panel-section">
          <h3>Textures</h3>
          <div className="texture-mode-selector">
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
          <label className="toggle-option">
            <input 
              type="checkbox"
              checked={enableModelMeshes}
              onChange={(e) => setEnableModelMeshes(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">{enableModelMeshes ? '🧱' : '◻️'}</span>
              Partial Blocks
            </span>
            <span className="toggle-hint">Slabs, stairs, fences, flowers, etc.</span>
          </label>
          <label className="toggle-option" style={{ marginTop: '0.5rem' }}>
            <input 
              type="checkbox"
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
            />
            <span className="toggle-label">
              <span className="toggle-icon">{debugMode ? '🔍' : '👁️'}</span>
              Debug Mode
            </span>
            <span className="toggle-hint">Hover to inspect blocks</span>
          </label>
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
          <ul>
            <li><kbd>Drag</kbd> Rotate view</li>
            <li><kbd>Scroll</kbd> Zoom in/out</li>
            <li><kbd>Right Drag</kbd> Pan view</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

export default App;
