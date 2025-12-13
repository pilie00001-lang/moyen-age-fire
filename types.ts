export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export type EnemyType = 'peasant' | 'knight' | 'heavy' | 'villager';

export interface Enemy {
  id: string;
  type: EnemyType;
  position: Vector3;
  hp: number;
  maxHp: number;
  speed: number;
  isAttacking: boolean;
  isDead?: boolean;
  deadTime?: number;
  velocity?: Vector3;
}

export interface Obstacle {
  id: string;
  type: 'tree' | 'rock' | 'ruin' | 'mountain' | 'wall' | 'roof' | 'shop_table' | 'well' | 'signpost';
  position: Vector3;
  rotation: number;
  scale: Vector3;
  radius: number; // Used for cylindrical collision (trees, rocks)
  dims?: { w: number, d: number, h: number }; // New: Used for box collision (walls)
}

export interface GameState {
  score: number;
  gold: number; // New: Currency
  health: number;
  wave: number;
  isPlaying: boolean;
  ammo: number;
  damageMultiplier: number; // New: Upgrade tracking
}

export enum WeaponState {
  IDLE,
  FIRING,
  RELOADING
}

export type CommentaryType = 'intro' | 'killstreak' | 'low_health' | 'wave_start' | 'shop_buy';