import { useRef, useEffect, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Player constants
const PLAYER_HEIGHT = 2; // 2 blocks tall
const PLAYER_WIDTH = 0.6; // Slightly smaller than 1 block for easier navigation
const EYE_HEIGHT = 1.62; // Eye level (like Minecraft)
const MOVE_SPEED = 6; // blocks per second
const JUMP_VELOCITY = 8; // Initial upward velocity for ~1 block jump
const GRAVITY = -25; // Gravity acceleration
const TERMINAL_VELOCITY = -50;

/**
 * FirstPersonControls - Walking mode controller with gravity and collision
 */
export default function FirstPersonControls({ 
  collisionWorld, 
  regionCenter = { x: 0, y: 0, z: 0 },
  onPositionChange
}) {
  const { camera, gl } = useThree();
  
  // Movement state
  const velocity = useRef(new THREE.Vector3(0, 0, 0));
  const isGrounded = useRef(false);
  const keys = useRef({ forward: false, backward: false, left: false, right: false, jump: false });
  
  // Mouse look state
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const isLocked = useRef(false);
  
  // Debug counter for logging
  const logCountRef = useRef(0);
  
  // Find ground at a given X,Z position (returns mesh Y of feet, or null if no ground)
  const findGroundAt = useCallback((meshX, meshZ) => {
    if (!collisionWorld) return null;
    
    const blockX = Math.floor(meshX + regionCenter.x);
    const blockZ = Math.floor(meshZ + regionCenter.z);
    
    // Scan from top to bottom looking for a solid block
    for (let y = 320; y >= -64; y--) {
      if (collisionWorld.has(`${blockX},${y},${blockZ}`)) {
        // Found ground at block Y=y, player stands on top at Y=y+1
        // Convert back to mesh Y: meshY = blockY - regionCenter.y
        return (y + 1) - regionCenter.y;
      }
    }
    return null;
  }, [collisionWorld, regionCenter]);

  // Debug: log collision world info and teleport to ground on mount
  useEffect(() => {
    if (collisionWorld) {
      console.log('=== FirstPersonControls Debug ===');
      console.log('Collision world size:', collisionWorld.size);
      console.log('Region center RECEIVED:', JSON.stringify(regionCenter));
      console.log('regionCenter object id:', regionCenter ? `x=${regionCenter.x},y=${regionCenter.y},z=${regionCenter.z}` : 'null');
      console.log('Camera position:', camera.position.x.toFixed(2), camera.position.y.toFixed(2), camera.position.z.toFixed(2));
      
      // Log a sample of collision blocks and analyze their coordinate ranges
      let sample = 0;
      let sampleY = [];
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (const key of collisionWorld) {
        const [x, y, z] = key.split(',').map(Number);
        sampleY.push(y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        if (sample++ < 5) console.log('  Sample block:', key);
        if (sample > 1000) break;
      }
      sampleY.sort((a, b) => b - a);
      console.log('  Collision X range:', minX, 'to', maxX);
      console.log('  Collision Z range:', minZ, 'to', maxZ);
      console.log('  Top 5 Y values:', sampleY.slice(0, 5));
      
      // Calculate where camera SHOULD map to in collision world
      const expectedBlockX = Math.floor(camera.position.x + regionCenter.x);
      const expectedBlockZ = Math.floor(camera.position.z + regionCenter.z);
      console.log('  Camera maps to block X,Z:', expectedBlockX, expectedBlockZ);
      
      // Check if there are blocks at center (0,0 in mesh = regionCenter in blocks)
      const centerBlockX = Math.floor(regionCenter.x);
      const centerBlockZ = Math.floor(regionCenter.z);
      console.log('  Center block X,Z:', centerBlockX, centerBlockZ);
      
      // Find any block at center X,Z
      let hasBlockAtCenter = false;
      for (let y = 320; y >= -64; y--) {
        if (collisionWorld.has(`${centerBlockX},${y},${centerBlockZ}`)) {
          console.log('  Found block at center:', centerBlockX, y, centerBlockZ);
          hasBlockAtCenter = true;
          break;
        }
      }
      if (!hasBlockAtCenter) {
        console.warn('  WARNING: No blocks found at center X,Z!');
      }
      
      // Try to find ground at camera position
      const groundY = findGroundAt(camera.position.x, camera.position.z);
      console.log('  Ground at camera X,Z:', groundY);
      
      // If we found ground, teleport player there
      if (groundY !== null) {
        const targetY = groundY + EYE_HEIGHT;
        console.log('  Teleporting to ground: mesh Y =', targetY);
        camera.position.y = targetY;
        velocity.current.set(0, 0, 0); // Reset velocity
        isGrounded.current = true;
      } else {
        console.log('  No ground found at camera position, trying center (0,0)');
        const centerGroundY = findGroundAt(0, 0);
        if (centerGroundY !== null) {
          console.log('  Found ground at center, teleporting');
          camera.position.x = 0;
          camera.position.z = 0;
          camera.position.y = centerGroundY + EYE_HEIGHT;
          velocity.current.set(0, 0, 0); // Reset velocity
          isGrounded.current = true;
        }
      }
    } else {
      console.log('FirstPersonControls: No collision world!');
    }
  }, [collisionWorld, regionCenter, camera, findGroundAt]);

  // Check if a block exists at position (returns true if solid)
  const hasBlockAt = useCallback((worldX, worldY, worldZ) => {
    if (!collisionWorld) return false;
    
    // Convert world position to block coordinates
    // The mesh is offset by -regionCenter, so we need to add it back
    const blockX = Math.floor(worldX + regionCenter.x);
    const blockY = Math.floor(worldY + regionCenter.y);
    const blockZ = Math.floor(worldZ + regionCenter.z);
    
    const key = `${blockX},${blockY},${blockZ}`;
    const has = collisionWorld.has(key);
    
    // Debug: log first few checks
    if (logCountRef.current < 10 && !has) {
      console.log(`hasBlockAt: mesh(${worldX.toFixed(1)}, ${worldY.toFixed(1)}, ${worldZ.toFixed(1)}) -> block(${blockX}, ${blockY}, ${blockZ}) = ${has}`);
    }
    
    return has;
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
    
    // Log first few checks
    if (logCountRef.current < 3) {
      const blockX = Math.floor(x + regionCenter.x);
      const blockY = Math.floor(y - 0.1 + regionCenter.y);
      const blockZ = Math.floor(z + regionCenter.z);
      console.log(`checkGrounded: mesh(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) -> block(${blockX}, ${blockY}, ${blockZ})`);
      logCountRef.current++;
    }
    
    for (const point of checkPoints) {
      if (hasBlockAt(x + point.dx, y - 0.1, z + point.dz)) {
        return true;
      }
    }
    
    return false;
  }, [hasBlockAt, regionCenter]);

  // Keyboard event handlers
  useEffect(() => {
    const handleKeyDown = (e) => {
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
      
      const sensitivity = 0.002;
      euler.current.y -= e.movementX * sensitivity;
      euler.current.x -= e.movementY * sensitivity;
      
      // Clamp vertical look
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
  
  // Main update loop
  useFrame((state, delta) => {
    // Clamp delta to prevent physics explosions on tab switch
    const dt = Math.min(delta, 0.1);
    
    // Get camera position (feet position is camera.y - EYE_HEIGHT)
    const feetY = camera.position.y - EYE_HEIGHT;
    
    // Check if grounded
    isGrounded.current = checkGrounded(camera.position.x, feetY, camera.position.z);
    
    // Calculate movement direction
    const moveDirection = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    
    // Get forward/right vectors from camera (ignoring pitch)
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
    
    if (keys.current.forward) moveDirection.add(forward);
    if (keys.current.backward) moveDirection.sub(forward);
    if (keys.current.left) moveDirection.sub(right);
    if (keys.current.right) moveDirection.add(right);
    
    if (moveDirection.length() > 0) {
      moveDirection.normalize();
    }
    
    // Apply horizontal movement
    velocity.current.x = moveDirection.x * MOVE_SPEED;
    velocity.current.z = moveDirection.z * MOVE_SPEED;
    
    // Apply gravity
    if (!isGrounded.current) {
      velocity.current.y += GRAVITY * dt;
      velocity.current.y = Math.max(velocity.current.y, TERMINAL_VELOCITY);
    } else {
      // On ground
      if (velocity.current.y < 0) {
        velocity.current.y = 0;
      }
      
      // Jump
      if (keys.current.jump) {
        velocity.current.y = JUMP_VELOCITY;
        isGrounded.current = false;
      }
    }
    
    // Calculate new position
    let newX = camera.position.x + velocity.current.x * dt;
    let newFeetY = feetY + velocity.current.y * dt;
    let newZ = camera.position.z + velocity.current.z * dt;
    
    // Collision detection - X axis
    if (velocity.current.x !== 0) {
      if (checkCollision(newX, feetY, camera.position.z)) {
        newX = camera.position.x;
        velocity.current.x = 0;
      }
    }
    
    // Collision detection - Z axis
    if (velocity.current.z !== 0) {
      if (checkCollision(newX, feetY, newZ)) {
        newZ = camera.position.z;
        velocity.current.z = 0;
      }
    }
    
    // Collision detection - Y axis
    if (velocity.current.y !== 0) {
      if (checkCollision(newX, newFeetY, newZ)) {
        if (velocity.current.y < 0) {
          // Falling - snap to top of block
          newFeetY = Math.ceil(newFeetY);
          isGrounded.current = true;
        } else {
          // Jumping up - hit ceiling
          newFeetY = feetY;
        }
        velocity.current.y = 0;
      }
    }
    
    // Apply position
    camera.position.x = newX;
    camera.position.y = newFeetY + EYE_HEIGHT;
    camera.position.z = newZ;
    
    // Notify of position change
    onPositionChange?.({
      x: camera.position.x + regionCenter.x,
      y: camera.position.y - EYE_HEIGHT + regionCenter.y,
      z: camera.position.z + regionCenter.z
    });
  });
  
  return null;
}

