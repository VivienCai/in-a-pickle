export interface StreamConfig {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

interface StreamUploadResponse {
  result?: { uid?: string };
}

interface StreamDownloadResponse {
  result?: { audio?: { status?: string; url?: string } };
}

interface StreamVideoResponse {
  result?: {
    readyToStream?: boolean;
    status?: { state?: string };
  };
}

interface CloudflareErrorResponse {
  errors?: Array<{ message?: string }>;
}

export type StreamUploadResult =
  | { ok: true; uid: string }
  | { ok: false; error: string };

export type StreamAudioResult =
  | { ok: true; audioUrl: string }
  | { ok: false; error: string; retryable: boolean };

function isConfigured(env: StreamConfig): boolean {
  return [env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN].every(
    (value) => typeof value === "string" && value.length > 0 && !value.startsWith("TODO"),
  );
}

function baseUrl(env: StreamConfig): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream`;
}

function authHeaders(env: StreamConfig): HeadersInit {
  return { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as CloudflareErrorResponse;
  return body.errors?.map((error) => error.message).filter(Boolean).join(" ") || fallback;
}

export async function uploadClip(
  env: StreamConfig,
  clip: Blob,
): Promise<StreamUploadResult> {
  if (!isConfigured(env)) {
    return { ok: false, error: "Cloudflare Stream is not configured." };
  }

  try {
    const formData = new FormData();
    const extension = clip.type.includes("mp4") ? "mp4" : "webm";
    const fileName = clip instanceof File ? clip.name : `sound-effect.${extension}`;
    formData.append("file", clip, fileName);

    const uploadResponse = await fetch(baseUrl(env), {
      method: "POST",
      headers: authHeaders(env),
      body: formData,
    });
    if (!uploadResponse.ok) {
      const error = await responseError(uploadResponse, `Stream upload failed (${uploadResponse.status}).`);
      console.error(`Stream clip upload failed: ${error}`);
      return { ok: false, error };
    }

    const upload = await uploadResponse.json() as StreamUploadResponse;
    const uid = upload.result?.uid;
    if (!uid) {
      return { ok: false, error: "Stream did not return an upload ID." };
    }

    return { ok: true, uid };
  } catch (error) {
    console.error("Stream clip upload error:", error);
    return { ok: false, error: "Could not reach Cloudflare Stream." };
  }
}

export async function prepareClipAudio(
  env: StreamConfig,
  uid: string,
): Promise<StreamAudioResult> {
  try {

    let videoReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const detailsResponse = await fetch(`${baseUrl(env)}/${uid}`, {
        headers: authHeaders(env),
      });
      if (!detailsResponse.ok) {
        if (detailsResponse.status === 429 || detailsResponse.status >= 500) {
          continue;
        }
        const error = await responseError(detailsResponse, `Stream status failed (${detailsResponse.status}).`);
        return { ok: false, error, retryable: false };
      }
      const details = await detailsResponse.json() as StreamVideoResponse;
      if (details.result?.readyToStream || details.result?.status?.state === "ready") {
        videoReady = true;
        break;
      }
      if (details.result?.status?.state === "error") {
        return { ok: false, error: "Stream could not process the sound recording.", retryable: false };
      }
    }
    if (!videoReady) {
      return { ok: false, error: "Stream is still processing the sound recording.", retryable: true };
    }

    const downloadResponse = await fetch(`${baseUrl(env)}/${uid}/downloads/audio`, {
      method: "POST",
      headers: authHeaders(env),
    });
    if (!downloadResponse.ok) {
      const error = await responseError(downloadResponse, `Stream audio preparation failed (${downloadResponse.status}).`);
      console.error(`Stream audio download creation failed: ${error}`);
      return {
        ok: false,
        error,
        retryable: downloadResponse.status === 429 || downloadResponse.status >= 500,
      };
    }

    let download = await downloadResponse.json() as StreamDownloadResponse;
    for (let attempt = 0; download.result?.audio?.status !== "ready" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const statusResponse = await fetch(`${baseUrl(env)}/${uid}/downloads`, {
        headers: authHeaders(env),
      });
      if (!statusResponse.ok) {
        if (statusResponse.status === 429 || statusResponse.status >= 500) {
          continue;
        }
        const error = await responseError(statusResponse, `Stream audio status failed (${statusResponse.status}).`);
        return { ok: false, error, retryable: false };
      }
      download = await statusResponse.json() as StreamDownloadResponse;
    }

    const audioUrl = download.result?.audio?.status === "ready"
      ? download.result.audio.url
      : undefined;
    if (!audioUrl) {
      return { ok: false, error: "Stream is still preparing the audio.", retryable: true };
    }

    return { ok: true, audioUrl };
  } catch (error) {
    console.error("Stream audio preparation error:", error);
    return { ok: false, error: "Could not finish processing the sound recording.", retryable: true };
  }
}

export async function deleteClip(env: StreamConfig, uid: string): Promise<boolean> {
  if (!isConfigured(env) || !uid) {
    return false;
  }

  try {
    const response = await fetch(`${baseUrl(env)}/${uid}`, {
      method: "DELETE",
      headers: authHeaders(env),
    });
    if (!response.ok && response.status !== 404) {
      console.error(`Stream clip deletion failed: ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Stream clip deletion error:", error);
    return false;
  }
}
