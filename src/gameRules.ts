import type { VoiceQte } from "./types";

export const TICK_MS = 50;
export const WORLD_HEIGHT = 350;
export const PICKLE_HEIGHT = 48;
export const CEILING_SPIKE_HEIGHT = 42;
export const QTE_FIRST_TICK = 160;
export const QTE_INTERVAL_TICKS = 240;
export const QTE_DURATION_TICKS = 60;
export const QTE_RESULT_TICKS = 35;

export function isQteVolumeInTarget(type: VoiceQte["type"], volume: number): boolean {
  return type === "quiet"
    ? volume <= 0.18
    : volume >= 0.3 && volume <= 0.58;
}

export function isQteSuccess(successfulTicks: number, totalTicks: number): boolean {
  return successfulTicks >= Math.ceil(totalTicks * 0.65);
}

export function hitsCeilingSpikes(characterHeight: number): boolean {
  return characterHeight + PICKLE_HEIGHT >= WORLD_HEIGHT - CEILING_SPIKE_HEIGHT;
}
