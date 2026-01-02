/**
 * RegionViewer - React wrapper for ChunkManager with Performance Optimizations
 * 
 * Based on R3F performance guidelines:
 * https://r3f.docs.pmnd.rs/advanced/scaling-performance
 * https://r3f.docs.pmnd.rs/advanced/pitfalls
 * 
 * Features:
 * - Movement regression (lower DPR while camera moves)
 * - On-demand rendering (only render when needed)
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { AdaptiveDpr, PerformanceMonitor } from '@react-three/drei';
import { SpectatorControls } from './SpectatorControls';
import { ChunkManager } from './ChunkManager';
import { getBlockNameFromColor } from '../data/blockColors';
import * as THREE from 'three';

/**
 * Adaptive pixel ratio component - reduces DPR when performance drops
 * PERFORMANCE: More aggressive settings for large scenes
 */
function AdaptivePerformance() {
  const { invalidate, gl } = useThree();
  
  return (
    <PerformanceMonitor
      onIncline={() => {
        console.log('[Performance] Quality increasing');
        invalidate();
      }}
      onDecline={() => {
        console.log('[Performance] Quality decreasing - reducing DPR');
        // Force immediate DPR reduction for faster response
        gl.setPixelRatio(Math.max(0.5, gl.getPixelRatio() * 0.75));
        invalidate();
      }}
      flipflops={3}   // PERFORMANCE: Faster response to drops
      factor={0.75}   // PERFORMANCE: More aggressive changes
      iterations={5}  // PERFORMANCE: Check performance more frequently
    >
      <AdaptiveDpr pixelated />
    </PerformanceMonitor>
  );
}

/**
 * Dynamic FOV updater - updates camera FOV when prop changes
 */
function DynamicFOV({ fov }) {
  const { camera, invalidate } = useThree();
  
  useEffect(() => {
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      invalidate();
    }
  }, [camera, fov, invalidate]);
  
  return null;
}

/**
 * Movement regression - lower quality while camera is moving
 * This helps maintain smooth framerates during orbit/pan
 * PERFORMANCE: Only regress every N frames to reduce overhead
 */
function MovementRegression() {
  const { performance: perf } = useThree();
  const lastPos = useRef({ x: 0, y: 0, z: 0 });
  const frameCounter = useRef(0);
  
  // Only check every 5 frames to reduce useFrame overhead
  useFrame(({ camera }) => {
    frameCounter.current++;
    if (frameCounter.current < 5) return;
    frameCounter.current = 0;
    
    const dx = camera.position.x - lastPos.current.x;
    const dy = camera.position.y - lastPos.current.y;
    const dz = camera.position.z - lastPos.current.z;
    const moved = dx * dx + dy * dy + dz * dz > 1.0; // Increased threshold
    
    lastPos.current.x = camera.position.x;
    lastPos.current.y = camera.position.y;
    lastPos.current.z = camera.position.z;
    
    if (moved) {
      perf.regress();
    }
  });
  
  return null;
}

/**
 * Throttled LOD updater - incrementally updates LODs
 * PERFORMANCE: Now uses incremental updates (10 LODs per call) to avoid lag spikes
 * Updates happen every few frames to spread work evenly
 * 
 * NOTE: When DISABLE_LOD_OBJECTS is true in ChunkManager, this does nothing
 * since there are no LOD objects to update.
 */
function ThrottledLODUpdater({ managerRef }) {
  const frameCount = useRef(0);
  
  // Update LODs every N frames - now safe since updates are incremental
  const UPDATE_INTERVAL_FRAMES = 3;  // Every 3 frames (spreads work evenly)
  
  useFrame(({ camera }) => {
    frameCount.current++;
    
    if (frameCount.current >= UPDATE_INTERVAL_FRAMES && managerRef.current) {
      // This will be a no-op if there are no LOD objects
      managerRef.current.updateLODs(camera);
      frameCount.current = 0;
    }
  });
  
  return null;
}

/**
 * Debug block highlight - shows red wireframe around hovered block
 */
function BlockHighlight({ position }) {
  const boxRef = useRef();
  
  // Wireframe cube geometry (1x1x1 block)
  const geometry = useMemo(() => new THREE.BoxGeometry(1.02, 1.02, 1.02), []);
  const material = useMemo(() => new THREE.LineBasicMaterial({ 
    color: 0xff0000, 
    linewidth: 2,
    depthTest: false,
    transparent: true,
    opacity: 0.9
  }), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  
  if (!position) return null;
  
  return (
    <lineSegments 
      ref={boxRef}
      position={[position.x + 0.5, position.y + 0.5, position.z + 0.5]}
      geometry={edges}
      material={material}
      renderOrder={1000}
    />
  );
}

/**
 * Debug mode hook - handles raycasting and block detection
 * Uses aggressive throttling to prevent lag from expensive raycasting
 */
function useBlockHover(debugMode, onBlockHover) {
  const { scene, camera, gl, invalidate } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const hoveredBlockRef = useRef(null);
  const throttleRef = useRef(null);
  const lastMousePos = useRef({ x: 0, y: 0 });
  
  // Very aggressive throttle - 150ms between raycasts
  const THROTTLE_MS = 150;
  
  useEffect(() => {
    if (!debugMode) {
      // Clear hover state when debug mode is disabled
      if (onBlockHover) onBlockHover(null);
      hoveredBlockRef.current = null;
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      return;
    }
    
    const performRaycast = () => {
      const mouse = new THREE.Vector2(lastMousePos.current.x, lastMousePos.current.y);
      raycaster.setFromCamera(mouse, camera);
      
      // Only raycast against the main groups (solid, water, lava, model)
      // Find them by looking for groups that are direct children of scene
      const meshes = [];
      scene.children.forEach(child => {
        if (child.isGroup) {
          child.traverse(obj => {
            if (obj.isMesh && obj.geometry && obj.visible) {
              meshes.push(obj);
            }
          });
        }
      });
      
      if (meshes.length === 0) return;
      
      const intersects = raycaster.intersectObjects(meshes, false);
      
      if (intersects.length > 0) {
        const hit = intersects[0];
        const point = hit.point;
        const normal = hit.face?.normal || new THREE.Vector3(0, 1, 0);
        
        // Convert to world-space normal
        const worldNormal = normal.clone();
        if (hit.object.matrixWorld) {
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
          worldNormal.applyMatrix3(normalMatrix).normalize();
        }
        
        // Get block position (step slightly into the block)
        const blockX = Math.floor(point.x - worldNormal.x * 0.01);
        const blockY = Math.floor(point.y - worldNormal.y * 0.01);
        const blockZ = Math.floor(point.z - worldNormal.z * 0.01);
        
        // Skip if same block
        const prev = hoveredBlockRef.current;
        if (prev && prev.x === blockX && prev.y === blockY && prev.z === blockZ) {
          return;
        }
        
        // Determine face name
        let faceName = 'unknown';
        const ax = Math.abs(worldNormal.x);
        const ay = Math.abs(worldNormal.y);
        const az = Math.abs(worldNormal.z);
        
        if (ax > ay && ax > az) {
          faceName = worldNormal.x > 0 ? 'east (+X)' : 'west (-X)';
        } else if (ay > ax && ay > az) {
          faceName = worldNormal.y > 0 ? 'top (+Y)' : 'bottom (-Y)';
        } else {
          faceName = worldNormal.z > 0 ? 'south (+Z)' : 'north (-Z)';
        }
        
        // Get vertex color and block type from color
        let color = null;
        let blockType = null;
        
        if (hit.object.geometry.attributes.color && hit.face) {
          const colorAttr = hit.object.geometry.attributes.color;
          const idx = hit.face.a;
          if (idx * 3 + 2 < colorAttr.array.length) {
            const r = colorAttr.array[idx * 3];
            const g = colorAttr.array[idx * 3 + 1];
            const b = colorAttr.array[idx * 3 + 2];
            
            color = { r, g, b };
            
            // Look up block name from vertex color
            blockType = getBlockNameFromColor(r, g, b);
          }
        }
        
        
        const blockInfo = {
          x: blockX,
          y: blockY,
          z: blockZ,
          face: faceName,
          color,
          blockType,
          distance: hit.distance.toFixed(1)
        };
        
        hoveredBlockRef.current = blockInfo;
        if (onBlockHover) onBlockHover(blockInfo);
        invalidate();
      } else {
        if (hoveredBlockRef.current) {
          hoveredBlockRef.current = null;
          if (onBlockHover) onBlockHover(null);
          invalidate();
        }
      }
    };
    
    const handleMouseMove = (event) => {
      const rect = gl.domElement.getBoundingClientRect();
      lastMousePos.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      lastMousePos.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      
      // Only schedule if not already scheduled
      if (!throttleRef.current) {
        throttleRef.current = setTimeout(() => {
          throttleRef.current = null;
          performRaycast();
        }, THROTTLE_MS);
      }
    };
    
    const handleMouseLeave = () => {
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      if (hoveredBlockRef.current) {
        hoveredBlockRef.current = null;
        if (onBlockHover) onBlockHover(null);
        invalidate();
      }
    };
    
    gl.domElement.addEventListener('mousemove', handleMouseMove);
    gl.domElement.addEventListener('mouseleave', handleMouseLeave);
    
    return () => {
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
      gl.domElement.removeEventListener('mouseleave', handleMouseLeave);
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
    };
  }, [debugMode, scene, camera, gl, raycaster, onBlockHover, invalidate]);
  
  return hoveredBlockRef.current;
}

/**
 * Inner scene component that manages the ChunkManager
 */
function RegionScene({ 
  chunks,
  regions,
  parseRegion,
  enableLOD,
  enableModelMeshes,
  enableLighting,
  debugMode,
  onBlockHover,
  onProgress, 
  onComplete,
  onStats,
  onCameraUpdate,
  spectatorRef,
  textureMode,
  textureAtlas,
  initialCameraPosition,
}) {
  const { scene, camera, invalidate } = useThree();
  const managerRef = useRef(null);
  const cameraPositionRef = useRef(initialCameraPosition || [0, 100, 0]);
  
  // Create ChunkManager once
  useEffect(() => {
    const manager = new ChunkManager(scene, {
      // Disable streaming - progressive loading supports model meshes
      useStreaming: false,
      textureMode,
      textureAtlas,
      onProgress: (loaded, total) => {
        onProgress?.(loaded, total, loaded < total, `Loading: ${loaded}/${total} regions`);
        invalidate(); // Request render on progress
      },
      onComplete: () => {
        onProgress?.(0, 0, false, '');
        const stats = manager.getStats();
        onStats?.(stats);
        onComplete?.();
        invalidate(); // Request render on complete
      },
    });
    
    managerRef.current = manager;
    
    // DEBUG: Expose manager to window for console debugging
    if (typeof window !== 'undefined') {
      window.__chunkManager = manager;
      console.log('[RegionViewer] ChunkManager exposed as window.__chunkManager');
      console.log('  - window.__chunkManager.printTriangleCounts() - Show triangle counts per group');
      console.log('  - window.__chunkManager.setGroupVisible("glass", false) - Hide glass/leaves');
    }
    
    return () => {
      if (typeof window !== 'undefined') {
        window.__chunkManager = null;
      }
      manager.dispose();
      managerRef.current = null;
    };
  }, [scene, invalidate]);
  
  // Update texture mode when it changes
  useEffect(() => {
    const manager = managerRef.current;
    if (manager && manager.setTextureMode) {
      manager.setTextureMode(textureMode, textureAtlas);
      invalidate();
    }
  }, [textureMode, textureAtlas, invalidate]);
  
  // Load single region chunks
  // Also reload when textureAtlas changes (to rebuild meshes with texture indices)
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !chunks || chunks.length === 0) return;
    if (regions && regions.length > 0) return; // Multi-region takes precedence
    
    manager.clear();
    console.log(`[RegionViewer] Loading ${chunks.length} chunks...`);
    
    manager.loadChunks(chunks).then(result => {
      console.log(`[RegionViewer] Loaded ${result.chunksLoaded} chunks, ${result.totalBlocks.toLocaleString()} blocks`);
      positionCamera();
      // PERFORMANCE: Trigger initial LOD update after loading completes (use immediate version)
      if (manager.updateAllLODsNow) {
        manager.updateAllLODsNow(camera);
      }
      invalidate();
    });
    
  }, [chunks, textureAtlas, invalidate]);
  
  // Track loaded regions to detect additions
  const loadedRegionKeysRef = useRef(new Set());
  const lastTextureAtlasRef = useRef(null);
  
  // Load multiple regions progressively
  // Uses fast streaming when available (unified worker pipeline)
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !regions || regions.length === 0) return;
    
    // Check if textureAtlas changed - if so, force a reload to rebuild meshes with new texture indices
    const textureAtlasChanged = textureAtlas !== lastTextureAtlasRef.current;
    lastTextureAtlasRef.current = textureAtlas;
    
    // Compute which regions are new
    const currentKeys = new Set(regions.map(r => `${r.regionX},${r.regionZ}`));
    const loadedKeys = loadedRegionKeysRef.current;
    
    // Find regions that need to be loaded
    let newRegions = regions.filter(r => !loadedKeys.has(`${r.regionX},${r.regionZ}`));
    
    // If textureAtlas changed, reload ALL regions (not just new ones)
    if (textureAtlasChanged && loadedKeys.size > 0) {
      console.log('[RegionViewer] Texture atlas changed, reloading all regions...');
      newRegions = regions;
    }
    
    // If all current regions are new, this is a fresh load (clear existing)
    const isFreshLoad = newRegions.length === regions.length || loadedKeys.size === 0 || textureAtlasChanged;
    
    if (newRegions.length === 0) {
      // All regions already loaded, nothing to do
      return;
    }
    
    if (isFreshLoad) {
      manager.clear();
      loadedRegionKeysRef.current = new Set();
    }
    
    // Compute combined center from ALL region coordinates (including existing)
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const { regionX, regionZ } of regions) {
      const rx = regionX * 512;
      const rz = regionZ * 512;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx + 512);
      minZ = Math.min(minZ, rz);
      maxZ = Math.max(maxZ, rz + 512);
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    
    const regionsToLoad = isFreshLoad ? regions : newRegions;
    
    // Use fast streaming method if available (much faster - single worker for entire pipeline)
    // Falls back to progressive loading with parseRegion if streaming not available
    const useStreaming = manager.useStreaming && manager.loadRegionsStreaming;
    
    if (useStreaming) {
      // Use streaming for both initial load and adding more regions
      const streamingMethod = isFreshLoad 
        ? manager.loadRegionsStreaming.bind(manager)
        : manager.addRegionsStreaming.bind(manager);
      
      console.log(`[RegionViewer] 🚀 Fast streaming ${regionsToLoad.length} regions (${isFreshLoad ? 'load' : 'add'})...`);
      
      streamingMethod(regionsToLoad, {
        onRegionStart: (index, total, name) => {
          onProgress?.(index, total, true, `${isFreshLoad ? 'Loading' : 'Adding'}: ${name}`);
        },
        onRegionComplete: (index, total, name, stats) => {
          onProgress?.(index + 1, total, index + 1 < total, `Completed: ${name}`);
          invalidate(); // Render after each region completes
        },
        enableLOD, // Pass through LOD setting
        enableModelMeshes: true, // Always generate model meshes (toggle controls visibility)
      }).then(result => {
        const blocksLoaded = result.totalBlocks?.toLocaleString() || '?';
        if (isFreshLoad) {
          console.log(`[RegionViewer] ✅ Loaded ${result.regionsLoaded} regions, ${blocksLoaded} blocks`);
        } else {
          console.log(`[RegionViewer] ✅ Added ${result.regionsAdded} regions, now have ${result.totalRegions} total`);
        }
        
        // Update loaded keys
        for (const r of regionsToLoad) {
          loadedRegionKeysRef.current.add(`${r.regionX},${r.regionZ}`);
        }
        
        // Only reposition camera on fresh load
        if (isFreshLoad) {
          positionCameraAt(centerX, 64, centerZ, result.chunksLoaded || result.totalChunks);
        }
        invalidate();
      }).catch(err => {
        console.error('[RegionViewer] Streaming failed, falling back to progressive:', err);
        // Fall back to progressive if streaming fails
        if (parseRegion) {
          loadWithProgressive();
        }
      });
    } else if (parseRegion) {
      loadWithProgressive();
    }
    
    // Helper for progressive loading (fallback)
    function loadWithProgressive() {
      console.log(`[RegionViewer] Loading ${regionsToLoad.length} regions progressively...`);
      
      const loadMethod = isFreshLoad 
        ? manager.loadRegionsProgressive.bind(manager)
        : manager.addRegionsProgressive.bind(manager);
      
      loadMethod(regionsToLoad, parseRegion, {
        onRegionStart: (index, total, name) => {
          onProgress?.(index, total, true, `${isFreshLoad ? 'Loading' : 'Adding'}: ${name}`);
        },
        onRegionComplete: (index, total, name, stats) => {
          onProgress?.(index + 1, total, index + 1 < total, `Completed: ${name}`);
          invalidate(); // Render after each region completes
        },
        enableLOD, // Pass through LOD setting
        enableModelMeshes: true, // Always generate model meshes (toggle controls visibility)
      }).then(result => {
        const totalLoaded = isFreshLoad ? result.regionsLoaded : result.totalRegions;
        console.log(`[RegionViewer] ${isFreshLoad ? 'Loaded' : 'Now have'} ${totalLoaded} regions, ${result.totalBlocks?.toLocaleString() || '?'} blocks`);
        
        // Update loaded keys
        for (const r of regionsToLoad) {
          loadedRegionKeysRef.current.add(`${r.regionX},${r.regionZ}`);
        }
        
        // Only reposition camera on fresh load
        if (isFreshLoad) {
          positionCameraAt(centerX, 64, centerZ, result.chunksLoaded || result.totalChunks);
        }
        
        // PERFORMANCE: Trigger initial LOD update after loading completes (use immediate version)
        if (manager.updateAllLODsNow) {
          manager.updateAllLODsNow(camera);
        }
        
        invalidate();
      });
    }
    
  // Also reload when textureAtlas changes (to rebuild meshes with texture indices)
  }, [regions, parseRegion, invalidate, enableLOD, textureAtlas]);
  
  // Toggle model meshes visibility (all partial block groups)
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    
    manager.modelGroup.visible = enableModelMeshes;
    manager.transparentModelGroup.visible = enableModelMeshes;
    manager.overlayModelGroup.visible = enableModelMeshes;
    invalidate(); // Re-render to show/hide model meshes
  }, [enableModelMeshes, invalidate]);

  // Toggle lighting (lightmap vs fixed face shading)
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    
    manager.setLightingEnabled(enableLighting);
    invalidate(); // Re-render with new lighting mode
  }, [enableLighting, invalidate]);

  // Position camera at a specific target (updates initial position for SpectatorControls)
  const positionCameraAt = useCallback((cx, cy, cz, chunkCount = 100) => {
    // Position camera above and to the side of the center
    const distance = Math.max(100, Math.sqrt(chunkCount) * 8);
    const newPos = [cx, cy + distance * 0.3, cz + distance * 0.5];
    cameraPositionRef.current = newPos;
    camera.position.set(newPos[0], newPos[1], newPos[2]);
    invalidate();
  }, [camera, invalidate]);
  
  // Position camera based on loaded content (single region, centered at origin)
  const positionCamera = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    
    const stats = manager.getStats();
    positionCameraAt(0, 64, 0, stats.chunksLoaded || 100);
  }, [positionCameraAt]);
  
  // Debug mode block hover detection (uses color-based lookup)
  const hoveredBlock = useBlockHover(debugMode, onBlockHover);
  
  return (
    <>
      <SpectatorControls 
        ref={spectatorRef}
        initialPosition={cameraPositionRef.current}
        onCameraUpdate={onCameraUpdate}
        moveSpeed={50}
        fastMoveSpeed={150}
      />
      <ambientLight intensity={0.4} />
      <directionalLight position={[50, 100, 30]} intensity={0.8} />
      
      {/* Performance optimizations */}
      <MovementRegression />
      
      {/* Throttled LOD updates - only update LODs when camera moves significantly */}
      <ThrottledLODUpdater managerRef={managerRef} />
      
      {/* Debug block highlight */}
      {debugMode && hoveredBlock && (
        <BlockHighlight position={hoveredBlock} />
      )}
    </>
  );
}

/**
 * RegionViewer component
 * 
 * Props:
 * - chunks: Array of parsed chunk data (single region mode)
 * - regions: Array of { file, regionX, regionZ } for multi-region progressive loading
 * - parseRegion: Async function (file) => chunks[] for parsing region files
 * - enableLOD: Enable Level of Detail for distant regions (default: true)
 * - onBuildProgress: (current, total, isBuilding, message) => void
 * - enablePerformanceMonitor: Enable adaptive DPR based on performance (default: true)
 * - debugMode: Enable debug mode for block inspection on hover (default: false)
 * - onBlockHover: Callback when hovering over a block (receives block info or null)
 * - onCameraUpdate: Callback for camera position/rotation updates (Minecraft spectator mode)
 * - spectatorRef: Ref to access spectator controls (for teleport function)
 * - textureMode: 'solid' | 'default' | 'custom' - Which texture mode to use
 * - textureAtlas: THREE.Texture - The texture atlas for textured rendering
 */
export function RegionViewer({ 
  chunks, 
  regions,
  parseRegion,
  enableLOD = true,
  enableModelMeshes = true,
  enableLighting = true,
  onBuildProgress = null,
  enablePerformanceMonitor = true,
  debugMode = false,
  onBlockHover = null,
  onCameraUpdate = null,
  spectatorRef = null,
  textureMode = 'solid',
  textureAtlas = null,
  fov = 60,  // Vertical FOV in degrees (Minecraft also uses vertical FOV internally)
  style = {}
}) {
  const statsRef = useRef(null);
  const handleStats = useCallback((s) => { statsRef.current = s; }, []);
  
  return (
    <Canvas
      style={{ width: '100%', height: '100%', ...style }}
      camera={{ 
        fov: fov, 
        near: 0.5,   // Slightly larger near plane reduces z-fighting and depth precision issues
        far: 2500,   // PERFORMANCE: Reduced from 10000 - less geometry to rasterize
        position: [500, 300, 500] 
      }}
      gl={{ 
        antialias: false,  // PERFORMANCE: Disable antialiasing - very expensive with millions of triangles
        powerPreference: 'high-performance',
        stencil: false,    // PERFORMANCE: Disable stencil buffer if not needed
        depth: true,
      }}
      // Always render - demand mode can cause issues with LOD updates
      frameloop="always"
      // Performance settings - more aggressive DPR reduction
      dpr={[0.5, 1.0]} // PERFORMANCE: Cap at 1.0 instead of 1.5 - reduces fill rate significantly
      performance={{ min: 0.3 }} // Allow more aggressive quality reduction
    >
      <color attach="background" args={['#1a1a2e']} />
      {/* PERFORMANCE: Fog now matches reduced far plane - hides pop-in */}
      <fog attach="fog" args={['#1a1a2e', 500, 2400]} />
      
      {/* Dynamic FOV updater - responds to prop changes */}
      <DynamicFOV fov={fov} />
      
      {/* Adaptive performance - automatically adjusts quality */}
      {enablePerformanceMonitor && <AdaptivePerformance />}
      
      <RegionScene
        chunks={chunks}
        regions={regions}
        parseRegion={parseRegion}
        enableLOD={enableLOD}
        enableModelMeshes={enableModelMeshes}
        enableLighting={enableLighting}
        debugMode={debugMode}
        onBlockHover={onBlockHover}
        onCameraUpdate={onCameraUpdate}
        spectatorRef={spectatorRef}
        onProgress={onBuildProgress}
        onComplete={() => console.log('[RegionViewer] Load complete')}
        onStats={handleStats}
        textureMode={textureMode}
        textureAtlas={textureAtlas}
      />
    </Canvas>
  );
}

export default RegionViewer;
