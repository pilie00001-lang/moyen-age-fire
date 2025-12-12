import React, { useState, useEffect, useRef, Suspense, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls, Sky, Stars, Stats, Text, useKeyboardControls, KeyboardControls } from '@react-three/drei';
import * as THREE from 'three';
import { Vector3 as ThreeVector3, Raycaster } from 'three';
import { Enemy, EnemyType, GameState, WeaponState, Obstacle } from './types';
import { Joystick } from './components/Joystick';
import { generateBattleCommentary } from './services/gemini';

// --- Assets & Constants ---
const PLAYER_SPEED = 10;
const FIRE_RATE = 100; // ms
const ENEMY_SPAWN_RATE = 2000; // ms
const DAMAGE_PER_SHOT = 35;
const MAX_AMMO = 30;

// World Gen Constants
const CHUNK_SIZE = 60;
const CHUNK_RES = 30; // Vertex resolution per chunk (higher = smoother)
const RENDER_DISTANCE = 2; // Chunks radius (2 = 5x5 grid)

// Enemy Stats Config
const ENEMY_CONFIG: Record<EnemyType, { hp: number; speed: number; score: number; scale: number; color: string }> = {
  peasant: { hp: 40, speed: 7, score: 50, scale: 0.8, color: '#8B4513' }, // Fast, weak, brown
  knight: { hp: 100, speed: 4, score: 100, scale: 1.0, color: '#666666' }, // Balanced, grey
  heavy: { hp: 300, speed: 2.5, score: 300, scale: 1.4, color: '#2F4F4F' }, // Slow, tanky, dark slate
  villager: { hp: 30, speed: 5, score: -100, scale: 0.8, color: '#3b82f6' }, // Blue, harmless, penalty for killing
};

// --- Noise & Height Logic ---

// Simple Pseudo-Random Noise (Deterministic)
const noise = (x: number, z: number) => {
    const sin = Math.sin(x * 12.9898 + z * 78.233);
    const s = sin * 43758.5453123;
    return s - Math.floor(s);
}

// Smooth Noise (Interpolated)
const smoothNoise = (x: number, z: number) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const f = x - i;
    const g = z - j;
    
    // Corners
    const a = noise(i, j);
    const b = noise(i + 1, j);
    const c = noise(i, j + 1);
    const d = noise(i + 1, j + 1);
    
    // Quintic interpolation curve
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const v = g * g * g * (g * (g * 6 - 15) + 10);
    
    return (1 - u) * (1 - v) * a + 
           u * (1 - v) * b + 
           (1 - u) * v * c + 
           u * v * d;
}

// Fractal Brownian Motion for nice terrain
const getTerrainHeight = (x: number, z: number) => {
    let y = 0;
    let amp = 10;
    let freq = 0.02; // Scale: smaller = wider hills
    
    // 3 Octaves
    y += smoothNoise(x * freq, z * freq) * amp;
    y += smoothNoise(x * freq * 2, z * freq * 2) * (amp / 2);
    y += smoothNoise(x * freq * 4, z * freq * 4) * (amp / 4);
    
    // Add some "floor" so it's not too crazy
    return Math.pow(y, 1.2); 
};

// --- Helper: Seeded Random ---
const seededRandom = (seed: number) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
};

// --- Procedural Generation Logic (Chunk Based) ---
const generateChunk = (chunkX: number, chunkZ: number): Obstacle[] => {
  const obstacles: Obstacle[] = [];
  const chunkSeed = chunkX * 73856093 ^ chunkZ * 19349663; 
  const getRand = (offset: number) => seededRandom(chunkSeed + offset);

  const worldX = chunkX * CHUNK_SIZE;
  const worldZ = chunkZ * CHUNK_SIZE;

  // Village Logic (5% Chance per chunk)
  const isVillage = getRand(999) > 0.95;

  if (isVillage) {
      // Spawn a village cluster
      const houseCount = 4 + Math.floor(getRand(888) * 4);
      for(let i=0; i<houseCount; i++) {
          const lx = (getRand(i*30) - 0.5) * (CHUNK_SIZE * 0.6);
          const lz = (getRand(i*30+1) - 0.5) * (CHUNK_SIZE * 0.6);
          const wx = worldX + lx;
          const wz = worldZ + lz;
          const y = getTerrainHeight(wx, wz);

          obstacles.push({
              id: `${chunkX}:${chunkZ}:house:${i}`,
              type: 'house',
              position: { x: wx, y: y, z: wz },
              rotation: getRand(i * 30 + 2) * Math.PI * 2,
              scale: { x: 1, y: 1, z: 1 },
              radius: 2.5
          });
      }
      // Fewer trees in villages
  }

  // 1. Trees
  const treeCount = isVillage ? 2 : Math.floor(getRand(1) * 10) + 2; 
  for (let i = 0; i < treeCount; i++) {
      const lx = getRand(i * 10) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const lz = getRand(i * 10 + 1) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const wx = worldX + lx;
      const wz = worldZ + lz;
      const y = getTerrainHeight(wx, wz);

      // Simple collision check against houses if in village (rough)
      if (isVillage) {
          let tooClose = false;
          obstacles.forEach(o => {
              if (o.type === 'house') {
                  const dx = wx - o.position.x;
                  const dz = wz - o.position.z;
                  if (Math.sqrt(dx*dx+dz*dz) < 4) tooClose = true;
              }
          });
          if (tooClose) continue;
      }

      obstacles.push({
          id: `${chunkX}:${chunkZ}:tree:${i}`,
          type: 'tree',
          position: { x: wx, y: y, z: wz },
          rotation: getRand(i * 10 + 2) * Math.PI,
          scale: { x: 1 + getRand(i)*0.5, y: 1 + getRand(i+5), z: 1 + getRand(i)*0.5 },
          radius: 1
      });
  }

  // 2. Rocks
  const rockCount = Math.floor(getRand(2) * 5) + 2;
  for (let i = 0; i < rockCount; i++) {
      const lx = getRand(i * 20 + 50) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const lz = getRand(i * 20 + 51) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const wx = worldX + lx;
      const wz = worldZ + lz;
      const y = getTerrainHeight(wx, wz);

      obstacles.push({
          id: `${chunkX}:${chunkZ}:rock:${i}`,
          type: 'rock',
          position: { x: wx, y: y, z: wz },
          rotation: getRand(i * 20 + 52) * Math.PI,
          scale: { x: 1, y: 1, z: 1 },
          radius: 1.5
      });
  }

  // 3. Ruins (Very Rare, not in villages)
  if (!isVillage && getRand(100) > 0.85) {
      const lx = getRand(101) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const lz = getRand(102) * CHUNK_SIZE - (CHUNK_SIZE/2);
      const wx = worldX + lx;
      const wz = worldZ + lz;
      const y = getTerrainHeight(wx, wz);
      
      obstacles.push({
          id: `${chunkX}:${chunkZ}:ruin`,
          type: 'ruin',
          position: { x: wx, y: y, z: wz },
          rotation: getRand(103) * Math.PI,
          scale: { x: 1 + getRand(104), y: 1 + getRand(105), z: 1 + getRand(104) },
          radius: 3.5
      });
  }

  return obstacles;
};

// --- Environment Components ---

const TerrainChunk = React.memo(({ x, z }: { x: number, z: number }) => {
    // Generate geometry on mount
    const geometry = useMemo(() => {
        const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_RES, CHUNK_RES);
        geo.rotateX(-Math.PI / 2); // Rotate to XZ plane
        
        const pos = geo.attributes.position;
        const worldX = x * CHUNK_SIZE;
        const worldZ = z * CHUNK_SIZE;

        for (let i = 0; i < pos.count; i++) {
            const px = pos.getX(i) + worldX; // Local to World
            const pz = pos.getZ(i) + worldZ;
            const h = getTerrainHeight(px, pz);
            pos.setY(i, h);
        }
        
        geo.computeVertexNormals();
        return geo;
    }, [x, z]);

    return (
        <mesh 
            geometry={geometry} 
            position={[x * CHUNK_SIZE, 0, z * CHUNK_SIZE]} 
            receiveShadow
        >
             {/* Grass-like material */}
            <meshStandardMaterial color="#2d4c1e" roughness={0.8} />
        </mesh>
    );
});

const House: React.FC<{ data: Obstacle }> = React.memo(({ data }) => (
  <group position={[data.position.x, data.position.y, data.position.z]} rotation={[0, data.rotation, 0]} scale={[data.scale.x, data.scale.y, data.scale.z]}>
     {/* Base */}
     <mesh position={[0, 1, 0]} castShadow>
        <boxGeometry args={[2.5, 2, 2.5]} />
        <meshStandardMaterial color="#6d4c41" />
     </mesh>
     {/* Roof */}
     <mesh position={[0, 2.5, 0]} rotation={[0, Math.PI/4, 0]} castShadow>
        <coneGeometry args={[2.2, 1.5, 4]} />
        <meshStandardMaterial color="#3e2723" />
     </mesh>
     {/* Door */}
     <mesh position={[0, 0.8, 1.26]}>
         <planeGeometry args={[0.8, 1.4]} />
         <meshStandardMaterial color="#1a1a1a" />
     </mesh>
     {/* Window */}
     <mesh position={[0.8, 1.2, 1.26]}>
         <planeGeometry args={[0.5, 0.5]} />
         <meshStandardMaterial color="#87ceeb" emissive="#444" />
     </mesh>
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
    <mesh position={[0, 4.5, 0]} castShadow>
      <coneGeometry args={[1.2, 3, 8]} />
      <meshStandardMaterial color="#266626" />
    </mesh>
  </group>
));

const Rock: React.FC<{ data: Obstacle }> = React.memo(({ data }) => (
  <mesh 
    position={[data.position.x, data.position.y + 0.5 * data.scale.y, data.position.z]} 
    rotation={[data.rotation, data.rotation, data.rotation]} 
    scale={[data.scale.x, data.scale.y, data.scale.z]}
    castShadow
  >
    <dodecahedronGeometry args={[1.2, 0]} />
    <meshStandardMaterial color="#595959" roughness={0.9} />
  </mesh>
));

const Mountain: React.FC<{ data: Obstacle }> = React.memo(({ data }) => (
    // Deprecated for procedural terrain, but kept for legacy ID support if needed
  <mesh position={[data.position.x, data.position.y - 5, data.position.z]} rotation={[0, data.rotation, 0]} scale={[data.scale.x, data.scale.y, data.scale.z]}>
    <coneGeometry args={[1, 1, 4]} />
    <meshStandardMaterial color="#2d2d2d" roughness={1} />
  </mesh>
));

const Ruin: React.FC<{ data: Obstacle }> = React.memo(({ data }) => (
  <group position={[data.position.x, data.position.y, data.position.z]} rotation={[0, data.rotation, 0]} scale={[data.scale.x, data.scale.y, data.scale.z]}>
    <mesh position={[-1.5, 1, 0]} castShadow>
      <boxGeometry args={[1, 2, 3]} />
      <meshStandardMaterial color="#7a7a7a" />
    </mesh>
    <mesh position={[1.5, 0.5, 1]} castShadow>
      <boxGeometry args={[1, 1, 1.5]} />
      <meshStandardMaterial color="#7a7a7a" />
    </mesh>
    <mesh position={[1.5, 1.5, -1]} castShadow>
      <cylinderGeometry args={[0.3, 0.3, 3, 6]} />
      <meshStandardMaterial color="#8a8a8a" />
    </mesh>
  </group>
));


// --- Game Components ---

const Weapon = ({ isFiring, isReloading }: { isFiring: boolean; isReloading: boolean }) => {
  const group = useRef<THREE.Group>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.getElapsedTime();
    const swayX = Math.sin(t * 2) * 0.002;
    const swayY = Math.cos(t * 2) * 0.002;
    const recoilZ = isFiring ? 0.05 + Math.random() * 0.02 : 0;
    const recoilX = isFiring ? (Math.random() - 0.5) * 0.02 : 0;
    const reloadRot = isReloading ? -Math.PI / 4 : 0;
    const reloadPos = isReloading ? -0.2 : 0;

    group.current.position.set(0.3 + swayX, -0.25 + swayY + reloadPos, -0.5 + recoilZ);
    group.current.rotation.set(recoilX, reloadRot, 0);

    if (flashRef.current) {
        flashRef.current.visible = isFiring && Math.random() > 0.5;
        flashRef.current.rotation.z = Math.random() * Math.PI;
    }
  });

  return (
    <group ref={group}>
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.08, 0.1, 0.6]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.7} />
      </mesh>
      <mesh position={[0, -0.05, 0.2]}>
        <boxGeometry args={[0.08, 0.15, 0.3]} />
        <meshStandardMaterial color="#8B4513" />
      </mesh>
      <mesh position={[0, 0.02, -0.4]}>
        <cylinderGeometry args={[0.015, 0.02, 0.4]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0, -0.15, -0.1]} rotation={[0.2, 0, 0]}>
        <boxGeometry args={[0.06, 0.25, 0.1]} />
        <meshStandardMaterial color="#8B4513" />
      </mesh>
      <mesh ref={flashRef} position={[0, 0.02, -0.65]} visible={false}>
        <planeGeometry args={[0.3, 0.3]} />
        <meshBasicMaterial color="#FFDD00" transparent opacity={0.8} />
      </mesh>
    </group>
  );
};

const EnemyMesh: React.FC<{ position: ThreeVector3; hp: number; maxHp: number; type: EnemyType }> = ({ position, hp, maxHp, type }) => {
  const mesh = useRef<THREE.Group>(null);
  const config = ENEMY_CONFIG[type];
  
  useFrame((state) => {
    if (!mesh.current) return;
    const bobSpeed = type === 'peasant' || type === 'villager' ? 15 : type === 'heavy' ? 5 : 10;
    const terrainH = getTerrainHeight(position.x, position.z);
    mesh.current.position.y = terrainH + (0.75 * config.scale) + Math.sin(state.clock.getElapsedTime() * bobSpeed + position.x) * 0.1;
  });

  const hpPercent = hp / maxHp;
  const hpColor = hpPercent > 0.5 ? 'green' : hpPercent > 0.2 ? 'orange' : 'red';
  const isVillager = type === 'villager';

  return (
    <group ref={mesh} position={[position.x, position.y, position.z]} scale={[config.scale, config.scale, config.scale]}>
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.6, 1.5, 0.4]} />
        <meshStandardMaterial color={config.color} roughness={0.9} />
      </mesh>
      
      {/* Head */}
      <mesh position={[0, 0.9, 0]}>
        <sphereGeometry args={[0.25]} />
        <meshStandardMaterial 
          color={type === 'peasant' ? '#d2b48c' : isVillager ? '#f1c27d' : '#888'} 
          metallic={!isVillager && type !== 'peasant'} 
          roughness={type === 'peasant' || isVillager ? 1 : 0.2} 
        />
      </mesh>
      
      {/* Villager Hat */}
      {isVillager && (
          <mesh position={[0, 1.1, 0]}>
              <cylinderGeometry args={[0.3, 0.3, 0.05]} />
              <meshStandardMaterial color="#8B4513" />
          </mesh>
      )}

      {type === 'heavy' && (
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[0.9, 0.5, 0.6]} />
          <meshStandardMaterial color="#1a1a1a" metallic />
        </mesh>
      )}

      {/* Arms/Weapon */}
      {!isVillager && (
        <group position={[0.4, 0.2, 0.2]} rotation={[1, 0, 0]}>
            <mesh>
                <boxGeometry args={[0.1, 0.5, 0.1]} />
                <meshStandardMaterial color={config.color} />
            </mesh>
            
            {type === 'peasant' ? (
            <group position={[0, 0.6, 0]}>
                <mesh position={[0, 0, 0]}>
                    <cylinderGeometry args={[0.02, 0.02, 1.5]} />
                    <meshStandardMaterial color="#5C4033" />
                </mesh>
                <mesh position={[0, 0.75, 0]} rotation={[0,0,1.57]}>
                    <cylinderGeometry args={[0.02, 0.02, 0.3]} />
                    <meshStandardMaterial color="#888" />
                </mesh>
            </group>
            ) : type === 'heavy' ? (
            <group position={[0, 0.8, 0]}>
                <mesh>
                    <boxGeometry args={[0.1, 1.8, 0.05]} />
                    <meshStandardMaterial color="#ccc" metallic roughness={0.1} />
                </mesh>
                <mesh position={[0, -0.6, 0]}>
                    <boxGeometry args={[0.4, 0.1, 0.1]} />
                    <meshStandardMaterial color="#222" />
                </mesh>
            </group>
            ) : (
            <mesh position={[0, 0.5, 0]}>
                <boxGeometry args={[0.05, 1.2, 0.02]} />
                <meshStandardMaterial color="#eee" metallic roughness={0.1} />
            </mesh>
            )}
        </group>
      )}

      <mesh position={[0, 1.4, 0]}>
         <planeGeometry args={[1 * hpPercent, 0.1]} />
         <meshBasicMaterial color={hpColor} />
      </mesh>
    </group>
  );
};

const Tracers = ({ tracers }: { tracers: { start: ThreeVector3; end: ThreeVector3; id: number }[] }) => {
    return (
        <group>
            {tracers.map(t => (
                <mesh key={t.id} position={t.start.clone().lerp(t.end, 0.5)} lookAt={() => t.end}>
                    <boxGeometry args={[0.02, 0.02, t.start.distanceTo(t.end)]} />
                    <meshBasicMaterial color="yellow" transparent opacity={0.6} />
                </mesh>
            ))}
        </group>
    )
}

// Manages the visible terrain patches
const World = ({ obstacles, playerPos }: { obstacles: Obstacle[], playerPos: THREE.Vector3 }) => {
    const cx = Math.floor(playerPos.x / CHUNK_SIZE);
    const cz = Math.floor(playerPos.z / CHUNK_SIZE);
    
    // Calculate visible chunk coordinates
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
      <Sky sunPosition={[100, 20, 100]} />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 50, 10]} intensity={1} castShadow />
      
      {/* Dynamic Terrain */}
      {visibleChunks.map(chunk => (
          <TerrainChunk key={chunk.key} x={chunk.x} z={chunk.z} />
      ))}
      
      {/* Obstacles */}
      {obstacles.map(obs => {
        switch(obs.type) {
          case 'tree': return <Tree key={obs.id} data={obs} />;
          case 'rock': return <Rock key={obs.id} data={obs} />;
          case 'ruin': return <Ruin key={obs.id} data={obs} />;
          case 'mountain': return <Mountain key={obs.id} data={obs} />;
          case 'house': return <House key={obs.id} data={obs} />;
          default: return null;
        }
      })}
    </>
  );
};

// Collision Helper
const checkCollision = (position: THREE.Vector3, obstacles: Obstacle[], radius: number): boolean => {
  for (const obs of obstacles) {
    const dx = position.x - obs.position.x;
    const dz = position.z - obs.position.z;
    
    if (Math.abs(dx) > 20 || Math.abs(dz) > 20) continue;

    const distSq = dx * dx + dz * dz;
    const minDist = obs.radius + radius;
    if (distSq < minDist * minDist) {
      return true;
    }
  }
  return false;
};

// --- World Generator System ---
// Monitors player position and updates the global obstacles list
const WorldGenerator = ({ 
    playerRef, 
    setObstacles 
}: { 
    playerRef: React.MutableRefObject<THREE.Vector3>, 
    setObstacles: React.Dispatch<React.SetStateAction<Obstacle[]>> 
}) => {
    const loadedChunks = useRef<Set<string>>(new Set());
    const lastChunk = useRef<{x: number, z: number} | null>(null);

    useFrame(() => {
        const px = playerRef.current.x;
        const pz = playerRef.current.z;
        const chunkX = Math.floor(px / CHUNK_SIZE);
        const chunkZ = Math.floor(pz / CHUNK_SIZE);

        if (!lastChunk.current || lastChunk.current.x !== chunkX || lastChunk.current.z !== chunkZ) {
            lastChunk.current = { x: chunkX, z: chunkZ };
            
            const newObstacles: Obstacle[] = [];
            const activeKeys = new Set<string>();

            for (let x = chunkX - RENDER_DISTANCE; x <= chunkX + RENDER_DISTANCE; x++) {
                for (let z = chunkZ - RENDER_DISTANCE; z <= chunkZ + RENDER_DISTANCE; z++) {
                    const key = `${x}:${z}`;
                    activeKeys.add(key);
                    
                    if (!loadedChunks.current.has(key)) {
                        loadedChunks.current.add(key);
                        newObstacles.push(...generateChunk(x, z));
                    }
                }
            }
            
            if (newObstacles.length > 0) {
                setObstacles(prev => {
                    const filtered = prev.filter(obs => {
                        const parts = obs.id.split(':');
                        const cx = parseInt(parts[0]);
                        const cz = parseInt(parts[1]);
                        return Math.abs(cx - chunkX) <= RENDER_DISTANCE + 1 && Math.abs(cz - chunkZ) <= RENDER_DISTANCE + 1;
                    });
                    
                    const currentLoaded = new Set<string>();
                    filtered.forEach(obs => {
                         const parts = obs.id.split(':');
                         currentLoaded.add(`${parts[0]}:${parts[1]}`);
                    });
                    loadedChunks.current = currentLoaded;
                    activeKeys.forEach(k => loadedChunks.current.add(k));

                    return [...filtered, ...newObstacles];
                });
            }
        }
    });

    return null;
}

const GameController = ({ 
    onScore, 
    onDamage, 
    joystickData, 
    setAmmo, 
    onShoot,
    enemiesRef,
    playerRef,
    obstacles
}: { 
    onScore: (pts: number) => void, 
    onDamage: (dmg: number) => void, 
    joystickData: {x: number, y: number},
    setAmmo: (ammo: number) => void,
    onShoot: (fired: boolean) => void,
    enemiesRef: React.MutableRefObject<Enemy[]>,
    playerRef: React.MutableRefObject<THREE.Vector3>,
    obstacles: Obstacle[]
}) => {
  const { camera } = useThree();
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [tracers, setTracers] = useState<{ start: ThreeVector3; end: ThreeVector3; id: number }[]>([]);
  
  const lastShotTime = useRef(0);
  const lastSpawnTime = useRef(0);
  const isMouseDown = useRef(false);
  const ammoRef = useRef(MAX_AMMO);
  const isReloading = useRef(false);
  
  useEffect(() => {
    enemiesRef.current = enemies;
  }, [enemies]);

  useEffect(() => {
    const onDown = () => { isMouseDown.current = true; };
    const onUp = () => { isMouseDown.current = false; };
    const onReload = (e: KeyboardEvent) => {
        if(e.key.toLowerCase() === 'r' && ammoRef.current < MAX_AMMO && !isReloading.current) {
            reload();
        }
    }
    
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onReload);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onReload);
    };
  }, []);

  const reload = () => {
    isReloading.current = true;
    onShoot(false); 
    setTimeout(() => {
        ammoRef.current = MAX_AMMO;
        setAmmo(MAX_AMMO);
        isReloading.current = false;
    }, 1500);
  }

  useFrame((state, delta) => {
    const time = state.clock.getElapsedTime() * 1000;
    const playerPos = camera.position;
    playerRef.current.copy(playerPos);

    // --- Movement (Joystick) ---
    const speed = PLAYER_SPEED * delta;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    
    forward.y = 0; forward.normalize();
    right.y = 0; right.normalize();
    
    if (joystickData.x !== 0 || joystickData.y !== 0) {
        const moveVec = new THREE.Vector3()
           .add(right.clone().multiplyScalar(joystickData.x * speed))
           .add(forward.clone().multiplyScalar(-joystickData.y * speed));
        
        const nextPos = camera.position.clone().add(moveVec);
        if (!checkCollision(nextPos, obstacles, 0.5)) {
            camera.position.x = nextPos.x;
            camera.position.z = nextPos.z;
        }
    }

    // --- SNAP TO TERRAIN ---
    // Important: Keep player above ground
    const groundH = getTerrainHeight(camera.position.x, camera.position.z);
    // Smooth transition or hard snap? Hard snap for walking.
    camera.position.y = groundH + 1.7; 

    // --- Shooting ---
    if (isMouseDown.current && !isReloading.current && time - lastShotTime.current > FIRE_RATE) {
      if (ammoRef.current > 0) {
        lastShotTime.current = time;
        ammoRef.current--;
        setAmmo(ammoRef.current);
        onShoot(true);
        
        const raycaster = new Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        
        const start = new THREE.Vector3(0.2, -0.2, -0.5).applyQuaternion(camera.quaternion).add(camera.position);
        const end = raycaster.ray.at(50, new THREE.Vector3()); 
        
        let hitDist = 50;
        let hitId: string | null = null;
        
        setEnemies(prev => {
            let hitTypeScore = 0;
            const updatedEnemies = prev.map(e => {
                const config = ENEMY_CONFIG[e.type];
                // Hitbox slightly higher than origin
                const ePos = new THREE.Vector3(e.position.x, e.position.y + (0.75 * config.scale), e.position.z);
                const distToRay = raycaster.ray.distanceSqToPoint(ePos);
                
                if (distToRay < (0.5 * config.scale) && e.hp > 0) {
                   const dist = camera.position.distanceTo(ePos);
                   if (dist < hitDist) {
                       hitDist = dist;
                       hitId = e.id;
                       end.copy(ePos);
                   }
                }
                return e;
            }).map(e => {
                if (e.id === hitId) {
                    const newHp = e.hp - DAMAGE_PER_SHOT;
                    if (newHp <= 0) hitTypeScore = ENEMY_CONFIG[e.type].score;
                    return { ...e, hp: newHp };
                }
                return e;
            }).filter(e => e.hp > 0);
            
            if (hitTypeScore > 0) onScore(hitTypeScore);
            return updatedEnemies;
        });

        const tracerId = Math.random();
        setTracers(prev => [...prev, { start, end, id: tracerId }]);
        setTimeout(() => setTracers(prev => prev.filter(t => t.id !== tracerId)), 100);

      } else {
        onShoot(false); 
        if (ammoRef.current === 0) reload();
      }
    } else if (!isMouseDown.current) {
        onShoot(false);
    }

    // --- Enemy/Villager Spawning ---
    if (time - lastSpawnTime.current > ENEMY_SPAWN_RATE) {
      lastSpawnTime.current = time;
      const angle = Math.random() * Math.PI * 2;
      const dist = 30 + Math.random() * 20;
      const spawnX = camera.position.x + Math.cos(angle) * dist;
      const spawnZ = camera.position.z + Math.sin(angle) * dist;
      const spawnY = getTerrainHeight(spawnX, spawnZ);
      
      const rand = Math.random();
      let type: EnemyType = 'knight';
      // 20% Villager, 30% Peasant, 40% Knight, 10% Heavy
      if (rand < 0.2) type = 'villager';
      else if (rand < 0.5) type = 'peasant';
      else if (rand > 0.9) type = 'heavy';

      const config = ENEMY_CONFIG[type];

      setEnemies(prev => [
          ...prev, 
          { 
              id: Math.random().toString(), 
              type: type,
              position: { x: spawnX, y: spawnY, z: spawnZ }, 
              hp: config.hp,
              maxHp: config.hp,
              speed: config.speed + (Math.random() - 0.5), 
              isAttacking: false 
          }
      ]);
    }

    // --- Enemy Logic (Move & Attack) ---
    setEnemies(prev => {
        let takingDamage = false;
        
        const next = prev.map(e => {
            const eVec = new THREE.Vector3(e.position.x, 0, e.position.z);
            const pVec = new THREE.Vector3(camera.position.x, 0, camera.position.z);
            const dist = eVec.distanceTo(pVec);
            
            // Villager AI: Passive / Flee
            if (e.type === 'villager') {
                if (dist < 10) {
                   // Flee from player
                   const dir = eVec.sub(pVec).normalize();
                   const moveVec = dir.multiplyScalar(e.speed * delta);
                   const nextPos = new THREE.Vector3(e.position.x, 0, e.position.z).add(moveVec);
                   
                   if (!checkCollision(nextPos, obstacles, 0.5)) {
                        return { ...e, position: { x: nextPos.x, y: 0, z: nextPos.z }, isAttacking: false };
                   }
                } else {
                   // Wander randomly (simple jitter)
                   if (Math.random() < 0.05) {
                       const angle = Math.random() * Math.PI * 2;
                       const moveVec = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(e.speed * delta * 0.5);
                        const nextPos = new THREE.Vector3(e.position.x, 0, e.position.z).add(moveVec);
                        if (!checkCollision(nextPos, obstacles, 0.5)) {
                             return { ...e, position: { x: nextPos.x, y: 0, z: nextPos.z }, isAttacking: false };
                        }
                   }
                }
                return { ...e, isAttacking: false };
            }

            // Aggressive Enemy AI
            const config = ENEMY_CONFIG[e.type];
            const attackRange = 1.5 * config.scale;

            if (dist > attackRange) {
                const dir = pVec.sub(eVec).normalize();
                const moveVec = dir.multiplyScalar(e.speed * delta);
                const nextPos = eVec.clone().add(moveVec);

                if (!checkCollision(nextPos, obstacles, 0.5)) {
                    // Update Y later in render loop, just update XZ here
                    return { ...e, position: { x: nextPos.x, y: 0, z: nextPos.z }, isAttacking: false };
                }
                return { ...e, isAttacking: false };
            } else {
                takingDamage = true;
                return { ...e, isAttacking: true };
            }
        });

        if (takingDamage) {
            onDamage(0.5); 
        }
        
        return next;
    });

  });

  return (
    <>
      {enemies.map(e => (
        <EnemyMesh 
            key={e.id} 
            position={new THREE.Vector3(e.position.x, e.position.y, e.position.z)} 
            hp={e.hp} 
            maxHp={e.maxHp}
            type={e.type}
        />
      ))}
      <Tracers tracers={tracers} />
    </>
  );
};

// Keyboard Mover Hook with Collision
function KeyboardMover({ obstacles }: { obstacles: Obstacle[] }) {
  const [, get] = useKeyboardControls()
  const { camera } = useThree()
  
  useFrame((state, delta) => {
    const { forward, backward, left, right } = get()
    const speed = PLAYER_SPEED * delta
    
    const vec = new THREE.Vector3()
    const frontVec = new THREE.Vector3(0, 0, 0)
    const sideVec = new THREE.Vector3(0, 0, 0)
    const direction = new THREE.Vector3()

    frontVec.set(0, 0, Number(backward) - Number(forward))
    sideVec.set(Number(left) - Number(right), 0, 0)

    direction.subVectors(frontVec, sideVec).normalize().multiplyScalar(speed).applyEuler(camera.rotation)
    
    const nextPos = camera.position.clone().add(new THREE.Vector3(direction.x, 0, direction.z));
    
    if (!checkCollision(nextPos, obstacles, 0.5)) {
        camera.position.x = nextPos.x;
        camera.position.z = nextPos.z;
    }
  })
  return null
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>({
    score: 0,
    health: 100,
    wave: 1,
    isPlaying: false,
    ammo: MAX_AMMO
  });
  
  const [commentary, setCommentary] = useState("Chronos AK-47 Loaded. Press Start.");
  const [isFiring, setIsFiring] = useState(false);
  const [joystickData, setJoystickData] = useState({ x: 0, y: 0 });
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);

  // Refs
  const enemiesRef = useRef<Enemy[]>([]);
  const playerRef = useRef(new THREE.Vector3(0,0,0));

  useEffect(() => {
    if (!gameState.isPlaying) return;
    generateBattleCommentary('intro', 0, 1).then(setCommentary);
  }, [gameState.isPlaying]);

  useEffect(() => {
      if (gameState.score > 0 && gameState.score % 500 === 0) {
          generateBattleCommentary('killstreak', gameState.score, gameState.wave).then(setCommentary);
      }
  }, [gameState.score]);

  useEffect(() => {
      if (gameState.health < 30 && gameState.health > 0) {
          generateBattleCommentary('low_health', gameState.score, gameState.wave).then(setCommentary);
      }
  }, [gameState.health < 30]);

  const handleStart = () => {
    setGameState(prev => ({ ...prev, isPlaying: true, health: 100, score: 0 }));
  };

  const handleScore = (points: number) => {
      setGameState(prev => ({ ...prev, score: prev.score + points }));
  };

  const handleDamage = (amount: number) => {
      setGameState(prev => {
          const newHp = Math.max(0, prev.health - amount);
          if (newHp === 0) return { ...prev, isPlaying: false }; 
          return { ...prev, health: newHp };
      });
  };

  const handleJoystick = (x: number, y: number) => {
      setJoystickData({ x, y });
  };

  const onShoot = (firing: boolean) => {
      setIsFiring(firing);
  }

  const map = useMemo(()=>[
    { name: 'forward', keys: ['ArrowUp', 'w', 'W'] },
    { name: 'backward', keys: ['ArrowDown', 's', 'S'] },
    { name: 'left', keys: ['ArrowLeft', 'a', 'A'] },
    { name: 'right', keys: ['ArrowRight', 'd', 'D'] },
    { name: 'reload', keys: ['r', 'R']}
  ], [])

  return (
    <div className="w-full h-screen bg-black relative overflow-hidden">
        {/* --- UI OVERLAYS --- */}
        {gameState.isPlaying && <div className="crosshair border-2 border-white rounded-full bg-white/30 backdrop-blur-sm z-10" />}
        
        {/* HUD */}
        {gameState.isPlaying && (
            <div className="absolute inset-0 pointer-events-none z-20 p-4 md:p-8 flex flex-col justify-between">
                <div className="flex justify-between items-start">
                    <div className="bg-black/50 p-4 rounded-lg text-white font-mono backdrop-blur">
                        <div className="text-2xl font-bold text-yellow-400">SCORE: {gameState.score}</div>
                        <div className="text-sm text-gray-300">WAVE: {gameState.wave}</div>
                    </div>
                    <div className="bg-blue-900/60 p-4 rounded-lg text-cyan-200 font-mono max-w-md backdrop-blur border-l-4 border-cyan-500">
                        <div className="text-xs uppercase tracking-widest mb-1 opacity-70">Battle AI Log</div>
                        <p className="text-sm md:text-base italic">"{commentary}"</p>
                    </div>
                </div>

                <div className="flex justify-between items-end">
                    <div className="bg-black/50 p-4 rounded-lg backdrop-blur">
                        <div className="text-sm text-gray-400 mb-1">HEALTH</div>
                        <div className="w-48 h-6 bg-gray-800 rounded overflow-hidden border border-gray-600">
                            <div 
                                className={`h-full transition-all duration-300 ${gameState.health > 50 ? 'bg-green-500' : 'bg-red-500'}`} 
                                style={{ width: `${gameState.health}%` }} 
                            />
                        </div>
                    </div>
                    
                    <div className="bg-black/50 p-4 rounded-lg backdrop-blur text-right">
                        <div className="text-4xl font-black text-white">{gameState.ammo} <span className="text-lg font-normal text-gray-400">/ {MAX_AMMO}</span></div>
                        <div className="text-xs text-gray-400">AK-47 [AUTO]</div>
                    </div>
                </div>
            </div>
        )}

        {/* Joystick */}
        {gameState.isPlaying && (
            <div className="absolute inset-0 z-30 pointer-events-none">
                 <div className="pointer-events-auto w-full h-full relative">
                    <Joystick onMove={handleJoystick} />
                 </div>
            </div>
        )}

        {/* Menu Screen */}
        {!gameState.isPlaying && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
                <div className="text-center text-white max-w-lg p-6">
                    <h1 className="text-6xl font-black mb-4 bg-gradient-to-r from-red-600 to-yellow-500 text-transparent bg-clip-text">CHRONOS AK-47</h1>
                    <p className="mb-8 text-xl text-gray-300">Medieval Siege Simulation</p>
                    
                    <div className="mb-8 text-left bg-gray-900 p-6 rounded border border-gray-700">
                        <p className="mb-2"><span className="text-yellow-400 font-bold">PC:</span> WASD to Move, Mouse to Look/Shoot, R to Reload.</p>
                        <p className="mb-2"><span className="text-yellow-400 font-bold">Mobile:</span> Left Joystick to Move, Drag Right side to Look, Tap Right to Shoot.</p>
                    </div>
                    
                    <button 
                        onClick={handleStart}
                        className="px-12 py-4 bg-red-600 hover:bg-red-700 text-white font-bold text-2xl rounded shadow-[0_0_20px_rgba(220,38,38,0.5)] transition-all transform hover:scale-105"
                    >
                        {gameState.health <= 0 && gameState.score > 0 ? "TRY AGAIN" : "START MISSION"}
                    </button>
                    {gameState.health <= 0 && gameState.score > 0 && (
                         <p className="mt-4 text-red-500 font-mono">MISSION FAILED. FINAL SCORE: {gameState.score}</p>
                    )}
                </div>
            </div>
        )}

        {/* 3D Scene */}
        <KeyboardControls map={map}>
            <Canvas shadows camera={{ fov: 75, position: [0, 5, 0] }}>
                <Suspense fallback={null}>
                    {/* Pass player pos to World to render correct chunks */}
                    <World obstacles={obstacles} playerPos={playerRef.current} />
                    <WorldGenerator playerRef={playerRef} setObstacles={setObstacles} />
                    {gameState.isPlaying && (
                        <>
                            <PointerLockControls selector="#root" /> 
                            <KeyboardMover obstacles={obstacles} />
                            <GameController 
                                onScore={handleScore}
                                onDamage={handleDamage}
                                joystickData={joystickData}
                                setAmmo={(a) => setGameState(prev => ({...prev, ammo: a}))}
                                onShoot={onShoot}
                                enemiesRef={enemiesRef}
                                playerRef={playerRef}
                                obstacles={obstacles}
                            />
                            <WeaponRig isFiring={isFiring} isReloading={gameState.ammo === 0 && isFiring} />
                        </>
                    )}
                </Suspense>
            </Canvas>
        </KeyboardControls>
    </div>
  );
}

const WeaponRig = ({ isFiring, isReloading }: { isFiring: boolean, isReloading: boolean }) => {
    const { camera } = useThree();
    const ref = useRef<THREE.Group>(null);
    
    useFrame(() => {
        if (!ref.current) return;
        ref.current.position.copy(camera.position);
        ref.current.quaternion.copy(camera.quaternion);
    });

    return (
        <group ref={ref}>
            <Weapon isFiring={isFiring} isReloading={isReloading} />
        </group>
    )
}