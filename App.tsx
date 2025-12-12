import React, { useState, useEffect, useRef, Suspense, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls, Sky, Stars, Stats, Text, useKeyboardControls, KeyboardControls } from '@react-three/drei';
import * as THREE from 'three';
import { Vector3 as ThreeVector3, Raycaster } from 'three';
import { Enemy, EnemyType, GameState, WeaponState } from './types';
import { Joystick } from './components/Joystick';
import { generateBattleCommentary } from './services/gemini';

// --- Assets & Constants ---
const PLAYER_SPEED = 10;
const FIRE_RATE = 100; // ms
const ENEMY_SPAWN_RATE = 2000; // ms
const DAMAGE_PER_SHOT = 35;
const MAX_AMMO = 30;

// Enemy Stats Config
const ENEMY_CONFIG: Record<EnemyType, { hp: number; speed: number; score: number; scale: number; color: string }> = {
  peasant: { hp: 40, speed: 7, score: 50, scale: 0.8, color: '#8B4513' }, // Fast, weak, brown
  knight: { hp: 100, speed: 4, score: 100, scale: 1.0, color: '#666666' }, // Balanced, grey
  heavy: { hp: 300, speed: 2.5, score: 300, scale: 1.4, color: '#2F4F4F' }, // Slow, tanky, dark slate
};

// --- Components ---

// 1. The Weapon (AK-47 Style)
const Weapon = ({ isFiring, isReloading }: { isFiring: boolean; isReloading: boolean }) => {
  const group = useRef<THREE.Group>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const { camera } = useThree();

  useFrame((state) => {
    if (!group.current) return;
    
    // Sway
    const t = state.clock.getElapsedTime();
    const swayX = Math.sin(t * 2) * 0.002;
    const swayY = Math.cos(t * 2) * 0.002;
    
    // Recoil
    const recoilZ = isFiring ? 0.05 + Math.random() * 0.02 : 0;
    const recoilX = isFiring ? (Math.random() - 0.5) * 0.02 : 0;
    
    // Reload animation
    const reloadRot = isReloading ? -Math.PI / 4 : 0;
    const reloadPos = isReloading ? -0.2 : 0;

    group.current.position.set(0.3 + swayX, -0.25 + swayY + reloadPos, -0.5 + recoilZ);
    group.current.rotation.set(recoilX, reloadRot, 0);

    // Muzzle Flash
    if (flashRef.current) {
        flashRef.current.visible = isFiring && Math.random() > 0.5;
        flashRef.current.rotation.z = Math.random() * Math.PI;
    }
  });

  return (
    <group ref={group}>
      {/* Body */}
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.08, 0.1, 0.6]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.7} />
      </mesh>
      {/* Wood Stock */}
      <mesh position={[0, -0.05, 0.2]}>
        <boxGeometry args={[0.08, 0.15, 0.3]} />
        <meshStandardMaterial color="#8B4513" />
      </mesh>
      {/* Barrel */}
      <mesh position={[0, 0.02, -0.4]}>
        <cylinderGeometry args={[0.015, 0.02, 0.4]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      {/* Magazine */}
      <mesh position={[0, -0.15, -0.1]} rotation={[0.2, 0, 0]}>
        <boxGeometry args={[0.06, 0.25, 0.1]} />
        <meshStandardMaterial color="#8B4513" />
      </mesh>
      {/* Muzzle Flash */}
      <mesh ref={flashRef} position={[0, 0.02, -0.65]} visible={false}>
        <planeGeometry args={[0.3, 0.3]} />
        <meshBasicMaterial color="#FFDD00" transparent opacity={0.8} />
      </mesh>
    </group>
  );
};

// 2. Enemy Mesh (Varied Types)
const EnemyMesh: React.FC<{ position: ThreeVector3; hp: number; maxHp: number; type: EnemyType }> = ({ position, hp, maxHp, type }) => {
  const mesh = useRef<THREE.Group>(null);
  const config = ENEMY_CONFIG[type];
  
  useFrame((state) => {
    if (!mesh.current) return;
    // Simple bobbing - heavier enemies bob slower
    const bobSpeed = type === 'peasant' ? 15 : type === 'heavy' ? 5 : 10;
    mesh.current.position.y = (0.75 * config.scale) + Math.sin(state.clock.getElapsedTime() * bobSpeed + position.x) * 0.1;
  });

  // Health bar color
  const hpPercent = hp / maxHp;
  const hpColor = hpPercent > 0.5 ? 'green' : hpPercent > 0.2 ? 'orange' : 'red';

  return (
    <group ref={mesh} position={position} scale={[config.scale, config.scale, config.scale]}>
      {/* Body */}
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.6, 1.5, 0.4]} />
        <meshStandardMaterial color={config.color} roughness={0.9} />
      </mesh>
      
      {/* Head */}
      <mesh position={[0, 0.9, 0]}>
        <sphereGeometry args={[0.25]} />
        <meshStandardMaterial 
          color={type === 'peasant' ? '#d2b48c' : '#888'} 
          metallic={type !== 'peasant'} 
          roughness={type === 'peasant' ? 1 : 0.2} 
        />
      </mesh>

      {/* Heavy Details (Shoulder Pads / Bulk) */}
      {type === 'heavy' && (
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[0.9, 0.5, 0.6]} />
          <meshStandardMaterial color="#1a1a1a" metallic />
        </mesh>
      )}

      {/* Weapon Arm */}
      <group position={[0.4, 0.2, 0.2]} rotation={[1, 0, 0]}>
        <mesh>
            <boxGeometry args={[0.1, 0.5, 0.1]} />
            <meshStandardMaterial color={config.color} />
        </mesh>
        
        {/* Weapon Visuals */}
        {type === 'peasant' ? (
          // Pitchfork
          <group position={[0, 0.6, 0]}>
             <mesh position={[0, 0, 0]}>
                <cylinderGeometry args={[0.02, 0.02, 1.5]} />
                <meshStandardMaterial color="#5C4033" />
             </mesh>
             <mesh position={[0, 0.75, 0]} rotation={[0,0,1.57]}>
                 <cylinderGeometry args={[0.02, 0.02, 0.3]} />
                 <meshStandardMaterial color="#888" />
             </mesh>
             <mesh position={[-0.1, 0.9, 0]}>
                 <cylinderGeometry args={[0.01, 0.01, 0.4]} />
                 <meshStandardMaterial color="#888" />
             </mesh>
             <mesh position={[0, 0.9, 0]}>
                 <cylinderGeometry args={[0.01, 0.01, 0.4]} />
                 <meshStandardMaterial color="#888" />
             </mesh>
             <mesh position={[0.1, 0.9, 0]}>
                 <cylinderGeometry args={[0.01, 0.01, 0.4]} />
                 <meshStandardMaterial color="#888" />
             </mesh>
          </group>
        ) : type === 'heavy' ? (
          // Greatsword
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
          // Standard Sword
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[0.05, 1.2, 0.02]} />
            <meshStandardMaterial color="#eee" metallic roughness={0.1} />
          </mesh>
        )}
      </group>

      {/* HP Bar */}
      <mesh position={[0, 1.4, 0]}>
         <planeGeometry args={[1 * hpPercent, 0.1]} />
         <meshBasicMaterial color={hpColor} />
      </mesh>
    </group>
  );
};

// 3. Bullets / Tracers
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

// 4. Ground & Environment
const World = () => {
  return (
    <>
      <Sky sunPosition={[100, 20, 100]} />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} intensity={1} castShadow />
      
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[1000, 1000]} />
        <meshStandardMaterial color="#2d4c1e" />
      </mesh>
      
      {/* Grids for reference */}
      <gridHelper args={[1000, 100]} position={[0, 0.01, 0]} />
    </>
  );
};

// 5. Game Logic Controller
const GameController = ({ 
    onScore, 
    onDamage, 
    joystickData, 
    setAmmo, 
    onShoot,
    enemiesRef,
    playerRef
}: { 
    onScore: (pts: number) => void, 
    onDamage: (dmg: number) => void, 
    joystickData: {x: number, y: number},
    setAmmo: (ammo: number) => void,
    onShoot: (fired: boolean) => void,
    enemiesRef: React.MutableRefObject<Enemy[]>,
    playerRef: React.MutableRefObject<THREE.Vector3>
}) => {
  const { camera } = useThree();
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [tracers, setTracers] = useState<{ start: ThreeVector3; end: ThreeVector3; id: number }[]>([]);
  
  // Game State Refs
  const lastShotTime = useRef(0);
  const lastSpawnTime = useRef(0);
  const isMouseDown = useRef(false);
  const ammoRef = useRef(MAX_AMMO);
  const isReloading = useRef(false);
  
  useEffect(() => {
    enemiesRef.current = enemies;
  }, [enemies]);

  // Input Handling
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
    onShoot(false); // Stop firing anim
    // Update UI state handled by weapon component visually
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

    // --- Movement (Keyboard + Joystick) ---
    const speed = PLAYER_SPEED * delta;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    
    // Flatten vectors to run on ground
    forward.y = 0; forward.normalize();
    right.y = 0; right.normalize();
    
    // Joystick Input
    if (joystickData.x !== 0 || joystickData.y !== 0) {
        camera.position.add(right.clone().multiplyScalar(joystickData.x * speed));
        camera.position.add(forward.clone().multiplyScalar(-joystickData.y * speed));
    }

    // --- Shooting ---
    if (isMouseDown.current && !isReloading.current && time - lastShotTime.current > FIRE_RATE) {
      if (ammoRef.current > 0) {
        lastShotTime.current = time;
        ammoRef.current--;
        setAmmo(ammoRef.current);
        onShoot(true);
        
        // Raycast
        const raycaster = new Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        
        // Visual Tracer
        const start = new THREE.Vector3(0.2, -0.2, -0.5).applyQuaternion(camera.quaternion).add(camera.position);
        const end = raycaster.ray.at(50, new THREE.Vector3()); // Default end
        
        // Hit detection
        let hitDist = 50;
        let hitId: string | null = null;
        
        // We must update state
        setEnemies(prev => {
            let hitTypeScore = 0;
            const updatedEnemies = prev.map(e => {
                const config = ENEMY_CONFIG[e.type];
                const ePos = new THREE.Vector3(e.position.x, e.position.y + (0.75 * config.scale), e.position.z);
                const distToRay = raycaster.ray.distanceSqToPoint(ePos);
                
                // If aiming close to center of enemy (adjusted for scale)
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
            }).filter(e => {
                // Remove dead bodies immediately or could leave them as ragdolls later
                return e.hp > 0;
            });
            
            if (hitTypeScore > 0) onScore(hitTypeScore);
            return updatedEnemies;
        });

        // Add tracer
        const tracerId = Math.random();
        setTracers(prev => [...prev, { start, end, id: tracerId }]);
        setTimeout(() => setTracers(prev => prev.filter(t => t.id !== tracerId)), 100);

      } else {
        onShoot(false); // Click empty
        if (ammoRef.current === 0) reload();
      }
    } else if (!isMouseDown.current) {
        onShoot(false);
    }

    // --- Enemy Spawning ---
    if (time - lastSpawnTime.current > ENEMY_SPAWN_RATE) {
      lastSpawnTime.current = time;
      // Spawn random angle distance 20-30
      const angle = Math.random() * Math.PI * 2;
      const dist = 25 + Math.random() * 15;
      const spawnPos = new THREE.Vector3(
          camera.position.x + Math.cos(angle) * dist,
          0,
          camera.position.z + Math.sin(angle) * dist
      );
      
      // Randomize Type
      const rand = Math.random();
      let type: EnemyType = 'knight';
      if (rand < 0.5) type = 'peasant';
      else if (rand > 0.85) type = 'heavy';

      const config = ENEMY_CONFIG[type];

      setEnemies(prev => [
          ...prev, 
          { 
              id: Math.random().toString(), 
              type: type,
              position: { x: spawnPos.x, y: 0, z: spawnPos.z }, 
              hp: config.hp,
              maxHp: config.hp,
              speed: config.speed + (Math.random() - 0.5), // slight variation
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
            
            const config = ENEMY_CONFIG[e.type];
            const attackRange = 1.5 * config.scale;

            if (dist > attackRange) {
                // Move towards player
                const dir = pVec.sub(eVec).normalize();
                eVec.add(dir.multiplyScalar(e.speed * delta));
                return { ...e, position: { x: eVec.x, y: 0, z: eVec.z }, isAttacking: false };
            } else {
                // Attack range
                takingDamage = true;
                return { ...e, isAttacking: true };
            }
        });

        if (takingDamage) {
            onDamage(0.5); // Damage per frame close contact
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


// 6. Keyboard Mover Hook
function KeyboardMover() {
  const [, get] = useKeyboardControls()
  const { camera } = useThree()
  
  useFrame((state, delta) => {
    const { forward, backward, left, right } = get()
    const speed = PLAYER_SPEED * delta
    
    const vec = new THREE.Vector3()
    const frontVec = new THREE.Vector3(0, 0, 0)
    const sideVec = new THREE.Vector3(0, 0, 0)
    const direction = new THREE.Vector3()

    // Front/Back
    frontVec.set(0, 0, Number(backward) - Number(forward))
    // Left/Right
    sideVec.set(Number(left) - Number(right), 0, 0)

    direction.subVectors(frontVec, sideVec).normalize().multiplyScalar(speed).applyEuler(camera.rotation)
    
    // Lock Y movement (stay on ground)
    camera.position.x += direction.x
    camera.position.z += direction.z
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
  
  // Refs for complex game loop logic access
  const enemiesRef = useRef<Enemy[]>([]);
  const playerRef = useRef(new THREE.Vector3());

  // Commentary Loop
  useEffect(() => {
    if (!gameState.isPlaying) return;
    
    // Initial Intro
    generateBattleCommentary('intro', 0, 1).then(setCommentary);

  }, [gameState.isPlaying]);

  // Killstreak check
  useEffect(() => {
      if (gameState.score > 0 && gameState.score % 500 === 0) {
          generateBattleCommentary('killstreak', gameState.score, gameState.wave).then(setCommentary);
      }
  }, [gameState.score]);

  // Low HP check
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
          if (newHp === 0) return { ...prev, isPlaying: false }; // Game Over
          return { ...prev, health: newHp };
      });
  };

  const handleJoystick = (x: number, y: number) => {
      setJoystickData({ x, y });
  };

  const onShoot = (firing: boolean) => {
      setIsFiring(firing);
  }

  // Keyboard map
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
        
        {/* Crosshair */}
        {gameState.isPlaying && <div className="crosshair border-2 border-white rounded-full bg-white/30 backdrop-blur-sm z-10" />}
        
        {/* HUD */}
        {gameState.isPlaying && (
            <div className="absolute inset-0 pointer-events-none z-20 p-4 md:p-8 flex flex-col justify-between">
                {/* Top Bar */}
                <div className="flex justify-between items-start">
                    <div className="bg-black/50 p-4 rounded-lg text-white font-mono backdrop-blur">
                        <div className="text-2xl font-bold text-yellow-400">SCORE: {gameState.score}</div>
                        <div className="text-sm text-gray-300">WAVE: {gameState.wave}</div>
                    </div>
                    {/* Gemini Commentary Box */}
                    <div className="bg-blue-900/60 p-4 rounded-lg text-cyan-200 font-mono max-w-md backdrop-blur border-l-4 border-cyan-500">
                        <div className="text-xs uppercase tracking-widest mb-1 opacity-70">Battle AI Log</div>
                        <p className="text-sm md:text-base italic">"{commentary}"</p>
                    </div>
                </div>

                {/* Bottom Bar */}
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

        {/* Joystick (Mobile Only - Visual only appears on logic but we render always for touch devices technically) */}
        {gameState.isPlaying && (
            <div className="absolute inset-0 z-30 pointer-events-none">
                 {/* Only enable pointer events on the joystick area */}
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
            <Canvas shadows camera={{ fov: 75, position: [0, 1.7, 0] }}>
                <Suspense fallback={null}>
                    <World />
                    {gameState.isPlaying && (
                        <>
                            <PointerLockControls selector="#root" /> {/* Standard mouse lock for PC */}
                            <KeyboardMover />
                            <GameController 
                                onScore={handleScore}
                                onDamage={handleDamage}
                                joystickData={joystickData}
                                setAmmo={(a) => setGameState(prev => ({...prev, ammo: a}))}
                                onShoot={onShoot}
                                enemiesRef={enemiesRef}
                                playerRef={playerRef}
                            />
                            {/* Weapon attached to camera via Drei or manually updated? 
                                Simplest in R3F: Put it in a group that follows camera, 
                                but PointerLockControls moves the camera object itself.
                                We can just parent the weapon to the camera using createPortal or just simple logic.
                                ACTUALLY: The best way without complex rigs is to use a component that uses useFrame to clamp to camera.
                            */}
                            <WeaponRig isFiring={isFiring} isReloading={gameState.ammo === 0 && isFiring} />
                        </>
                    )}
                </Suspense>
                {/* Stats for dev performance monitoring */}
                {/* <Stats /> */}
            </Canvas>
        </KeyboardControls>
    </div>
  );
}

// Helper to attach weapon to camera view
const WeaponRig = ({ isFiring, isReloading }: { isFiring: boolean, isReloading: boolean }) => {
    const { camera } = useThree();
    const ref = useRef<THREE.Group>(null);
    
    useFrame(() => {
        if (!ref.current) return;
        // Smoothly interpolate position to camera to avoid jitter, or hard lock
        ref.current.position.copy(camera.position);
        ref.current.quaternion.copy(camera.quaternion);
    });

    return (
        <group ref={ref}>
            <Weapon isFiring={isFiring} isReloading={isReloading} />
        </group>
    )
}