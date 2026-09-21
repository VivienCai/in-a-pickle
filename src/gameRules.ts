import type { Obstacle, VoiceQte } from "./types";

export const TICK_MS = 50;
export const WORLD_HEIGHT = 350;
export const PICKLE_HEIGHT = 48;
export const CEILING_SPIKE_HEIGHT = 42;
export const QTE_FIRST_TICK = 160;
export const QTE_INTERVAL_TICKS = 240;
export const QTE_DURATION_TICKS = 60;
export const QTE_RESULT_TICKS = 35;
export const BASE_RUN_SPEED = 145;
export const MAX_RUN_SPEED = 170;
export const RUN_SPEED_GAIN_PER_SECOND = 0.1;
export const QTE_SAFETY_BUFFER = 40;

export function getRunSpeed(tick: number): number {
  const elapsedSeconds = tick * TICK_MS / 1000;
  return Math.min(MAX_RUN_SPEED, BASE_RUN_SPEED + elapsedSeconds * RUN_SPEED_GAIN_PER_SECOND);
}

export function getQteSafetyEndX(characterX: number, runSpeed: number): number {
  const qteDurationSeconds = QTE_DURATION_TICKS * TICK_MS / 1000;
  return characterX + runSpeed * qteDurationSeconds + QTE_SAFETY_BUFFER;
}

export function isQtePathClear(obstacles: Obstacle[], characterX: number, safetyEndX: number): boolean {
  const pickleRight = characterX + 32;
  return obstacles.every((obstacle) =>
    obstacle.x + obstacle.width <= pickleRight || obstacle.x >= safetyEndX
  );
}

export function isQteVolumeInTarget(type: Exclude<VoiceQte["type"], "solo">, volume: number): boolean {
  return type === "quiet"
    ? volume <= 0.18
    : volume >= 0.3 && volume <= 0.58;
}

export function getQteControlPlayerIds(qte: VoiceQte | null, connectedPlayerIds: string[]): string[] {
  if (qte?.type !== "solo" || !qte.targetPlayerId) {
    return connectedPlayerIds;
  }

  return connectedPlayerIds.includes(qte.targetPlayerId) ? [qte.targetPlayerId] : [];
}

export function isQteSuccess(successfulTicks: number, totalTicks: number): boolean {
  return successfulTicks >= Math.ceil(totalTicks * 0.65);
}

export function hitsCeilingSpikes(characterHeight: number): boolean {
  return characterHeight + PICKLE_HEIGHT >= WORLD_HEIGHT - CEILING_SPIKE_HEIGHT;
}

export function hitsObstacle(characterHeight: number, obstacle: Obstacle): boolean {
  if (obstacle.kind === "floor") {
    return characterHeight < obstacle.height;
  }

  const pickleTop = characterHeight + PICKLE_HEIGHT;
  const obstacleTop = obstacle.y + obstacle.height;
  return pickleTop > obstacle.y && characterHeight < obstacleTop;
}
