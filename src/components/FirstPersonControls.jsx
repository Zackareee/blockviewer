import { useRef, useEffect, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Player constants - Minecraft accurate values
const PLAYER_HEIGHT = 1.8; // 1.8 blocks tall (actual Minecraft hitbox)
const PLAYER_WIDTH = 0.6; // 0.6 blocks wide (actual Minecraft hitbox)
const EYE_HEIGHT = 1.62; // Eye level (like Minecraft)

// Minecraft movement speeds (blocks per second)
const WALK_SPEED = 4.317; // Minecraft walking speed
const SPRINT_SPEED = 5.612; // Minecraft sprinting speed (1.3x walking)

// Minecraft tick-based physics constants (20 ticks per second)
// All values are in BLOCKS PER TICK for authentic simulation
const TICK_RATE = 20;

// Jump velocity: 0.42 blocks/tick (gives ~1.25 block jump height)
const JUMP_VELOCITY_PER_TICK = 0.42;

// Gravity: 0.08 blocks/tick² (applied each tick)
const GRAVITY_PER_TICK = 0.08;

// Terminal velocity: 3.92 blocks/tick
const TERMINAL_VELOCITY_PER_TICK = 3.92;

// Drag multipliers (applied per tick AFTER movement)
const AIR_DRAG_HORIZONTAL = 0.91;
const AIR_DRAG_VERTICAL = 0.98;

// Ground movement friction (block slipperiness, default = 0.6)
const GROUND_FRICTION = 0.6;

// Mouse sensitivity matching Minecraft default (50%)
const MOUSE_SENSITIVITY = 0.0025;

/**
 * FirstPersonControls - Walking mode controller with gravity and collision
 */
export default function FirstPersonControls({ 
  collisionWorld, 
  regionCenter = { x: 0, y: 0, z: 0 },
  onPositionChange,
  onChunkChange,
  onVelocityChange,
  onSprintChange
}) {
  const { camera, gl } = useThree();
  
  // Movement state
  const velocity = useRef(new THREE.Vector3(0, 0, 0));
  const isGrounded = useRef(false);
  const isSprinting = useRef(false);
  const keys = useRef({ forward: false, backward: false, left: false, right: false, jump: false });
  
  // Momentum-based movement (Minecraft uses velocity with friction, not instant movement)
  const horizontalMomentum = useRef(new THREE.Vector3(0, 0, 0));
  
  // Mouse look state
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const isLocked = useRef(false);
  
  // Track current chunk for dynamic collision updates
  const currentChunkRef = useRef({ x: 0, z: 0 });
  
  // Track if we've done initial spawn (to avoid respawning on collision rebuild)
  const hasSpawnedRef = useRef(false);
  
  // Track last reported sprint state to avoid spam
  const lastSprintReported = useRef(false);
  
  // Find ground at a given X,Z position (returns mesh Y of feet, or null if no ground)
  const findGroundAt = useCallback((meshX, meshZ) => {
    if (!collisionWorld) return null;
    
    const blockX = Math.floor(meshX + regionCenter.x);
    const blockZ = Math.floor(meshZ + regionCenter.z);
    
    // Scan from top to bottom looking for a solid block
    // CollisionSet uses .has(x, y, z) directly - no string conversion needed
    for (let y = 320; y >= -64; y--) {
      if (collisionWorld.has(blockX, y, blockZ)) {
        // Found ground at block Y=y, player stands on top at Y=y+1
        // Convert back to mesh Y: meshY = blockY - regionCenter.y
        return (y + 1) - regionCenter.y;
      }
    }
    return null;
  }, [collisionWorld, regionCenter]);

  // Teleport to spawn on initial mount (not on collision rebuilds)
  useEffect(() => {
    if (!collisionWorld || hasSpawnedRef.current) {
      return; // Skip if no collision or already spawned
    }
    
    console.log('=== FirstPersonControls Initial Spawn ===');
    console.log('Collision world size:', collisionWorld.size);
    console.log('Region center:', JSON.stringify(regionCenter));
    
    // Log collision size (CollisionSet doesn't expose raw keys for iteration)
    console.log('  Collision blocks:', collisionWorld.size);
    
    // Always start at spawn point (mesh 0,0) for consistent collision coverage
    console.log('  Spawning player at center (mesh 0, 0)');
    camera.position.x = 0;
    camera.position.z = 0;
    
    // Find ground at spawn
    const groundY = findGroundAt(0, 0);
    console.log('  Ground at spawn:', groundY);
    
    if (groundY !== null) {
      camera.position.y = groundY + EYE_HEIGHT;
      isGrounded.current = true;
      console.log('  Spawned at Y:', camera.position.y.toFixed(2));
    } else {
      // No ground found - try scanning in a small area
      console.warn('  No ground at exact spawn, scanning nearby...');
      let foundGround = false;
      for (let radius = 1; radius <= 8 && !foundGround; radius++) {
        for (let dx = -radius; dx <= radius && !foundGround; dx++) {
          for (let dz = -radius; dz <= radius && !foundGround; dz++) {
            if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue; // Only check perimeter
            const gy = findGroundAt(dx, dz);
            if (gy !== null) {
              camera.position.x = dx;
              camera.position.z = dz;
              camera.position.y = gy + EYE_HEIGHT;
              isGrounded.current = true;
              foundGround = true;
              console.log('  Found ground at offset:', dx, dz, 'Y:', camera.position.y.toFixed(2));
            }
          }
        }
      }
      if (!foundGround) {
        console.error('  ERROR: No ground found anywhere near spawn!');
        camera.position.y = 80;
      }
    }
    
    // Reset velocity and momentum
    velocity.current.set(0, 0, 0);
    horizontalMomentum.current.set(0, 0, 0);
    verticalVelocity.current = 0;
    
    // Initialize current chunk
    const worldX = camera.position.x + regionCenter.x;
    const worldZ = camera.position.z + regionCenter.z;
    currentChunkRef.current = { x: Math.floor(worldX / 16), z: Math.floor(worldZ / 16) };
    console.log('  Initial chunk:', currentChunkRef.current.x, currentChunkRef.current.z);
    
    // Mark as spawned so we don't respawn on collision rebuilds
    hasSpawnedRef.current = true;
  }, [collisionWorld, regionCenter, camera, findGroundAt]);
  
  // Reset spawn flag when component unmounts (so next walk mode entry spawns fresh)
  useEffect(() => {
    return () => {
      hasSpawnedRef.current = false;
    };
  }, []);

  // Check if a block exists at position (returns true if solid)
  const hasBlockAt = useCallback((worldX, worldY, worldZ) => {
    if (!collisionWorld) return false;
    
    // Convert world position to block coordinates
    // The mesh is offset by -regionCenter, so we need to add it back
    const blockX = Math.floor(worldX + regionCenter.x);
    const blockY = Math.floor(worldY + regionCenter.y);
    const blockZ = Math.floor(worldZ + regionCenter.z);
    
    // CollisionSet uses .has(x, y, z) directly - no string conversion needed
    return collisionWorld.has(blockX, blockY, blockZ);
  }, [collisionWorld, regionCenter]);
  
  // Check if player can move to position
  const checkCollision = useCallback((x, y, z) => {
    // Check collision at feet and head level (player is 2 blocks tall)
    // Also check at mid-height for more accurate collision
    const checkPoints = [
      // Feet level corners
      { dx: -PLAYER_WIDTH/2, dy: 0, dz: -PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dy: 0, dz: -PLAYER_WIDTH/2 },
      { dx: -PLAYER_WIDTH/2, dy: 0, dz: PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dy: 0, dz: PLAYER_WIDTH/2 },
      // Mid level corners
      { dx: -PLAYER_WIDTH/2, dy: 1, dz: -PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dy: 1, dz: -PLAYER_WIDTH/2 },
      { dx: -PLAYER_WIDTH/2, dy: 1, dz: PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dy: 1, dz: PLAYER_WIDTH/2 },
      // Head level corners (just below eye level)
      { dx: -PLAYER_WIDTH/2, dy: PLAYER_HEIGHT - 0.1, dz: -PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dy: PLAYER_HEIGHT - 0.1, dz: -PLAYER_WIDTH/2 },
      { dx: -PLAYER_WIDTH/2, dy: PLAYER_HEIGHT - 0.1, dz: PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dy: PLAYER_HEIGHT - 0.1, dz: PLAYER_WIDTH/2 },
    ];
    
    for (const point of checkPoints) {
      if (hasBlockAt(x + point.dx, y + point.dy, z + point.dz)) {
        return true;
      }
    }
    
    return false;
  }, [hasBlockAt]);
  
  // Check if grounded (block directly below feet)
  const checkGrounded = useCallback((x, y, z) => {
    const checkPoints = [
      { dx: -PLAYER_WIDTH/2, dz: -PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dz: -PLAYER_WIDTH/2 },
      { dx: -PLAYER_WIDTH/2, dz: PLAYER_WIDTH/2 },
      { dx: PLAYER_WIDTH/2, dz: PLAYER_WIDTH/2 },
      { dx: 0, dz: 0 },
    ];
    
    for (const point of checkPoints) {
      if (hasBlockAt(x + point.dx, y - 0.1, z + point.dz)) {
        return true;
      }
    }
    
    return false;
  }, [hasBlockAt]);

  // Keyboard event handlers
  useEffect(() => {
    const handleKeyDown = (e) => {
      // CapsLock toggles sprint regardless of pointer lock
      if (e.code === 'CapsLock') {
        isSprinting.current = !isSprinting.current;
        e.preventDefault();
        return;
      }
      
      if (!isLocked.current) return;
      
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          keys.current.forward = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          keys.current.backward = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          keys.current.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          keys.current.right = true;
          break;
        case 'Space':
          keys.current.jump = true;
          e.preventDefault();
          break;
      }
    };
    
    const handleKeyUp = (e) => {
      // Don't reset sprint on CapsLock release - it's a toggle
      if (e.code === 'CapsLock') {
        e.preventDefault();
        return;
      }
      
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          keys.current.forward = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          keys.current.backward = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          keys.current.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          keys.current.right = false;
          break;
        case 'Space':
          keys.current.jump = false;
          break;
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, []);
  
  // Pointer lock handlers
  useEffect(() => {
    const canvas = gl.domElement;
    
    const handleClick = () => {
      canvas.requestPointerLock();
    };
    
    const handleLockChange = () => {
      isLocked.current = document.pointerLockElement === canvas;
    };
    
    const handleMouseMove = (e) => {
      if (!isLocked.current) return;
      
      euler.current.y -= e.movementX * MOUSE_SENSITIVITY;
      euler.current.x -= e.movementY * MOUSE_SENSITIVITY;
      
      // Clamp vertical look (Minecraft limits to ±90 degrees)
      euler.current.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.current.x));
      
      camera.quaternion.setFromEuler(euler.current);
    };
    
    canvas.addEventListener('click', handleClick);
    document.addEventListener('pointerlockchange', handleLockChange);
    document.addEventListener('mousemove', handleMouseMove);
    
    return () => {
      canvas.removeEventListener('click', handleClick);
      document.removeEventListener('pointerlockchange', handleLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
      
      // Exit pointer lock when unmounting
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    };
  }, [gl, camera]);
  
  // Initialize camera rotation from current position
  useEffect(() => {
    euler.current.setFromQuaternion(camera.quaternion, 'YXZ');
  }, [camera]);
  
  // Vertical velocity in blocks/tick (Minecraft's native unit)
  const verticalVelocity = useRef(0);
  
  // Main update loop - Minecraft-accurate physics with smooth rendering
  useFrame((state, delta) => {
    // Clamp delta to prevent physics explosions on tab switch
    const dt = Math.min(delta, 0.1);
    
    // Scale factor: how many "ticks worth" of time this frame represents
    const tickScale = dt * TICK_RATE;
    
    // Get current feet position
    const feetY = camera.position.y - EYE_HEIGHT;
    
    // Check if grounded
    isGrounded.current = checkGrounded(camera.position.x, feetY, camera.position.z);
    
    // Calculate movement direction from input
    const inputDirection = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    
    // Get forward/right vectors from camera (ignoring pitch)
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
    
    if (keys.current.forward) inputDirection.add(forward);
    if (keys.current.backward) inputDirection.sub(forward);
    if (keys.current.left) inputDirection.sub(right);
    if (keys.current.right) inputDirection.add(right);
    
    // Normalize diagonal movement (Minecraft does this)
    if (inputDirection.length() > 0) {
      inputDirection.normalize();
    }
    
    // Determine current movement speed based on sprint state
    const canSprint = isSprinting.current && keys.current.forward && !keys.current.backward;
    const currentSpeed = canSprint ? SPRINT_SPEED : WALK_SPEED;
    
    // Report sprint state changes for FOV effect
    const isActivelySprinting = canSprint && inputDirection.length() > 0;
    if (isActivelySprinting !== lastSprintReported.current) {
      lastSprintReported.current = isActivelySprinting;
      onSprintChange?.(isActivelySprinting);
    }
    
    // ===== PHYSICS UPDATE =====
    
    if (isGrounded.current) {
      // ===== GROUND PHYSICS =====
      
      // Apply friction (scaled for frame time)
      // Minecraft: velocity *= (slipperiness * 0.91) per tick
      // For continuous: use exponential decay
      const slipperiness = GROUND_FRICTION;
      const frictionPerTick = slipperiness * 0.91;
      const frictionFactor = Math.pow(frictionPerTick, tickScale);
      
      horizontalMomentum.current.x *= frictionFactor;
      horizontalMomentum.current.z *= frictionFactor;
      
      // Apply input acceleration (scaled for frame time)
      // Minecraft: accel = 0.1 * (0.16277136 / slipperiness³)
      // Adjusted by 1.3x to reach actual target velocities (4.317 walk, 5.612 sprint)
      const movementFactor = 0.1 * (0.16277136 / Math.pow(slipperiness, 3)) * 1.3;
      
      if (inputDirection.length() > 0) {
        const speedFactor = currentSpeed / WALK_SPEED;
        const accelScale = tickScale; // Scale acceleration by time
        horizontalMomentum.current.x += inputDirection.x * movementFactor * speedFactor * accelScale;
        horizontalMomentum.current.z += inputDirection.z * movementFactor * speedFactor * accelScale;
      }
      
      // Handle jumping
      if (keys.current.jump && verticalVelocity.current <= 0) {
        verticalVelocity.current = JUMP_VELOCITY_PER_TICK;
        isGrounded.current = false;
        
        // Sprint jump boost
        if (canSprint && inputDirection.length() > 0) {
          const jumpBoost = 0.2;
          horizontalMomentum.current.x += inputDirection.x * jumpBoost;
          horizontalMomentum.current.z += inputDirection.z * jumpBoost;
        }
      } else if (verticalVelocity.current < 0) {
        verticalVelocity.current = 0;
      }
      
    } else {
      // ===== AIR PHYSICS =====
      
      // Air control (scaled for frame time)
      // Slightly increased for responsive strafing
      const airAcceleration = 0.026;
      if (inputDirection.length() > 0) {
        horizontalMomentum.current.x += inputDirection.x * airAcceleration * tickScale;
        horizontalMomentum.current.z += inputDirection.z * airAcceleration * tickScale;
      }
      
      // Apply horizontal air drag (exponential for smooth interpolation)
      const hDragFactor = Math.pow(AIR_DRAG_HORIZONTAL, tickScale);
      horizontalMomentum.current.x *= hDragFactor;
      horizontalMomentum.current.z *= hDragFactor;
      
      // Apply gravity (scaled for frame time)
      // Minecraft: velocity -= 0.08 per tick
      verticalVelocity.current -= GRAVITY_PER_TICK * tickScale;
      
      // Apply vertical drag (exponential for smooth interpolation)
      const vDragFactor = Math.pow(AIR_DRAG_VERTICAL, tickScale);
      verticalVelocity.current *= vDragFactor;
      
      // Terminal velocity clamp
      if (verticalVelocity.current < -TERMINAL_VELOCITY_PER_TICK) {
        verticalVelocity.current = -TERMINAL_VELOCITY_PER_TICK;
      }
    }
    
    // ===== POSITION UPDATE =====
    // Convert blocks/tick to blocks/frame
    const moveX = horizontalMomentum.current.x * tickScale;
    const moveZ = horizontalMomentum.current.z * tickScale;
    const moveY = verticalVelocity.current * tickScale;
    
    let newX = camera.position.x + moveX;
    let newZ = camera.position.z + moveZ;
    let newFeetY = feetY + moveY;
    
    // Collision detection - X axis
    if (moveX !== 0) {
      if (checkCollision(newX, feetY, camera.position.z)) {
        newX = camera.position.x;
        horizontalMomentum.current.x = 0;
      }
    }
    
    // Collision detection - Z axis
    if (moveZ !== 0) {
      if (checkCollision(newX, feetY, newZ)) {
        newZ = camera.position.z;
        horizontalMomentum.current.z = 0;
      }
    }
    
    // Collision detection - Y axis
    if (moveY !== 0) {
      if (checkCollision(newX, newFeetY, newZ)) {
        if (verticalVelocity.current < 0) {
          // Falling - snap to top of block
          newFeetY = Math.ceil(newFeetY);
          isGrounded.current = true;
        } else {
          // Hit ceiling
          newFeetY = feetY;
        }
        verticalVelocity.current = 0;
      }
    }
    
    // Apply position
    camera.position.x = newX;
    camera.position.y = newFeetY + EYE_HEIGHT;
    camera.position.z = newZ;
    
    // Sync velocity ref for external use (convert to blocks/second)
    velocity.current.x = horizontalMomentum.current.x * TICK_RATE;
    velocity.current.y = verticalVelocity.current * TICK_RATE;
    velocity.current.z = horizontalMomentum.current.z * TICK_RATE;
    
    // Report velocity for prefetching (throttled to avoid spam)
    if (Math.abs(velocity.current.x) > 0.5 || Math.abs(velocity.current.z) > 0.5) {
      onVelocityChange?.(velocity.current.x, velocity.current.z);
    }
    
    // Calculate world position
    const worldX = camera.position.x + regionCenter.x;
    const worldY = camera.position.y - EYE_HEIGHT + regionCenter.y;
    const worldZ = camera.position.z + regionCenter.z;
    
    // Check if player crossed chunk boundary
    const currentChunkX = Math.floor(worldX / 16);
    const currentChunkZ = Math.floor(worldZ / 16);
    
    if (currentChunkX !== currentChunkRef.current.x || currentChunkZ !== currentChunkRef.current.z) {
      console.log(`Chunk changed: (${currentChunkRef.current.x}, ${currentChunkRef.current.z}) -> (${currentChunkX}, ${currentChunkZ})`);
      currentChunkRef.current = { x: currentChunkX, z: currentChunkZ };
      
      // Notify parent to rebuild collision around new position
      onChunkChange?.(currentChunkX, currentChunkZ, camera.position.x, camera.position.z);
    }
    
    // Notify of position change
    onPositionChange?.({
      x: worldX,
      y: worldY,
      z: worldZ
    });
  });
  
  return null;
}

