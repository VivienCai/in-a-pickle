export interface AudioStorageConfig {
  AUDIO_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

export type AudioStage = "death" | "triumph";

export type ClipUploadResult =
  | { ok: true; key: string; url: string }
  | { ok: false; error: string };

function extensionFor(contentType: string): string {
  if (contentType.includes("mp4")) {
    return "mp4";
  }
  if (contentType.includes("ogg")) {
    return "ogg";
  }
  return "webm";
}

export async function uploadClip(
  env: AudioStorageConfig,
  clip: Blob,
  roomCode: string,
  playerId: string,
  stage: AudioStage,
): Promise<ClipUploadResult> {
  const publicUrl = env.R2_PUBLIC_URL?.replace(/\/$/, "");
  if (!env.AUDIO_BUCKET || !publicUrl) {
    return { ok: false, error: "R2 audio storage is not configured." };
  }

  const contentType = clip.type || "audio/webm";
  const key = `rooms/${roomCode}/${playerId}/${stage}-${crypto.randomUUID()}.${extensionFor(contentType)}`;
  try {
    await env.AUDIO_BUCKET.put(key, clip, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    return { ok: true, key, url: `${publicUrl}/${key}` };
  } catch (error) {
    console.error("R2 clip upload error:", error);
    return { ok: false, error: "Could not save the sound recording." };
  }
}

export async function deleteClip(env: AudioStorageConfig, key: string): Promise<void> {
  if (!key) {
    return;
  }

  // Stream IDs may remain in durable objects created before the R2 migration.
  if (!key.startsWith("rooms/")) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${key}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        },
      );
      if (!response.ok) {
        console.error(`Legacy Stream clip deletion failed: ${response.status}`);
      }
    } catch (error) {
      console.error("Legacy Stream clip deletion error:", error);
    }
    return;
  }

  if (!env.AUDIO_BUCKET) {
    return;
  }

  try {
    await env.AUDIO_BUCKET.delete(key);
  } catch (error) {
    console.error("R2 clip deletion error:", error);
  }
}
