export interface RealtimeKitConfig {
  CLOUDFLARE_ACCOUNT_ID: string;
  REALTIMEKIT_APP_ID: string;
  REALTIMEKIT_PRESET_NAME: string;
  CLOUDFLARE_API_TOKEN: string;
}

interface MeetingResponse {
  data?: { id?: string };
}

interface ParticipantResponse {
  data?: { token?: string };
}

function isConfigured(env: RealtimeKitConfig): boolean {
  const values = [
    env.CLOUDFLARE_ACCOUNT_ID,
    env.REALTIMEKIT_APP_ID,
    env.REALTIMEKIT_PRESET_NAME,
    env.CLOUDFLARE_API_TOKEN,
  ];

  return values.every(
    (value) => typeof value === "string" && value.length > 0 && !value.startsWith("TODO"),
  );
}

function baseUrl(env: RealtimeKitConfig): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
}

function authHeaders(env: RealtimeKitConfig): HeadersInit {
  return {
    Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function createMeeting(env: RealtimeKitConfig, roomCode: string): Promise<string | null> {
  if (!isConfigured(env)) {
    return null;
  }

  try {
    const response = await fetch(`${baseUrl(env)}/meetings`, {
      method: "POST",
      headers: authHeaders(env),
      body: JSON.stringify({ title: `In A Pickle ${roomCode}` }),
    });

    if (!response.ok) {
      console.error(`RealtimeKit createMeeting failed: ${response.status}`);
      return null;
    }

    const json = await response.json() as MeetingResponse;
    return json?.data?.id ?? null;
  } catch (error) {
    console.error("RealtimeKit createMeeting error:", error);
    return null;
  }
}

export async function addParticipant(
  env: RealtimeKitConfig,
  meetingId: string,
  playerId: string,
  name: string,
): Promise<string | null> {
  if (!isConfigured(env)) {
    return null;
  }

  try {
    const response = await fetch(`${baseUrl(env)}/meetings/${meetingId}/participants`, {
      method: "POST",
      headers: authHeaders(env),
      body: JSON.stringify({
        name,
        preset_name: env.REALTIMEKIT_PRESET_NAME,
        custom_participant_id: playerId,
      }),
    });

    if (!response.ok) {
      console.error(`RealtimeKit addParticipant failed: ${response.status}`);
      return null;
    }

    const json = await response.json() as ParticipantResponse;
    return json?.data?.token ?? null;
  } catch (error) {
    console.error("RealtimeKit addParticipant error:", error);
    return null;
  }
}
