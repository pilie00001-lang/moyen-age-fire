import React, { useState, useEffect, useRef, Suspense, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls, Sky, Stars, KeyboardControls, useKeyboardControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import { Vector3 as ThreeVector3, Raycaster } from 'three';
import { Enemy, EnemyType, GameState, Obstacle } from './types';
import { Joystick } from './components/Joystick';
import { generateBattleCommentary } from './services/gemini';

// --- Assets & Constants ---
const WALK_SPEED = 15;
const FIRE_RATE = 100; // ms between shots
const ENEMY_SPAWN_RATE = 2000;
const MAX_AMMO = 30;

// World Gen Constants
const CHUNK_SIZE = 60;
const CHUNK_RES = 24; 
const RENDER_DISTANCE = 2; 

// Scale factors
const PLAYER_HEIGHT = 1.7;
const WALL_HEIGHT = 5;

const ENEMY_CONFIG: Record<EnemyType, { hp: number; speed: number; score: number; gold: number; scale: number; color: string }> = {
  peasant: { hp: 40, speed: 7, score: 50, gold: 10, scale: 0.8, color: '#8B4513' }, 
  knight: { hp: 100, speed: 4, score: 100, gold: 25, scale: 1.0, color: '#666666' }, 
  heavy: { hp: 300, speed: 2.5, score: 300, gold: 100, scale: 1.4, color: '#2F4F4F' }, 
  villager: { hp: 30, speed: 5, score: -100, gold: 0, scale: 0.8, color: '#3b82f6' }, 
};

// --- AUDIO SYSTEM ---
class SoundManager {
    ctx: AudioContext | null = null;
    masterGain: GainNode | null = null;

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.3;
            this.masterGain.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(e => console.error(e));
        }
    }

    playTone(freq: number, type: OscillatorType, dur: number) {
        if (!this.ctx || !this.masterGain) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.1, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + dur);
        osc.connect(g).connect(this.masterGain);
        osc.start();
        osc.stop(t + dur);
    }

    playShoot() { this.playNoise(0.1, 1000); } // Shorter, punchier
    playReload() { 
        if (!this.ctx) return;
        this.playTone(400, 'square', 0.05);
        setTimeout(() => this.playTone(350, 'square', 0.05), 600);
        setTimeout(() => this.playNoise(0.2, 2000), 1100);
    }
    playEmpty() { this.playTone(800, 'square', 0.05); }
    playBuy() { 
        if (!this.ctx) return;
        this.playTone(1200, 'sine', 0.1);
        setTimeout(() => this.playTone(1800, 'sine', 0.2), 100);
    }
    playHit() {
        this.playTone(200, 'sawtooth', 0.1);
    }

    playNoise(dur: number, filterFreq: number) {
        if (!this.ctx || !this.masterGain) return;
        const t = this.ctx.currentTime;
        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for(let i=0; i<data.length; i++) data[i] = (Math.random() * 2 - 1);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const filter = this.ctx.createBiquadFilter();
        filter.frequency.setValueAtTime(filterFreq, t);
        filter.frequency.exponentialRampToValueAtTime(100, t + dur);
        const env = this.ctx.createGain();
        env.gain.setValueAtTime(0.5, t);
        env.gain.exponentialRampToValueAtTime(0.01, t + dur);
        src.connect(filter).connect(env).connect(this.masterGain);
        src.start();
    }
}
const sfx = new SoundManager();

// --- Terrain & Noise ---

const noise = (x: number, z: number, seed: number) => {
    const sin = Math.sin(x * 12.9898 + z * 78.233 + (seed % 1000));
    const s = sin * 43758.5453123;
    return s - Math.floor(s);
}

const smoothNoise = (x: number, z: number, seed: number) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const f = x - i;
    const g = z - j;
    const a = noise(i, j, seed);
    const b = noise(i + 1, j, seed);
    const c = noise(i, j + 1, seed);
    const d = noise(i + 1, j + 1, seed);
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const v = g * g * g * (g * (g * 6 - 15) + 10);
    return (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
}

const getRoadInfluence = (x: number, z: number, seed: number) => {
    const scale = 0.005; 
    const n = smoothNoise(x * scale, z * scale, seed);
    const dist = Math.abs(n - 0.5);
    const roadWidth = 0.05; 
    
    if (dist < roadWidth) return 1;
    return 0;
}

const getTerrainHeight = (x: number, z: number, seed: number) => {
    let y = 0;
    let amp = 10;
    let freq = 0.02; 
    
    y += smoothNoise(x * freq, z * freq, seed) * amp;
    y += smoothNoise(x * freq * 2, z * freq * 2, seed) * (amp / 2);
    
    let height = Math.pow(Math.abs(y), 1.2); 

    const road = getRoadInfluence(x, z, seed);
    if (road > 0) {
        const smoothBase = smoothNoise(x * freq, z * freq, seed) * amp; 
        height = height * 0.1 + smoothBase * 0.9; 
    }

    return height;
};

// --- Generation Logic ---

const seededRandom = (seed: number) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
};

// New Building Generator supporting multiple types
type BuildingType = 'cottage' | 'tower' | 'market';

const generateBuilding = (
    type: BuildingType,
    x: number, 
    z: number, 
    y: number, 
    rotation: number, 
    idPrefix: string
): Obstacle[] => {
    const parts: Obstacle[] = [];
    
    if (type === 'market') {
        const w = 6, d = 6;
        const h = 4;
        [-1, 1].forEach(dx => [-1, 1].forEach(dz => {
            parts.push({
                id: `${idPrefix}:pillar:${dx}:${dz}`,
                type: 'wall',
                position: { x: x + dx * (w/2.2), y: y + h/2, z: z + dz * (d/2.2) },
                rotation: 0,
                scale: { x: 1, y: 1, z: 1 },
                radius: 0.5,
                dims: { w: 0.5, h: h, d: 0.5 }
            });
        }));
        parts.push({
            id: `${idPrefix}:roof`,
            type: 'wall',
            position: { x, y: y + h, z },
            rotation: 0,
            scale: { x: 1, y: 1, z: 1 },
            radius: 0,
            dims: { w: w, h: 0.5, d: d }
        });
        parts.push({
            id: `${idPrefix}:shop`,
            type: 'shop_table',
            position: { x, y: y, z },
            rotation: rotation,
            scale: { x: 1, y: 1, z: 1 },
            radius: 3 
        });
        return parts;
    }

    if (type === 'tower') {
        const w = 5, d = 5;
        const h = 12;
        const wallDefs = [
            { pos: {x:0, z:-d/2}, rot: 0, dim: {w, h, d:1} },
            { pos: {x:0, z:d/2}, rot: 0, dim: {w, h, d:1} },
            { pos: {x:-w/2, z:0}, rot: Math.PI/2, dim: {w:d, h, d:1} },
            { pos: {x:w/2, z:0}, rot: Math.PI/2, dim: {w:d, h, d:1} },
        ];
        wallDefs.forEach((wd, i) => {
             const cos = Math.cos(rotation);
             const sin = Math.sin(rotation);
             const wx = x + (wd.pos.x * cos - wd.pos.z * sin);
             const wz = z + (wd.pos.x * sin + wd.pos.z * cos);
             parts.push({
                id: `${idPrefix}:wall:${i}`,
                type: 'wall',
                position: { x: wx, y: y + h/2, z: wz },
                rotation: rotation + wd.rot,
                scale: {x:1,y:1,z:1}, radius:1,
                dims: wd.dim
             });
        });
        parts.push({
            id: `${idPrefix}:roof`,
            type: 'roof',
            position: { x, y: y + h, z },
            rotation: rotation,
            scale: { x: w + 2, y: 6, z: d + 2 },
            radius: 0
        });
        return parts;
    }

    const width = 8;
    const depth = 8;
    const h = WALL_HEIGHT;
    const walls = [
        { type: 'back', w: width, d: 1, pos: { x: 0, z: -depth/2 }, rot: 0 },
        { type: 'left', w: depth, d: 1, pos: { x: -width/2, z: 0 }, rot: Math.PI/2 },
        { type: 'right', w: depth, d: 1, pos: { x: width/2, z: 0 }, rot: Math.PI/2 },
    ];
    walls.forEach(w => {
         const cos = Math.cos(rotation);
         const sin = Math.sin(rotation);
         const wx = x + (w.pos.x * cos - w.pos.z * sin);
         const wz = z + (w.pos.x * sin + w.pos.z * cos);
         parts.push({
            id: `${idPrefix}:wall:${w.type}`,
            type: 'wall',
            position: { x: wx, y: y + h/2, z: wz },
            rotation: rotation + w.rot,
            scale: { x: 1, y: 1, z: 1 },
            radius: 1,
            dims: { w: w.w, h: h, d: 1 }
        });
    });

    const doorGap = 3;
    const frontWallW = (width - doorGap) / 2;
    const fOffset = depth/2;
    const flX = x + (-frontWallW/2 - doorGap/2) * Math.cos(rotation) - fOffset * Math.sin(rotation);
    const flZ = z + (-frontWallW/2 - doorGap/2) * Math.sin(rotation) + fOffset * Math.cos(rotation);
    parts.push({
        id: `${idPrefix}:wall:fl`,
        type: 'wall',
        position: { x: flX, y: y + h/2, z: flZ },
        rotation: rotation,
        scale: { x: 1, y: 1, z: 1 },
        radius: 1,
        dims: { w: frontWallW, h: h, d: 1 }
    });
    const frX = x + (frontWallW/2 + doorGap/2) * Math.cos(rotation) - fOffset * Math.sin(rotation);
    const frZ = z + (frontWallW/2 + doorGap/2) * Math.sin(rotation) + fOffset * Math.cos(rotation);
    parts.push({
        id: `${idPrefix}:wall:fr`,
        type: 'wall',
        position: { x: frX, y: y + h/2, z: frZ },
        rotation: rotation,
        scale: { x: 1, y: 1, z: 1 },
        radius: 1,
        dims: { w: frontWallW, h: h, d: 1 }
    });
    parts.push({
        id: `${idPrefix}:roof`,
        type: 'roof',
        position: { x, y: y + h, z },
        rotation: rotation,
        scale: { x: width + 1, y: 4, z: depth + 1 },
        radius: 0
    });
    return parts;
}

const generateChunk = (chunkX: number, chunkZ: number, worldSeed: number): Obstacle[] => {
  const obstacles: Obstacle[] = [];
  const chunkSeed = chunkX * 73856093 ^ chunkZ * 19349663 ^ Math.floor(worldSeed); 
  const getRand = (offset: number) => seededRandom(chunkSeed + offset);

  const worldX = chunkX * CHUNK_SIZE;
  const worldZ = chunkZ * CHUNK_SIZE;
  const centerX = worldX + CHUNK_SIZE / 2;
  const centerZ = worldZ + CHUNK_SIZE / 2;
  const centerRoadInf = getRoadInfluence(centerX, centerZ, worldSeed);
  
  let villageChance = 0.96; 
  if (centerRoadInf > 0) villageChance = 0.6; 
  const isVillage = getRand(999) > villageChance;

  if (isVillage) {
      const cy = getTerrainHeight(centerX, centerZ, worldSeed);
      if (getRoadInfluence(centerX, centerZ, worldSeed) === 0) { 
          obstacles.push(...generateBuilding('market', centerX, centerZ, cy, 0, `${chunkX}:${chunkZ}:market`));
      }
      const houseCount = 3 + Math.floor(getRand(888) * 3);
      const radius = 15;
      for(let i=0; i<houseCount; i++) {
          const angle = (Math.PI * 2 * i) / houseCount + getRand(i)*0.5;
          const dist = radius + getRand(i+50) * 10;
          const hx = centerX + Math.cos(angle) * dist;
          const hz = centerZ + Math.sin(angle) * dist;
          if (getRoadInfluence(hx, hz, worldSeed) > 0) continue; 
          const y = getTerrainHeight(hx, hz, worldSeed);
          const rot = Math.atan2(centerZ - hz, centerX - hx); 
          const bType: BuildingType = getRand(i * 99) > 0.7 ? 'tower' : 'cottage';
          obstacles.push(...generateBuilding(bType, hx, hz, y, rot, `${chunkX}:${chunkZ}:b${i}`));
      }
      if (getRand(50) > 0.5) {
        const wx = centerX + 5;
        const wz = centerZ + 5;
        const wy = getTerrainHeight(wx, wz, worldSeed);
        obstacles.push({
            id: `${chunkX}:${chunkZ}:well`,
            type: 'well',
            position: { x: wx, y: wy, z: wz },
            rotation: 0,
            scale: { x: 1, y: 1, z: 1 },
            radius: 2
        });
      }
  }

  const treeCount = isVillage ? 2 : Math.floor(getRand(1) * 10) + 2; 
  for (let i = 0; i < treeCount; i++) {
      const lx = getRand(i * 10) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const lz = getRand(i * 10 + 1) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const wx = worldX + lx + CHUNK_SIZE/2;
      const wz = worldZ + lz + CHUNK_SIZE/2;
      if (getRoadInfluence(wx, wz, worldSeed) > 0) continue;
      const y = getTerrainHeight(wx, wz, worldSeed);
      obstacles.push({
          id: `${chunkX}:${chunkZ}:tree:${i}`,
          type: 'tree',
          position: { x: wx, y: y, z: wz },
          rotation: getRand(i * 10 + 2) * Math.PI,
          scale: { x: 1 + getRand(i)*0.5, y: 1 + getRand(i+5), z: 1 + getRand(i)*0.5 },
          radius: 1
      });
  }
  return obstacles;
};

// --- Visual Components ---

const Wall = React.memo(({ data }: { data: Obstacle }) => {
    if (!data.dims) return null;
    const hasWindow = data.dims.w > 3 && data.dims.h > 3;

    return (
        <group position={[data.position.x, data.position.y, data.position.z]} rotation={[0, data.rotation, 0]}>
            <mesh castShadow receiveShadow>
                <boxGeometry args={[data.dims.w, data.dims.h, data.dims.d * 0.8]} />
                <meshStandardMaterial color="#f2e8d5" roughness={0.9} />
            </mesh>
            <mesh position={[-data.dims.w/2 + 0.2, 0, 0]} castShadow>
                <boxGeometry args={[0.4, data.dims.h + 0.1, data.dims.d]} />
                <meshStandardMaterial color="#3e2723" roughness={1} />
            </mesh>
            <mesh position={[data.dims.w/2 - 0.2, 0, 0]} castShadow>
                <boxGeometry args={[0.4, data.dims.h + 0.1, data.dims.d]} />
                <meshStandardMaterial color="#3e2723" roughness={1} />
            </mesh>
            <mesh position={[0, data.dims.h/2 - 0.2, 0]} castShadow>
                 <boxGeometry args={[data.dims.w, 0.4, data.dims.d]} />
                 <meshStandardMaterial color="#3e2723" roughness={1} />
            </mesh>
            <mesh position={[0, -data.dims.h/2 + 0.2, 0]} castShadow>
                 <boxGeometry args={[data.dims.w, 0.4, data.dims.d]} />
                 <meshStandardMaterial color="#3e2723" roughness={1} />
            </mesh>
            {data.dims.w > 4 && (
                <mesh position={[0, 0, 0]} castShadow>
                    <boxGeometry args={[data.dims.w, 0.3, data.dims.d]} />
                    <meshStandardMaterial color="#3e2723" roughness={1} />
                </mesh>
            )}
            {hasWindow && (
                <mesh position={[0, 0.5, 0]}>
                    <boxGeometry args={[1.5, 1.5, data.dims.d + 0.1]} />
                    <meshStandardMaterial color="#2c3e50" roughness={0.2} metalness={0.5} />
                    <mesh position={[0, 0, 0.06]}>
                        <boxGeometry args={[1.5, 0.1, 0.1]} />
                        <meshStandardMaterial color="#3e2723" />
                    </mesh>
                    <mesh position={[0, 0, 0.06]}>
                        <boxGeometry args={[0.1, 1.5, 0.1]} />
                        <meshStandardMaterial color="#3e2723" />
                    </mesh>
                </mesh>
            )}
        </group>
    );
});

const Roof = React.memo(({ data }: { data: Obstacle }) => (
    <group position={[data.position.x, data.position.y + 0.5, data.position.z]} rotation={[0, data.rotation, 0]}>
        <mesh position={[0, 1, 0]} rotation={[0, Math.PI/4, 0]} castShadow>
            <coneGeometry args={[data.scale.x * 0.75, data.scale.y, 4]} />
            <meshStandardMaterial color="#8d6e63" roughness={0.8} />
        </mesh>
        <mesh position={[0, -data.scale.y/2 + 1, 0]} rotation={[0, Math.PI/4, 0]}>
             <boxGeometry args={[data.scale.x, 0.2, data.scale.z]} />
             <meshStandardMaterial color="#3e2723" />
        </mesh>
    </group>
));

const ShopTable = React.memo(({ data }: { data: Obstacle }) => (
    <group position={[data.position.x, data.position.y, data.position.z]} rotation={[0, data.rotation, 0]}>
        <mesh position={[0, 0.5, 0]} castShadow>
            <boxGeometry args={[2, 1, 1]} />
            <meshStandardMaterial color="#3e2723" />
        </mesh>
        <mesh position={[-0.5, 1.1, 0]}>
            <boxGeometry args={[0.3, 0.2, 0.3]} />
            <meshStandardMaterial color="green" />
        </mesh>
        <mesh position={[0, 1, 1]} castShadow>
             <sphereGeometry args={[0.4]} />
             <meshStandardMaterial color="#e0ac69" />
        </mesh>
        <mesh position={[0, 0.2, 1]}>
             <cylinderGeometry args={[0.3, 0.4, 1.4]} />
             <meshStandardMaterial color="#552200" />
        </mesh>
        <Text position={[0, 2.5, 0]} fontSize={0.5} color="gold" anchorX="center" anchorY="middle">
            SHOP
        </Text>
    </group>
));

const Tree: React.FC<{ data: Obstacle }> = React.memo(({ data }) => (
  <group position={[data.position.x, data.position.y, data.position.z]} rotation={[0, data.rotation, 0]} scale={[data.scale.x, data.scale.y, data.scale.z]}>
    <mesh position={[0, 1, 0]} castShadow>
      <cylinderGeometry args={[0.2, 0.4, 2, 8]} />
      <meshStandardMaterial color="#4d3319" />
    </mesh>
    <mesh position={[0, 3, 0]} castShadow>
      <coneGeometry args={[1.5, 4, 8]} />
      <meshStandardMaterial color="#1a4d1a" />
    </mesh>
  </group>
));

const Well: React.FC<{ data: Obstacle }> = React.memo(({ data }) => (
  <group position={[data.position.x, data.position.y, data.position.z]} rotation={[0, data.rotation, 0]} scale={[data.scale.x, data.scale.y, data.scale.z]}>
     <mesh position={[0, 0.4, 0]} castShadow>
        <cylinderGeometry args={[1, 1, 0.8, 8]} />
        <meshStandardMaterial color="#595959" />
     </mesh>
     <mesh position={[0, 0.6, 0]} rotation={[-Math.PI/2, 0, 0]}>
        <circleGeometry args={[0.8, 16]} />
        <meshStandardMaterial color="#225588" />
     </mesh>
     <mesh position={[0, 2.3, 0]} rotation={[0, 0, Math.PI/4]} castShadow>
         <boxGeometry args={[1.8, 1.8, 1.2]} />
         <meshStandardMaterial color="#3e2723" />
     </mesh>
  </group>
));

const TerrainChunk = React.memo(({ x, z, seed }: { x: number, z: number, seed: number }) => {
    const geometry = useMemo(() => {
        const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_RES, CHUNK_RES);
        geo.rotateX(-Math.PI / 2); 
        const count = geo.attributes.position.count;
        const pos = geo.attributes.position;
        const colors = new Float32Array(count * 3); 
        const worldX = x * CHUNK_SIZE;
        const worldZ = z * CHUNK_SIZE;
        const grassColor = new THREE.Color("#2d4c1e");
        const dirtColor = new THREE.Color("#4d3319");
        const roadColor = new THREE.Color("#8B7355"); 
        const tempColor = new THREE.Color();

        for (let i = 0; i < count; i++) {
            const px = pos.getX(i) + worldX; 
            const pz = pos.getZ(i) + worldZ;
            const h = getTerrainHeight(px, pz, seed);
            pos.setY(i, h);
            const roadInf = getRoadInfluence(px, pz, seed);
            
            if (roadInf > 0) {
                tempColor.lerpColors(grassColor, roadColor, roadInf);
            } else {
                const noiseVal = smoothNoise(px * 0.1, pz * 0.1, seed);
                tempColor.lerpColors(grassColor, dirtColor, noiseVal * 0.3);
            }
            colors[i * 3] = tempColor.r;
            colors[i * 3 + 1] = tempColor.g;
            colors[i * 3 + 2] = tempColor.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.computeVertexNormals();
        return geo;
    }, [x, z, seed]);

    return (
        <mesh geometry={geometry} position={[x * CHUNK_SIZE, 0, z * CHUNK_SIZE]} receiveShadow>
            <meshStandardMaterial vertexColors roughness={1} />
        </mesh>
    );
});

// --- Physics & Collision ---

const checkCollision = (position: THREE.Vector3, obstacles: Obstacle[], radius: number): boolean => {
  for (const obs of obstacles) {
    const dx = position.x - obs.position.x;
    const dz = position.z - obs.position.z;
    if (Math.abs(dx) > 15 || Math.abs(dz) > 15) continue;
    if (obs.type === 'wall' && obs.dims) {
        const cos = Math.cos(-obs.rotation);
        const sin = Math.sin(-obs.rotation);
        const localX = dx * cos - dz * sin;
        const localZ = dx * sin + dz * cos;
        const halfW = (obs.dims.w / 2) + radius;
        const halfD = (obs.dims.d / 2) + radius;
        if (Math.abs(localX) < halfW && Math.abs(localZ) < halfD) return true;
    } else if (obs.radius > 0) {
        const distSq = dx * dx + dz * dz;
        const minDist = obs.radius + radius;
        if (distSq < minDist * minDist) return true;
    }
  }
  return false;
};

// --- Player & Game Logic ---

// Visual Component for the Laser Beam (Weapon Tracer)
const LaserBeam: React.FC<{ start: THREE.Vector3, end: THREE.Vector3 }> = ({ start, end }) => {
    const ref = useRef<THREE.Mesh>(null);
    const distance = start.distanceTo(end);
    const position = start.clone().lerp(end, 0.5);

    return (
        <mesh ref={ref} position={position} lookAt={end}>
            <cylinderGeometry args={[0.03, 0.03, distance, 6]} />
            <meshBasicMaterial color="#ffff00" transparent opacity={0.8} />
            <mesh rotation={[Math.PI/2, 0, 0]}>
                 <cylinderGeometry args={[0.06, 0.06, distance, 6]} />
                 <meshBasicMaterial color="#ffaa00" transparent opacity={0.3} blending={THREE.AdditiveBlending} />
            </mesh>
        </mesh>
    );
};

const Weapon = ({ isFiring, isReloading }: { isFiring: boolean; isReloading: boolean }) => {
    const group = useRef<THREE.Group>(null);
    useFrame((state) => {
        if(!group.current) return;
        const t = state.clock.getElapsedTime();
        group.current.position.y = -0.25 + Math.sin(t * 2) * 0.005;
        group.current.position.x = 0.3 + Math.cos(t * 1.5) * 0.005;
        
        // Recoil
        if (isFiring) {
            group.current.position.z = Math.min(group.current.position.z + 0.1, -0.3);
            group.current.rotation.x = 0.1;
        } else {
            group.current.position.z = THREE.MathUtils.lerp(group.current.position.z, -0.5, 0.1);
            group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, 0, 0.1);
        }

        if(isReloading) {
            group.current.rotation.x = -0.5;
            group.current.rotation.z = -0.5;
        } else {
            group.current.rotation.z = 0;
        }
    });

    return (
        <group ref={group} position={[0.3, -0.25, -0.5]}>
             <mesh castShadow>
                 <boxGeometry args={[0.08, 0.1, 0.6]} />
                 <meshStandardMaterial color="#222" />
             </mesh>
             <mesh position={[0, -0.05, 0.2]} rotation={[0.2,0,0]}>
                 <boxGeometry args={[0.08, 0.15, 0.3]} />
                 <meshStandardMaterial color="#5C4033" />
             </mesh>
             <mesh position={[0, 0.05, -0.4]}>
                 <cylinderGeometry args={[0.015, 0.02, 0.4]} />
                 <meshStandardMaterial color="#111" />
             </mesh>
             {/* Magazine */}
             <mesh position={[0, -0.15, -0.1]} rotation={[0.2, 0, 0]}>
                 <boxGeometry args={[0.06, 0.25, 0.1]} />
                 <meshStandardMaterial color="#333" />
             </mesh>
        </group>
    );
};

const ProceduralCharacter: React.FC<{ enemy: Enemy; seed: number; terrainHeight: (x:number, z:number, s:number) => number }> = ({ enemy, seed, terrainHeight }) => {
  const group = useRef<THREE.Group>(null);
  const head = useRef<THREE.Mesh>(null);
  const body = useRef<THREE.Mesh>(null);
  const armL = useRef<THREE.Mesh>(null);
  const armR = useRef<THREE.Mesh>(null);
  const legL = useRef<THREE.Mesh>(null);
  const legR = useRef<THREE.Mesh>(null);

  const isDeadRef = useRef(false);
  const velocityRef = useRef(new THREE.Vector3());
  const config = ENEMY_CONFIG[enemy.type];

  useFrame((state, delta) => {
      if (!group.current) return;
      const t = state.clock.getElapsedTime();
      
      if (enemy.isDead) {
          if (!isDeadRef.current) {
              isDeadRef.current = true;
              if (enemy.velocity) velocityRef.current.copy(enemy.velocity);
              else velocityRef.current.set(0, 5, 0); 
          }
          const vel = velocityRef.current;
          group.current.position.add(vel.clone().multiplyScalar(delta));
          vel.y -= 25 * delta; 
          
          const ground = terrainHeight(group.current.position.x, group.current.position.z, seed);
          if (group.current.position.y < ground + 0.2) {
              group.current.position.y = ground + 0.2;
              vel.multiplyScalar(0.9); 
              if (Math.abs(vel.y) < 0.1) vel.y = 0;
              else vel.y *= -0.3; 
          }
          group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, -Math.PI / 2, delta * 8);
          return;
      }

      const terrainH = terrainHeight(enemy.position.x, enemy.position.z, seed);
      group.current.position.set(enemy.position.x, terrainH + (0.9 * config.scale), enemy.position.z);
      group.current.lookAt(0, group.current.position.y, 0); 

      const walkSpeed = enemy.speed * 2;
      const walkCycle = t * walkSpeed;
      
      if (legL.current && legR.current && armL.current && armR.current && body.current && head.current) {
          legL.current.rotation.x = Math.sin(walkCycle) * 0.8;
          legR.current.rotation.x = Math.sin(walkCycle + Math.PI) * 0.8;
          if (enemy.type === 'villager' && !enemy.isAttacking) {
              if (Math.abs(Math.sin(walkCycle)) > 0.1) {
                   armL.current.rotation.z = 2.5; 
                   armR.current.rotation.z = -2.5;
                   armL.current.rotation.x = Math.sin(t * 15) * 0.5;
                   armR.current.rotation.x = Math.cos(t * 15) * 0.5;
              } else {
                  armL.current.rotation.z = 0;
                  armR.current.rotation.z = 0;
              }
          } else if (!enemy.isAttacking) {
              armL.current.rotation.x = Math.sin(walkCycle + Math.PI) * 0.6;
              armR.current.rotation.x = Math.sin(walkCycle) * 0.6;
          } else {
              armL.current.rotation.x = -Math.PI / 2 + Math.sin(t * 15) * 0.2;
              armR.current.rotation.x = -Math.PI / 2 + Math.cos(t * 15) * 0.2;
          }
          body.current.rotation.y = Math.sin(walkCycle) * 0.1;
          head.current.rotation.y = Math.sin(t) * 0.1;
      }
  });

  const skinColor = config.color;
  const isKnight = enemy.type === 'knight' || enemy.type === 'heavy';
  const headColor = isKnight ? '#888' : '#e0ac69';

  return (
    <group ref={group} scale={[config.scale, config.scale, config.scale]}>
        <mesh ref={head} position={[0, 0.7, 0]} castShadow>
            <boxGeometry args={[0.4, 0.4, 0.4]} />
            <meshStandardMaterial color={headColor} />
            <mesh position={[0.1, 0.05, 0.21]}>
                <planeGeometry args={[0.05, 0.05]} />
                <meshBasicMaterial color="black" />
            </mesh>
            <mesh position={[-0.1, 0.05, 0.21]}>
                <planeGeometry args={[0.05, 0.05]} />
                <meshBasicMaterial color="black" />
            </mesh>
        </mesh>
        <mesh ref={body} position={[0, 0.1, 0]} castShadow>
            <boxGeometry args={[0.5, 0.8, 0.3]} />
            <meshStandardMaterial color={skinColor} />
        </mesh>
        <group position={[-0.35, 0.4, 0]}>
            <mesh ref={armL} position={[0, -0.3, 0]}>
                <boxGeometry args={[0.15, 0.7, 0.15]} />
                <meshStandardMaterial color={skinColor} />
            </mesh>
        </group>
        <group position={[0.35, 0.4, 0]}>
             <mesh ref={armR} position={[0, -0.3, 0]}>
                <boxGeometry args={[0.15, 0.7, 0.15]} />
                <meshStandardMaterial color={skinColor} />
                 {isKnight && (
                     <mesh position={[0, -0.4, 0.3]} rotation={[1.5, 0, 0]}>
                         <boxGeometry args={[0.05, 0.8, 0.05]} />
                         <meshStandardMaterial color="#ccc" metalness={0.8} roughness={0.2} />
                         <mesh position={[0, -0.3, 0]} rotation={[0,0,1.57]}>
                             <boxGeometry args={[0.05, 0.2, 0.05]} />
                             <meshStandardMaterial color="#333" />
                         </mesh>
                     </mesh>
                 )}
            </mesh>
        </group>
        <group position={[-0.15, -0.3, 0]}>
            <mesh ref={legL} position={[0, -0.35, 0]}>
                <boxGeometry args={[0.18, 0.75, 0.18]} />
                <meshStandardMaterial color="#111" />
            </mesh>
        </group>
        <group position={[0.15, -0.3, 0]}>
            <mesh ref={legR} position={[0, -0.35, 0]}>
                <boxGeometry args={[0.18, 0.75, 0.18]} />
                <meshStandardMaterial color="#111" />
            </mesh>
        </group>
    </group>
  );
};

const World = React.memo(({ obstacles, playerPos, seed }: { obstacles: Obstacle[], playerPos: THREE.Vector3, seed: number }) => {
    const cx = Math.floor(playerPos.x / CHUNK_SIZE);
    const cz = Math.floor(playerPos.z / CHUNK_SIZE);
    
    const visibleChunks = useMemo(() => {
        const chunks = [];
        for (let x = cx - RENDER_DISTANCE; x <= cx + RENDER_DISTANCE; x++) {
            for (let z = cz - RENDER_DISTANCE; z <= cz + RENDER_DISTANCE; z++) {
                chunks.push({ x, z, key: `${x}:${z}` });
            }
        }
        return chunks;
    }, [cx, cz]);

    return (
        <>
            <ambientLight intensity={0.4} />
            <directionalLight position={[100, 100, 50]} intensity={1.5} castShadow shadow-mapSize={[2048, 2048]} />
            <Sky sunPosition={[100, 40, 100]} />
            <Stars />

            {visibleChunks.map(c => <TerrainChunk key={c.key} x={c.x} z={c.z} seed={seed} />)}

            {obstacles.map(obs => {
                if (Math.abs(obs.position.x - playerPos.x) > CHUNK_SIZE * (RENDER_DISTANCE + 0.5)) return null;
                if (Math.abs(obs.position.z - playerPos.z) > CHUNK_SIZE * (RENDER_DISTANCE + 0.5)) return null;

                switch(obs.type) {
                    case 'wall': return <Wall key={obs.id} data={obs} />;
                    case 'roof': return <Roof key={obs.id} data={obs} />;
                    case 'shop_table': return <ShopTable key={obs.id} data={obs} />;
                    case 'well': return <Well key={obs.id} data={obs} />;
                    case 'tree': return <Tree key={obs.id} data={obs} />;
                    default: return null;
                }
            })}
        </>
    );
});

const GameController = ({ 
    gameState,
    setGameState,
    joystickData, 
    onShoot,
    enemiesRef, 
    playerRef, 
    obstacles, 
    seed 
}: { 
    gameState: GameState,
    setGameState: React.Dispatch<React.SetStateAction<GameState>>,
    joystickData: {x: number, y: number}, 
    onShoot: (fired: boolean, trigger: number) => void, 
    enemiesRef: React.MutableRefObject<Enemy[]>, 
    playerRef: React.MutableRefObject<THREE.Vector3>, 
    obstacles: Obstacle[], 
    seed: number 
}) => {
    const { camera } = useThree();
    const [, get] = useKeyboardControls();
    const [enemies, setEnemies] = useState<Enemy[]>([]);
    // Beams: Visual laser sticks
    const [beams, setBeams] = useState<{start: ThreeVector3, end: ThreeVector3, id: number}[]>([]);
    const [shopMessage, setShopMessage] = useState<string | null>(null);

    const lastShot = useRef(0);
    const lastSpawn = useRef(0);
    const isMouseDown = useRef(false);
    const shake = useRef(0);

    useEffect(() => {
        camera.position.set(0, 5, 0);
        setEnemies([]);
    }, [seed]);

    useEffect(() => { enemiesRef.current = enemies; }, [enemies]);

    useEffect(() => {
        const down = () => isMouseDown.current = true;
        const up = () => isMouseDown.current = false;
        const key = (e: KeyboardEvent) => {
            if (e.key === 'r') reload();
            if (e.key === 'e' && shopMessage) handleShopAction(); 
        };
        window.addEventListener('mousedown', down);
        window.addEventListener('mouseup', up);
        window.addEventListener('keydown', key);
        return () => {
            window.removeEventListener('mousedown', down);
            window.removeEventListener('mouseup', up);
            window.removeEventListener('keydown', key);
        }
    }, [shopMessage, gameState.gold]);

    const reload = () => {
        if (gameState.ammo < MAX_AMMO) {
            setGameState(p => ({...p, ammo: MAX_AMMO}));
            sfx.playReload();
        }
    };

    const handleShopAction = () => {
        if (!shopMessage) return;
        setGameState(prev => {
            if (shopMessage.includes("AMMO") && prev.gold >= 50) {
                sfx.playBuy();
                return { ...prev, gold: prev.gold - 50, ammo: MAX_AMMO };
            }
            if (shopMessage.includes("HEALTH") && prev.gold >= 100) {
                sfx.playBuy();
                return { ...prev, gold: prev.gold - 100, health: 100 };
            }
            if (shopMessage.includes("UPGRADE") && prev.gold >= 500) {
                sfx.playBuy();
                return { ...prev, gold: prev.gold - 500, damageMultiplier: prev.damageMultiplier + 0.5 };
            }
            sfx.playEmpty(); 
            return prev;
        });
    };

    useFrame((state, delta) => {
        const time = state.clock.getElapsedTime() * 1000;
        
        // 1. Movement
        const { fwd: kFwd, back: kBack, left: kLeft, right: kRight } = get();
        
        const speed = WALK_SPEED * delta;
        const fwdVec = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
        const rightVec = new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
        fwdVec.y = 0; fwdVec.normalize();
        rightVec.y = 0; rightVec.normalize();

        const joyX = joystickData.x;
        const joyY = joystickData.y;
        const keyX = Number(kRight) - Number(kLeft);
        const keyY = Number(kBack) - Number(kFwd);
        const finalX = joyX + keyX;
        const finalY = joyY + keyY;

        let move = new THREE.Vector3();
        if (finalX !== 0 || finalY !== 0) {
            move.add(rightVec.multiplyScalar(finalX)).add(fwdVec.multiplyScalar(-finalY));
            if (move.lengthSq() > 1) move.normalize();
            move.multiplyScalar(speed);
        }

        const nextPos = camera.position.clone().add(move);
        if (!checkCollision(nextPos, obstacles, 0.5)) {
            camera.position.x = nextPos.x;
            camera.position.z = nextPos.z;
        }

        const ground = getTerrainHeight(camera.position.x, camera.position.z, seed);
        const bob = move.length() > 0 ? Math.sin(time * 0.015) * 0.1 : 0;
        camera.position.y = ground + PLAYER_HEIGHT + bob;
        playerRef.current.copy(camera.position);

        // Shop Check
        let nearShop = false;
        for(const obs of obstacles) {
            if (Math.abs(obs.position.x - camera.position.x) > 10) continue;
            if (obs.type === 'shop_table') {
                if (camera.position.distanceTo(obs.position) < 3) {
                    nearShop = true;
                    if (gameState.gold >= 500) setShopMessage("PRESS 'E': UPGRADE DMG (500G)");
                    else if (gameState.health < 50) setShopMessage("PRESS 'E': BUY HEALTH (100G)");
                    else setShopMessage("PRESS 'E': BUY AMMO (50G)");
                    break;
                }
            }
        }
        if (!nearShop) setShopMessage(null);

        // --- SHOOTING LOGIC (HITSCAN) ---
        if (isMouseDown.current && time - lastShot.current > FIRE_RATE) {
            if (gameState.ammo > 0) {
                lastShot.current = time;
                setGameState(p => ({...p, ammo: p.ammo - 1}));
                sfx.playShoot();
                onShoot(true, time);
                shake.current = 0.02;

                // 1. RAYCAST FROM CENTER (The "Crosshair Stick")
                const raycaster = new Raycaster();
                raycaster.setFromCamera(new THREE.Vector2(0,0), camera);
                
                // Default hit point is far away
                let hitPoint = raycaster.ray.at(100, new THREE.Vector3()); 
                let hitId: string | null = null;
                let minDist = 100;

                setEnemies(prev => {
                    const nextEnemies = prev.map(e => {
                        if (e.isDead) return e;
                        const config = ENEMY_CONFIG[e.type];
                        const y = getTerrainHeight(e.position.x, e.position.z, seed) + (0.9 * config.scale);
                        const ePos = new THREE.Vector3(e.position.x, y, e.position.z);
                        
                        // Hitbox logic: Use a generous sphere around the enemy
                        // Increased hitbox size for better game feel (2.0 scale)
                        const hitboxSize = 2.0 * config.scale; 
                        
                        // Math: Ray to point distance
                        const distToRay = raycaster.ray.distanceSqToPoint(ePos);
                        
                        if (distToRay < hitboxSize * hitboxSize) {
                             const distToCam = camera.position.distanceTo(ePos);
                             // Check if this enemy is closer than previous hit and within range
                             if (distToCam < minDist) {
                                 minDist = distToCam;
                                 hitId = e.id;
                                 // Update hitpoint to be on the enemy
                                 hitPoint.copy(ePos);
                             }
                        }
                        return e;
                    }).map(e => {
                        if (e.id === hitId) {
                            // Hit confirmed logic
                            const newHp = e.hp - (35 * gameState.damageMultiplier);
                            if (newHp <= 0) {
                                return { 
                                    ...e, 
                                    hp: 0, 
                                    isDead: true, 
                                    deadTime: time,
                                    velocity: raycaster.ray.direction.clone().normalize().multiplyScalar(8).add(new THREE.Vector3(0,4,0))
                                };
                            }
                            return { ...e, hp: newHp };
                        }
                        return e;
                    });

                    if (hitId) {
                        sfx.playHit();
                        const hitEnemy = prev.find(e => e.id === hitId);
                        if(hitEnemy && hitEnemy.hp > 0 && nextEnemies.find(e => e.id === hitId)?.hp === 0) {
                             const cfg = ENEMY_CONFIG[hitEnemy.type];
                             setGameState(g => ({...g, score: g.score + cfg.score, gold: g.gold + cfg.gold}));
                        }
                    }

                    return nextEnemies;
                });

                // 2. VISUAL BEAM (The "Weapon Stick")
                // Start slightly down and right from camera to simulate gun barrel
                const gunOffset = new THREE.Vector3(0.2, -0.25, -0.3).applyQuaternion(camera.quaternion);
                const start = camera.position.clone().add(gunOffset);
                const id = Math.random();
                
                // Add beam to state
                setBeams(p => [...p, { start, end: hitPoint, id }]);
                
                // Remove beam quickly (flash effect)
                setTimeout(() => setBeams(p => p.filter(b => b.id !== id)), 50);

            } else {
                sfx.playEmpty();
                if (gameState.ammo === 0) reload();
                onShoot(false, 0);
            }
        } else if (!isMouseDown.current) {
            onShoot(false, 0);
        }

        if (shake.current > 0) {
            camera.rotation.x += (Math.random() - 0.5) * shake.current;
            camera.rotation.y += (Math.random() - 0.5) * shake.current;
            shake.current *= 0.9;
        }

        if (time - lastSpawn.current > ENEMY_SPAWN_RATE) {
            lastSpawn.current = time;
            const angle = Math.random() * Math.PI * 2;
            const dist = 30 + Math.random() * 20;
            const ex = camera.position.x + Math.cos(angle) * dist;
            const ez = camera.position.z + Math.sin(angle) * dist;
            const ey = getTerrainHeight(ex, ez, seed);
            
            const rand = Math.random();
            let type: EnemyType = 'knight';
            if (rand < 0.2) type = 'villager';
            else if (rand > 0.8) type = 'heavy';
            else if (rand < 0.4) type = 'peasant';

            const cfg = ENEMY_CONFIG[type];

            setEnemies(p => [...p, {
                id: Math.random().toString(),
                type: type, 
                position: {x: ex, y: ey, z: ez},
                hp: cfg.hp, maxHp: cfg.hp, speed: cfg.speed,
                isAttacking: false
            }]);
        }

        setEnemies(prev => {
            let damageDealt = 0;
            const next = prev.map(e => {
                if (e.isDead) return e;
                const pPos = new THREE.Vector3(camera.position.x, 0, camera.position.z);
                const ePos = new THREE.Vector3(e.position.x, 0, e.position.z);
                const dist = pPos.distanceTo(ePos);
                
                if (dist > 50) return e;

                if (e.type === 'villager') {
                    if (dist < 15) {
                         const dir = ePos.clone().sub(pPos).normalize();
                         ePos.add(dir.multiplyScalar(e.speed * delta));
                    }
                } else {
                    if (dist < 1.5) {
                        e.isAttacking = true;
                        damageDealt += 0.2;
                    } else {
                        e.isAttacking = false;
                        const dir = pPos.sub(ePos).normalize();
                        const nextPos = ePos.clone().add(dir.multiplyScalar(e.speed * delta));
                        if (!checkCollision(nextPos, obstacles, 0.2)) {
                            ePos.copy(nextPos);
                        } else {
                            const sideStep = nextPos.clone().add(new THREE.Vector3(1,0,0));
                            if (!checkCollision(sideStep, obstacles, 0.2)) ePos.copy(sideStep);
                        }
                    }
                }
                
                const ny = getTerrainHeight(ePos.x, ePos.z, seed);
                return { ...e, position: {x: ePos.x, y: ny, z: ePos.z} };
            }).filter(e => !e.isDead || (time - (e.deadTime || 0) < 3000));
            
            if (damageDealt > 0) {
                 setGameState(g => {
                     const nh = Math.max(0, g.health - damageDealt);
                     if (nh === 0 && g.isPlaying) return { ...g, health: 0, isPlaying: false };
                     return { ...g, health: nh };
                 });
                 shake.current = 0.05;
            }
            return next;
        });

        const shopEl = document.getElementById('shop-ui');
        if (shopEl) shopEl.innerText = shopMessage || "";
    });

    return (
        <>
            {enemies.map(e => <ProceduralCharacter key={e.id} enemy={e} seed={seed} terrainHeight={getTerrainHeight} />)}
            {/* Render Beams (Visual Sticks) */}
            {beams.map(b => (
                <LaserBeam key={b.id} start={b.start} end={b.end} />
            ))}
        </>
    );
};

export default function App() {
  const [gameState, setGameState] = useState<GameState>({
    score: 0, gold: 0, health: 100, wave: 1, isPlaying: false, ammo: MAX_AMMO, damageMultiplier: 1
  });
  
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  const [seed, setSeed] = useState(123);
  const [joystick, setJoystick] = useState({x: 0, y: 0});
  const [isFiring, setIsFiring] = useState(false);
  const [commentary, setCommentary] = useState("");
  
  const enemiesRef = useRef<Enemy[]>([]);
  const playerRef = useRef(new THREE.Vector3());
  const loadedChunksRef = useRef(new Set<string>());

  const startGame = () => {
      const newSeed = Math.random() * 999999;
      setSeed(newSeed);
      setGameState({ score: 0, gold: 0, health: 100, wave: 1, isPlaying: true, ammo: MAX_AMMO, damageMultiplier: 1 });
      setObstacles([]); 
      loadedChunksRef.current.clear(); 
      sfx.init();
  };

  const WorldGen = () => {
      const { camera } = useThree();
      useFrame(() => {
          if (!gameState.isPlaying) return;

          const cx = Math.floor(camera.position.x / CHUNK_SIZE);
          const cz = Math.floor(camera.position.z / CHUNK_SIZE);
          
          let newObs: Obstacle[] = [];
          let hasNew = false;

          for(let x = cx - RENDER_DISTANCE; x <= cx + RENDER_DISTANCE; x++) {
              for(let z = cz - RENDER_DISTANCE; z <= cz + RENDER_DISTANCE; z++) {
                  const key = `${x}:${z}`;
                  if (!loadedChunksRef.current.has(key)) {
                      loadedChunksRef.current.add(key);
                      newObs.push(...generateChunk(x, z, seed));
                      hasNew = true;
                  }
              }
          }

          if (hasNew) {
              setObstacles(prev => [...prev, ...newObs]);
          }
      });
      return null;
  };

  const keys = useMemo(()=> [
      { name: 'fwd', keys: ['w', 'ArrowUp'] }, 
      { name: 'back', keys: ['s', 'ArrowDown'] }, 
      { name: 'left', keys: ['a', 'ArrowLeft'] }, 
      { name: 'right', keys: ['d', 'ArrowRight'] }
  ], []);

  return (
    <div className="w-full h-screen bg-black relative select-none">
        {gameState.isPlaying && (
            <div className="absolute inset-0 z-20 pointer-events-none p-4 flex flex-col justify-between">
                <div className="flex justify-between items-start">
                     <div className="text-white font-mono bg-black/40 p-2 rounded backdrop-blur-md">
                         <div className="text-2xl font-bold text-yellow-500">SCORE: {gameState.score}</div>
                         <div className="text-xl text-yellow-300">GOLD: ${gameState.gold}</div>
                     </div>
                     <div className="text-cyan-400 font-mono text-xs max-w-xs text-right bg-black/40 p-2 rounded">
                         {commentary || "MedievalGemini System Online."}
                     </div>
                </div>
                
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-white rounded-full shadow-[0_0_10px_white]" />
                
                <div id="shop-ui" className="absolute top-2/3 left-1/2 -translate-x-1/2 text-2xl font-black text-white drop-shadow-md text-center"></div>

                <div className="flex justify-between items-end">
                    <div className="w-48">
                        <div className="text-white text-xs mb-1">HEALTH</div>
                        <div className="h-4 bg-gray-700 rounded overflow-hidden">
                            <div className="h-full bg-red-500 transition-all" style={{width: `${gameState.health}%`}} />
                        </div>
                    </div>
                    <div className="text-right text-white">
                        <div className="text-4xl font-bold">{gameState.ammo} <span className="text-lg text-gray-400">/ ∞</span></div>
                        <div className="text-xs text-gray-400">AK-47 LVL {gameState.damageMultiplier}</div>
                    </div>
                </div>
            </div>
        )}

        {!gameState.isPlaying && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90">
                <div className="text-center">
                    <h1 className="text-6xl text-purple-500 font-black mb-4">MEDIEVAL GEMINI</h1>
                    <p className="text-gray-400 mb-8">Defend the timeline. Upgrade weapons. Survive.</p>
                    <button onClick={startGame} className="px-8 py-3 bg-white text-black font-bold text-xl hover:bg-gray-200 pointer-events-auto">
                        DEPLOY
                    </button>
                    {gameState.health <= 0 && gameState.score > 0 && <p className="mt-4 text-red-500 font-mono">MISSION FAILED</p>}
                </div>
            </div>
        )}

        {gameState.isPlaying && (
            <div className="absolute bottom-10 left-10 z-30 pointer-events-auto">
                <Joystick onMove={(x, y) => setJoystick({x, y})} />
            </div>
        )}

        <KeyboardControls map={keys}>
        <Canvas shadows camera={{ fov: 70 }}>
            <Suspense fallback={null}>
                <World obstacles={obstacles} playerPos={playerRef.current} seed={seed} />
                <WorldGen />
                {gameState.isPlaying && (
                    <>
                        <PointerLockControls makeDefault />
                        <GameController 
                            gameState={gameState} setGameState={setGameState}
                            joystickData={joystick} 
                            onShoot={(f) => setIsFiring(f)} 
                            enemiesRef={enemiesRef} playerRef={playerRef} obstacles={obstacles} seed={seed}
                        />
                        <Weapon isFiring={isFiring} isReloading={gameState.ammo === 0} />
                    </>
                )}
            </Suspense>
        </Canvas>
        </KeyboardControls>
    </div>
  );
}