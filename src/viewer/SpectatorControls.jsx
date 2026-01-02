/**
 * SpectatorControls - Minecraft-style spectator mode camera controls
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
 */

import { useRef, useEffect, useCallback, useState, useImperativeHandle, forwardRef, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Movement speed in blocks per second
const MOVE_SPEED = 50;
const FAST_MOVE_SPEED = 150;
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
  moveSpeed = MOVE_SPEED,
  fastMoveSpeed = FAST_MOVE_SPEED,
  mouseSensitivity = MOUSE_SENSITIVITY,
  onCameraUpdate = null,
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
    fast: false,
  });
  
  // Store rotation as internal angles (not Minecraft angles)
  // These get converted when creating the Three.js Euler and when reporting to UI
  // Internal yaw 0 = looking at -Z (North in Minecraft = yaw ±180)
  // To initialize with Minecraft yaw, we convert: internal = (180 - minecraftYaw) in degrees
  const rotationRef = useRef({
    yaw: (180 - initialYaw) * (Math.PI / 180),   // Convert Minecraft yaw to internal radians
    pitch: initialPitch * (Math.PI / 180),        // Convert Minecraft pitch to internal radians
  });
  
  // Expose teleport function via ref
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
        onCameraUpdate({
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          pitch: mcPitch,
          yaw: mcYaw,
          direction: cardinal.direction,
          axis: cardinal.axis,
        });
      }
    }
  }), [camera, invalidate, onCameraUpdate]);
  
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
          keysRef.current.fast = true;
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
          keysRef.current.fast = false;
          break;
      }
    };
    
    canvas.addEventListener('click', handleClick);
    document.addEventListener('pointerlockchange', handleLockChange);
    document.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    
    return () => {
      canvas.removeEventListener('click', handleClick);
      document.removeEventListener('pointerlockchange', handleLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [gl, camera, mouseSensitivity, requestPointerLock, invalidate]);
  
  // PERFORMANCE: Reuse objects to avoid GC pressure from allocations every frame
  const forwardVec = useMemo(() => new THREE.Vector3(), []);
  const rightVec = useMemo(() => new THREE.Vector3(), []);
  const movementVec = useMemo(() => new THREE.Vector3(), []);
  const yawEuler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);
  
  // Track last reported position to only update when changed
  const lastReportedPos = useRef({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0 });
  
  // Movement update each frame
  useFrame((state, delta) => {
    const keys = keysRef.current;
    const speed = keys.fast ? fastMoveSpeed : moveSpeed;
    const distance = speed * delta;
    
    // PERFORMANCE: Reuse pre-allocated vectors instead of creating new ones
    forwardVec.set(0, 0, -1);
    rightVec.set(1, 0, 0);
    
    // Apply yaw rotation only (not pitch) for horizontal movement
    yawEuler.set(0, -rotationRef.current.yaw, 0);
    forwardVec.applyEuler(yawEuler);
    rightVec.applyEuler(yawEuler);
    
    // Calculate movement
    movementVec.set(0, 0, 0);
    
    if (keys.forward) movementVec.add(forwardVec);
    if (keys.backward) movementVec.sub(forwardVec);
    if (keys.right) movementVec.add(rightVec);
    if (keys.left) movementVec.sub(rightVec);
    
    // Normalize horizontal movement
    if (movementVec.length() > 0) {
      movementVec.normalize().multiplyScalar(distance);
    }
    
    // Vertical movement (independent of look direction)
    if (keys.up) movementVec.y += distance;
    if (keys.down) movementVec.y -= distance;
    
    // Apply movement
    const hasMoved = movementVec.length() > 0;
    if (hasMoved) {
      camera.position.add(movementVec);
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

