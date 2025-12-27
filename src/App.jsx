import { useState, useCallback } from 'react';
import { RegionViewer } from './viewer';
import { parseMCAFile } from './utils/mcaParser';
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
