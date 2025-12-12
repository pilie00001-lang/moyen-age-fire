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
}

export interface Obstacle {
  id: string;
  type: 'tree' | 'rock' | 'ruin' | 'mountain' | 'house';
  position: Vector3;
  rotation: number;
  scale: Vector3;
  radius: number; // Collision radius
}

export interface GameState {
  score: number;
  health: number;
  wave: number;
  isPlaying: boolean;
  ammo: number;
}

export enum WeaponState {
  IDLE,
  FIRING,
  RELOADING
}

export type CommentaryType = 'intro' | 'killstreak' | 'low_health' | 'wave_start';