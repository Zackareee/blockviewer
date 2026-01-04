/**
 * SpectatorControls - Minecraft-style spectator mode camera controls
 * 
 * Implements Minecraft's actual spectator mode physics:
 * - Velocity-based movement with inertia
 * - Friction coefficient of 0.91 (applied per tick)
 * - Acceleration-based input (not instant movement)
 * - Scroll wheel to adjust flying speed multiplier
 * - Sprint key (Ctrl) for 2x speed boost
 * 
 * Mouse controls pitch and yaw (requires pointer lock)
 * WASD moves relative to facing direction
 * Space/Shift for vertical movement
 * 
 * Rotation representation (matching Minecraft):
 * - Yaw (Y-rotation): -180° to +180°
 *   - -180°/+180° = North (towards -Z)
 *   - -90° = East (towards +X)
 *   - 0° = South (towards +Z)
 *   - +90° = West (towards -X)
 * 
 * - Pitch (X-rotation): -90° to +90°
 *   - 0° = horizontal
 *   - positive = looking down
 *   - negative = looking up
 * 
 * Minecraft physics reference:
 * - Flying friction: 0.91 per tick
 * - Flying base acceleration: 0.05 blocks/tick
 * - Terminal velocity = acceleration / (1 - friction) = 0.05 / 0.09 ≈ 0.556 blocks/tick ≈ 11.1 blocks/second
 * - Spectator mode uses speed multipliers via scroll wheel
 * - Sprint doubles the speed
 */

import { useRef, useEffect, useCallback, useState, useImperativeHandle, forwardRef, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Minecraft spectator mode physics constants
// 
// Using different friction values for horizontal vs vertical movement:
// - Vertical (up/down): High friction for snappy, responsive stops
// - Horizontal (WASD): Softer friction for smoother gliding feel
//
const TICKS_PER_SECOND = 20;

// Vertical friction: Very high (0.5 per tick) for near-instant stopping
// - Half-life: ~0.05 seconds (1 tick)
// - Stops within 3-5 ticks (~0.15-0.25 seconds)
const VERTICAL_FRICTION_PER_TICK = 0.5;
const VERTICAL_DECAY_RATE = -TICKS_PER_SECOND * Math.log(VERTICAL_FRICTION_PER_TICK);  // ≈ 13.86/sec

// Horizontal friction: Softer (0.75 per tick) for smoother gliding
// - Half-life: ~0.12 seconds (2-3 ticks)  
// - Stops within 10-15 ticks (~0.5-0.75 seconds)
const HORIZONTAL_FRICTION_PER_TICK = 0.75;
const HORIZONTAL_DECAY_RATE = -TICKS_PER_SECOND * Math.log(HORIZONTAL_FRICTION_PER_TICK);  // ≈ 5.75/sec

// Base terminal velocity in blocks/second (matches Minecraft spectator at 1x speed)
const BASE_TERMINAL_VELOCITY = 10.0;

// Separate accelerations to achieve the same terminal velocity with different frictions
// Formula: terminal_velocity = acceleration / decay_rate
const VERTICAL_ACCELERATION_PER_SEC = BASE_TERMINAL_VELOCITY * VERTICAL_DECAY_RATE;    // ≈ 139 blocks/sec²
const HORIZONTAL_ACCELERATION_PER_SEC = BASE_TERMINAL_VELOCITY * HORIZONTAL_DECAY_RATE; // ≈ 57.5 blocks/sec²

// Speed multiplier levels (controlled by scroll wheel)
// These match Minecraft's spectator mode speed levels
const SPEED_LEVELS = [0.0625, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0];
const DEFAULT_SPEED_LEVEL_INDEX = 4;  // Start at 1.0x

// Sprint multiplier (Ctrl key)
const SPRINT_MULTIPLIER = 2.0;

const MOUSE_SENSITIVITY = 0.002;

/**
 * Convert internal rotation (radians) to Minecraft pitch/yaw (degrees)
 * 
 * Internal convention:
 * - rotationRef.yaw = (180 - mcYaw) * π/180, so mcYaw = 180 - rotationRef.yaw * 180/π
 * - rotationRef.pitch = mcPitch * π/180, so mcPitch = rotationRef.pitch * 180/π
 */
function internalToMinecraftRotation(internalYaw, internalPitch) {
  // Yaw: convert from internal radians to Minecraft degrees
  let yaw = 180 - internalYaw * (180 / Math.PI);
  
  // Normalize yaw to -180 to 180
  while (yaw > 180) yaw -= 360;
  while (yaw <= -180) yaw += 360;
  
  // Pitch: direct conversion from radians to degrees
  const pitch = internalPitch * (180 / Math.PI);
  
  return { pitch, yaw };
}

/**
 * Get cardinal direction from yaw angle
 */
function getCardinalDirection(yaw) {
  // Normalize yaw to -180 to 180
  let normalizedYaw = yaw;
  while (normalizedYaw > 180) normalizedYaw -= 360;
  while (normalizedYaw <= -180) normalizedYaw += 360;
  
  // Determine cardinal direction
  if (normalizedYaw >= -45 && normalizedYaw < 45) {
    return { direction: 'south', axis: 'Towards positive Z' };
  } else if (normalizedYaw >= 45 && normalizedYaw < 135) {
    return { direction: 'west', axis: 'Towards negative X' };
  } else if (normalizedYaw >= -135 && normalizedYaw < -45) {
    return { direction: 'east', axis: 'Towards positive X' };
  } else {
    return { direction: 'north', axis: 'Towards negative Z' };
  }
}

export const SpectatorControls = forwardRef(function SpectatorControls({ 
  mouseSensitivity = MOUSE_SENSITIVITY,
  onCameraUpdate = null,
  onSpeedChange = null,  // Callback when speed multiplier changes
  initialPosition = [0, 100, 0],
  initialYaw = 0,
  initialPitch = 0,
}, ref) {
  const { camera, gl, invalidate } = useThree();
  const isLockedRef = useRef(false);
  const keysRef = useRef({
    forward: false,
    backward: false,
    left: false,
    right: false,
    up: false,
    down: false,
    sprint: false,  // Changed from 'fast' to 'sprint' to match Minecraft terminology
  });
  
  // Velocity state for physics-based movement (in blocks per tick)
  const velocityRef = useRef(new THREE.Vector3(0, 0, 0));
  
  // Speed multiplier level index (controlled by scroll wheel)
  const speedLevelRef = useRef(DEFAULT_SPEED_LEVEL_INDEX);
  
  // Store rotation as internal angles (not Minecraft angles)
  // These get converted when creating the Three.js Euler and when reporting to UI
  // Internal yaw 0 = looking at -Z (North in Minecraft = yaw ±180)
  // To initialize with Minecraft yaw, we convert: internal = (180 - minecraftYaw) in degrees
  const rotationRef = useRef({
    yaw: (180 - initialYaw) * (Math.PI / 180),   // Convert Minecraft yaw to internal radians
    pitch: initialPitch * (Math.PI / 180),        // Convert Minecraft pitch to internal radians
  });
  
  // Expose teleport and speed control functions via ref
  useImperativeHandle(ref, () => ({
    /**
     * Teleport camera to position and rotation
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate  
     * @param {number} z - Z coordinate
     * @param {number} yaw - Minecraft yaw in degrees (-180 to 180)
     * @param {number} pitch - Minecraft pitch in degrees (-90 to 90)
     */
    teleport(x, y, z, yaw, pitch) {
      // Update position
      camera.position.set(x, y, z);
      
      // Reset velocity when teleporting (no momentum carried over)
      velocityRef.current.set(0, 0, 0);
      
      // Convert Minecraft angles to internal radians
      rotationRef.current.yaw = (180 - yaw) * (Math.PI / 180);
      rotationRef.current.pitch = pitch * (Math.PI / 180);
      
      // Clamp pitch
      rotationRef.current.pitch = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, rotationRef.current.pitch)
      );
      
      // Normalize yaw
      while (rotationRef.current.yaw > Math.PI) rotationRef.current.yaw -= 2 * Math.PI;
      while (rotationRef.current.yaw < -Math.PI) rotationRef.current.yaw += 2 * Math.PI;
      
      // Apply rotation
      const euler = new THREE.Euler(
        -rotationRef.current.pitch,
        -rotationRef.current.yaw,
        0,
        'YXZ'
      );
      camera.quaternion.setFromEuler(euler);
      invalidate();
      
      // Report new state
      if (onCameraUpdate) {
        const { pitch: mcPitch, yaw: mcYaw } = internalToMinecraftRotation(
          rotationRef.current.yaw, 
          rotationRef.current.pitch
        );
        const cardinal = getCardinalDirection(mcYaw);
        const speedMultiplier = SPEED_LEVELS[speedLevelRef.current];
        onCameraUpdate({
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          pitch: mcPitch,
          yaw: mcYaw,
          direction: cardinal.direction,
          axis: cardinal.axis,
          speedMultiplier,
        });
      }
    },
    
    /**
     * Get current speed multiplier
     */
    getSpeedMultiplier() {
      return SPEED_LEVELS[speedLevelRef.current];
    },
    
    /**
     * Set speed level index (0-9)
     */
    setSpeedLevel(index) {
      speedLevelRef.current = Math.max(0, Math.min(SPEED_LEVELS.length - 1, index));
      if (onSpeedChange) {
        onSpeedChange(SPEED_LEVELS[speedLevelRef.current]);
      }
    },
    
    /**
     * Reset speed to default (1.0x)
     */
    resetSpeed() {
      speedLevelRef.current = DEFAULT_SPEED_LEVEL_INDEX;
      if (onSpeedChange) {
        onSpeedChange(SPEED_LEVELS[speedLevelRef.current]);
      }
    }
  }), [camera, invalidate, onCameraUpdate, onSpeedChange]);
  
  // Initialize camera position and rotation
  useEffect(() => {
    camera.position.set(initialPosition[0], initialPosition[1], initialPosition[2]);
    
    // Set initial rotation
    const euler = new THREE.Euler(
      -rotationRef.current.pitch,
      -rotationRef.current.yaw,
      0,
      'YXZ'
    );
    camera.quaternion.setFromEuler(euler);
    invalidate();
    
    // Report initial state
    if (onCameraUpdate) {
      const { pitch, yaw } = internalToMinecraftRotation(
        rotationRef.current.yaw,
        rotationRef.current.pitch
      );
      const cardinal = getCardinalDirection(yaw);
      onCameraUpdate({
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        pitch,
        yaw,
        direction: cardinal.direction,
        axis: cardinal.axis,
      });
    }
  }, []);
  
  // Handle pointer lock
  const requestPointerLock = useCallback(() => {
    gl.domElement.requestPointerLock();
  }, [gl]);
  
  // Set up event listeners
  useEffect(() => {
    const canvas = gl.domElement;
    
    // Click to lock pointer
    const handleClick = () => {
      if (!isLockedRef.current) {
        requestPointerLock();
      }
    };
    
    // Pointer lock change
    const handleLockChange = () => {
      isLockedRef.current = document.pointerLockElement === canvas;
    };
    
    // Mouse movement (only when locked)
    const handleMouseMove = (event) => {
      if (!isLockedRef.current) return;
      
      const movementX = event.movementX || 0;
      const movementY = event.movementY || 0;
      
      // Update yaw (left/right)
      // Mouse moves right (positive movementX) = look right = yaw increases
      rotationRef.current.yaw += movementX * mouseSensitivity;
      
      // Normalize yaw to -PI to PI
      while (rotationRef.current.yaw > Math.PI) rotationRef.current.yaw -= 2 * Math.PI;
      while (rotationRef.current.yaw < -Math.PI) rotationRef.current.yaw += 2 * Math.PI;
      
      // Update pitch (up/down) with clamping
      // Mouse down (positive movementY) = look down = positive Minecraft pitch
      rotationRef.current.pitch += movementY * mouseSensitivity;
      rotationRef.current.pitch = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, rotationRef.current.pitch)
      );
      
      // Apply rotation to camera
      const euler = new THREE.Euler(
        -rotationRef.current.pitch,
        -rotationRef.current.yaw,
        0,
        'YXZ'
      );
      camera.quaternion.setFromEuler(euler);
      invalidate();
    };
    
    // Keyboard controls
    const handleKeyDown = (event) => {
      // Ignore keyboard events when focus is on an input or editable element
      const activeElement = document.activeElement;
      const isEditing = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable
      );
      if (isEditing) return;
      
      switch (event.code) {
        case 'KeyW':
          keysRef.current.forward = true;
          break;
        case 'KeyS':
          keysRef.current.backward = true;
          break;
        case 'KeyA':
          keysRef.current.left = true;
          break;
        case 'KeyD':
          keysRef.current.right = true;
          break;
        case 'Space':
          keysRef.current.up = true;
          event.preventDefault();
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          keysRef.current.down = true;
          break;
        case 'ControlLeft':
        case 'ControlRight':
          keysRef.current.sprint = true;
          break;
        case 'Escape':
          // Allow escape to exit pointer lock
          break;
      }
    };
    
    const handleKeyUp = (event) => {
      // Always process keyUp to prevent stuck keys, but still check for editing
      // to avoid interfering with input navigation
      const activeElement = document.activeElement;
      const isEditing = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable
      );
      
      // Always clear the key state on keyUp (even when editing)
      // This prevents keys from getting "stuck" if user presses while in viewer
      // then focuses an input and releases
      switch (event.code) {
        case 'KeyW':
          keysRef.current.forward = false;
          break;
        case 'KeyS':
          keysRef.current.backward = false;
          break;
        case 'KeyA':
          keysRef.current.left = false;
          break;
        case 'KeyD':
          keysRef.current.right = false;
          break;
        case 'Space':
          keysRef.current.up = false;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          keysRef.current.down = false;
          break;
        case 'ControlLeft':
        case 'ControlRight':
          keysRef.current.sprint = false;
          break;
      }
    };
    
    // Scroll wheel for speed adjustment (Minecraft spectator mode feature)
    const handleWheel = (event) => {
      if (!isLockedRef.current) return;
      
      event.preventDefault();
      
      // Use deltaY for normal scroll, but when shift is held browsers convert
      // vertical scroll to horizontal (deltaX), so check both
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      
      const direction = delta < 0 ? 1 : -1;  // Scroll up = faster, scroll down = slower
      const newIndex = Math.max(0, Math.min(SPEED_LEVELS.length - 1, speedLevelRef.current + direction));
      
      if (newIndex !== speedLevelRef.current) {
        speedLevelRef.current = newIndex;
        const speedMultiplier = SPEED_LEVELS[newIndex];
        if (onSpeedChange) {
          onSpeedChange(speedMultiplier);
        }
      }
    };
    
    canvas.addEventListener('click', handleClick);
    document.addEventListener('pointerlockchange', handleLockChange);
    document.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      canvas.removeEventListener('click', handleClick);
      document.removeEventListener('pointerlockchange', handleLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [gl, camera, mouseSensitivity, requestPointerLock, invalidate, onSpeedChange]);
  
  // PERFORMANCE: Reuse objects to avoid GC pressure from allocations every frame
  const forwardVec = useMemo(() => new THREE.Vector3(), []);
  const rightVec = useMemo(() => new THREE.Vector3(), []);
  const inputVec = useMemo(() => new THREE.Vector3(), []);
  const yawEuler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);
  
  // Track last reported position to only update when changed
  const lastReportedPos = useRef({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0 });
  
  // Movement update each frame using Minecraft physics (smooth delta-time based)
  useFrame((state, delta) => {
    // Clamp delta to prevent physics explosions on tab switch or lag spikes
    const clampedDelta = Math.min(delta, 0.1);
    
    const keys = keysRef.current;
    const velocity = velocityRef.current;
    
    // Get current speed multiplier from scroll wheel level
    const speedMultiplier = SPEED_LEVELS[speedLevelRef.current];
    
    // Sprint doubles the effective speed
    const sprintMultiplier = keys.sprint ? SPRINT_MULTIPLIER : 1.0;
    
    // Combined multiplier for acceleration
    const totalMultiplier = speedMultiplier * sprintMultiplier;
    
    // Calculate input direction
    // PERFORMANCE: Reuse pre-allocated vectors instead of creating new ones
    forwardVec.set(0, 0, -1);
    rightVec.set(1, 0, 0);
    
    // Apply yaw rotation only (not pitch) for horizontal movement
    yawEuler.set(0, -rotationRef.current.yaw, 0);
    forwardVec.applyEuler(yawEuler);
    rightVec.applyEuler(yawEuler);
    
    // Build input vector from key states
    inputVec.set(0, 0, 0);
    
    if (keys.forward) inputVec.add(forwardVec);
    if (keys.backward) inputVec.sub(forwardVec);
    if (keys.right) inputVec.add(rightVec);
    if (keys.left) inputVec.sub(rightVec);
    
    // Vertical movement (independent of look direction)
    if (keys.up) inputVec.y += 1;
    if (keys.down) inputVec.y -= 1;
    
    // Normalize input to prevent diagonal speed boost
    if (inputVec.length() > 0) {
      inputVec.normalize();
    }
    
    // Smooth delta-time physics with separate horizontal/vertical friction
    //
    // Minecraft formula per tick: velocity = velocity * friction + input * acceleration
    // For smooth delta-time, we use exponential decay: v = v * e^(-λ * delta)
    //
    // Horizontal (X/Z): Softer friction for gliding feel
    // Vertical (Y): High friction for snappy stops
    
    // Apply friction using exponential decay - different rates for horizontal vs vertical
    const horizontalFrictionFactor = Math.exp(-HORIZONTAL_DECAY_RATE * clampedDelta);
    const verticalFrictionFactor = Math.exp(-VERTICAL_DECAY_RATE * clampedDelta);
    
    velocity.x *= horizontalFrictionFactor;
    velocity.z *= horizontalFrictionFactor;
    velocity.y *= verticalFrictionFactor;
    
    // Apply acceleration from input - different rates for horizontal vs vertical
    const horizontalAccel = HORIZONTAL_ACCELERATION_PER_SEC * totalMultiplier * clampedDelta;
    const verticalAccel = VERTICAL_ACCELERATION_PER_SEC * totalMultiplier * clampedDelta;
    
    velocity.x += inputVec.x * horizontalAccel;
    velocity.z += inputVec.z * horizontalAccel;
    velocity.y += inputVec.y * verticalAccel;
    
    // Update position (velocity is blocks/second, integrate over delta)
    let positionChanged = false;
    if (velocity.length() > 0.001) {
      camera.position.x += velocity.x * clampedDelta;
      camera.position.y += velocity.y * clampedDelta;
      camera.position.z += velocity.z * clampedDelta;
      positionChanged = true;
    }
    
    if (positionChanged) {
      invalidate();
    }
    
    // PERFORMANCE: Only report camera state when it actually changes
    // This prevents React re-renders every frame when stationary
    if (onCameraUpdate) {
      const { pitch, yaw } = internalToMinecraftRotation(
        rotationRef.current.yaw,
        rotationRef.current.pitch
      );
      
      // Check if position or rotation changed significantly
      const lastPos = lastReportedPos.current;
      const posDelta = Math.abs(camera.position.x - lastPos.x) + 
                       Math.abs(camera.position.y - lastPos.y) + 
                       Math.abs(camera.position.z - lastPos.z);
      const rotDelta = Math.abs(pitch - lastPos.pitch) + Math.abs(yaw - lastPos.yaw);
      
      // Only update if moved more than 0.01 blocks or rotated more than 0.1 degrees
      if (posDelta > 0.01 || rotDelta > 0.1) {
        const cardinal = getCardinalDirection(yaw);
        
        onCameraUpdate({
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          pitch,
          yaw,
          direction: cardinal.direction,
          axis: cardinal.axis,
          speedMultiplier: speedMultiplier * sprintMultiplier,  // Report effective speed
        });
        
        lastReportedPos.current = {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          pitch,
          yaw,
        };
      }
    }
  });
  
  return null;
});

export default SpectatorControls;

