/**
 * PartialBlockDebug - Debug page for visualizing partial blocks
 * Shows cross patterns, slabs, stairs, and other non-cube blocks
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ModelGeometry } from '../assets/ModelGeometry.js';
import { ModelResolver } from '../assets/ModelResolver.js';

// Test blocks to display
const TEST_BLOCKS = [
  // Cross patterns
  { name: 'cross', texture: 'short_grass', label: 'Short Grass' },
  { name: 'cross', texture: 'poppy', label: 'Poppy' },
  { name: 'cross', texture: 'dandelion', label: 'Dandelion' },
  { name: 'pointed_dripstone', texture: 'pointed_dripstone_up_tip', label: 'Dripstone Tip' },
  { name: 'pointed_dripstone', texture: 'pointed_dripstone_up_base', label: 'Dripstone Base' },
  // Other partial blocks
  { name: 'slab', texture: 'stone', label: 'Stone Slab' },
  { name: 'carpet', texture: 'white_wool', label: 'White Carpet' },
];

export default function PartialBlockDebug() {
  const containerRef = useRef(null);
  const [status, setStatus] = useState('Loading...');
  const [modelResolver, setModelResolver] = useState(null);

  // Load the model resolver
  useEffect(() => {
    async function loadResolver() {
      try {
        setStatus('Loading model resolver...');
        const resolver = new ModelResolver();
        await resolver.loadAll();
        setModelResolver(resolver);
        setStatus('Ready');
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        console.error(err);
      }
    }
    loadResolver();
  }, []);

  // Set up Three.js scene
  useEffect(() => {
    if (!containerRef.current || !modelResolver) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    // Camera
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(5, 4, 8);
    camera.lookAt(0, 0, 0);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    scene.add(directionalLight);

    // Grid helper
    const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x333333);
    scene.add(gridHelper);

    // Axes helper
    const axesHelper = new THREE.AxesHelper(3);
    scene.add(axesHelper);

    // Create test blocks
    const modelGeometry = new ModelGeometry();
    const blocksPerRow = 4;
    const spacing = 2;

    // Generic function to create any block model
    async function createCrossBlock(position, label) {
      await createBlock(position, 'block/cross', label, 0x4a9c4a, 0x00ff00);
    }

    // Create a block from model path
    async function createBlock(position, modelPath, label, color = 0x888888, wireColor = 0x00ff00) {
      try {
        const model = await modelResolver.resolve(modelPath);
        if (!model) {
          console.warn(`Could not resolve model: ${modelPath}`);
          addLabel(`${label} (MISSING)`, position.clone().add(new THREE.Vector3(0.5, 1.5, 0.5)));
          return;
        }

        const geom = modelGeometry.getGeometry(model, 0, 0);
        if (!geom) {
          console.warn(`Could not compute geometry for: ${modelPath}`);
          addLabel(`${label} (NO GEOM)`, position.clone().add(new THREE.Vector3(0.5, 1.5, 0.5)));
          return;
        }

        const threeGeom = new THREE.BufferGeometry();
        threeGeom.setAttribute('position', new THREE.BufferAttribute(geom.positions, 3));
        threeGeom.setAttribute('normal', new THREE.BufferAttribute(geom.normals, 3));
        threeGeom.setIndex(new THREE.BufferAttribute(geom.indices, 1));

        const solidMaterial = new THREE.MeshPhongMaterial({
          color: color,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.7,
        });

        const wireMaterial = new THREE.MeshBasicMaterial({
          color: wireColor,
          wireframe: true,
        });

        const solidMesh = new THREE.Mesh(threeGeom.clone(), solidMaterial);
        solidMesh.position.copy(position);
        scene.add(solidMesh);

        const wireMesh = new THREE.Mesh(threeGeom.clone(), wireMaterial);
        wireMesh.position.copy(position);
        scene.add(wireMesh);

        addLabel(label, position.clone().add(new THREE.Vector3(0.5, 1.5, 0.5)));

        const box = new THREE.BoxHelper(solidMesh, 0xffff00);
        scene.add(box);

        console.log(`Created ${label}: ${geom.positions.length / 3} vertices, ${geom.indices.length / 3} triangles`);

      } catch (err) {
        console.error(`Error creating ${label}:`, err);
      }
    }

    // Create a simple labeled text sprite
    function addLabel(text, position) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 256;
      canvas.height = 64;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = 'bold 24px Arial';
      ctx.fillStyle = 'white';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);

      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({ map: texture });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(position);
      sprite.scale.set(2, 0.5, 1);
      scene.add(sprite);
    }

    // Add reference cube for scale
    function addReferenceCube(position) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const edges = new THREE.EdgesGeometry(geometry);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x888888 }));
      line.position.copy(position);
      line.position.add(new THREE.Vector3(0.5, 0.5, 0.5));
      scene.add(line);

      addLabel('1x1x1 Ref', position.clone().add(new THREE.Vector3(0.5, 1.5, 0.5)));
    }

    // Create all test blocks
    async function createTestBlocks() {
      // Row -1: Reference
      addReferenceCube(new THREE.Vector3(-3, 0, 0));

      // Row 0: Cross patterns (Y-axis rotation with rescale)
      await createCrossBlock(new THREE.Vector3(0, 0, 0), 'Cross');
      await createBlock(new THREE.Vector3(2.5, 0, 0), 'block/pointed_dripstone', 'Dripstone', 0x8b7355, 0xff6600);
      await createBlock(new THREE.Vector3(5, 0, 0), 'block/tinted_cross', 'Tinted Cross', 0x4a9c4a, 0x00ff00);

      // Row 1: Non-rotated partial blocks
      await createBlock(new THREE.Vector3(0, 0, 3), 'block/slab', 'Slab', 0x888888, 0x00ffff);
      await createBlock(new THREE.Vector3(2.5, 0, 3), 'block/carpet', 'Carpet', 0xffffff, 0xff00ff);
      await createBlock(new THREE.Vector3(5, 0, 3), 'block/slab_top', 'Slab Top', 0x888888, 0x00ffff);

      // Row 2: Complex models with rotation
      await createBlock(new THREE.Vector3(0, 0, 6), 'block/sunflower_top', 'Sunflower (Z-rot)', 0xffcc00, 0xff6600);
      await createBlock(new THREE.Vector3(2.5, 0, 6), 'block/template_azalea', 'Azalea', 0x4a9c4a, 0x00ff00);
      await createBlock(new THREE.Vector3(5, 0, 6), 'block/template_torch', 'Torch', 0xffaa00, 0xff6600);

      // Row 3: Flat horizontal blocks (thin in Y)
      await createBlock(new THREE.Vector3(0, 0, 9), 'block/lily_pad', 'Lily Pad', 0x228b22, 0x00ff00);
      await createBlock(new THREE.Vector3(2.5, 0, 9), 'block/template_rail_flat', 'Rail Flat', 0x8b4513, 0xff6600);
      await createBlock(new THREE.Vector3(5, 0, 9), 'block/template_leaf_litter_3', 'Leaf Litter', 0x8b4513, 0x00ff00);

      // Row 4: Diagonal/rotated flat blocks
      await createBlock(new THREE.Vector3(0, 0, 12), 'block/template_rail_raised_ne', 'Rail Diagonal', 0x8b4513, 0xff6600);
      await createBlock(new THREE.Vector3(2.5, 0, 12), 'block/sunflower_top', 'Sunflower', 0xffcc00, 0xff6600);
      await createBlock(new THREE.Vector3(5, 0, 12), 'block/flowerbed_1', 'Pink Petals', 0xff69b4, 0xff00ff);
    }

    createTestBlocks();

    // Animation loop
    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // Handle resize
    function onResize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', onResize);
      container.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [modelResolver]);

  return (
    <div style={{ 
      width: '100vw', 
      height: '100vh', 
      display: 'flex', 
      flexDirection: 'column',
      background: '#1a1a2e',
      color: 'white',
      fontFamily: 'system-ui, sans-serif'
    }}>
      {/* Header */}
      <div style={{ 
        padding: '12px 20px', 
        background: '#16213e',
        borderBottom: '1px solid #0f3460',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Partial Block Debug</h1>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <span style={{ color: '#94a3b8' }}>Status: {status}</span>
          <a 
            href="/" 
            style={{ 
              color: '#60a5fa', 
              textDecoration: 'none',
              padding: '6px 12px',
              background: '#1e3a5f',
              borderRadius: '4px'
            }}
          >
            ← Back to Viewer
          </a>
        </div>
      </div>

      {/* Info panel */}
      <div style={{ 
        padding: '12px 20px', 
        background: '#0f3460',
        fontSize: '0.875rem',
        color: '#94a3b8'
      }}>
        <strong style={{ color: 'white' }}>Controls:</strong> Left-click drag to rotate, 
        right-click drag to pan, scroll to zoom. 
        <strong style={{ color: 'white', marginLeft: '20px' }}>Legend:</strong> 
        <span style={{ color: '#00ff00', marginLeft: '8px' }}>■</span> Green wireframe = geometry edges, 
        <span style={{ color: '#ffff00', marginLeft: '8px' }}>□</span> Yellow box = bounding box
      </div>

      {/* Canvas container */}
      <div 
        ref={containerRef} 
        style={{ 
          flex: 1, 
          width: '100%',
          minHeight: 0 
        }} 
      />
    </div>
  );
}

