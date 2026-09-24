import assert from "node:assert/strict";
import test from "node:test";

import { deleteClip, prepareClipAudio, uploadClip } from "../src/stream.ts";

function makeEnv() {
  const puts = [];
  const deletes = [];
  return {
    puts,
    deletes,
    env: {
      AUDIO_BUCKET: {
        async put(...args) {
          puts.push(args);
        },
        async delete(key) {
          deletes.push(key);
        },
      },
      R2_PUBLIC_URL: "https://audio.example.test/",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
    },
  };
}

test("uploadClip stores the existing recording blob in R2", async () => {
  const { env, puts } = makeEnv();
  const clip = new Blob(["recording"], { type: "video/webm;codecs=vp8,opus" });

  const result = await uploadClip(env, clip);

  assert.equal(result.ok, true);
  assert.match(result.uid, /^clips\/[0-9a-f-]+\.webm$/);
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], result.uid);
  assert.equal(puts[0][1], clip);
  assert.deepEqual(puts[0][2], {
    httpMetadata: {
      contentType: "video/webm;codecs=vp8,opus",
      cacheControl: "public, max-age=300, immutable",
    },
  });
});

test("prepareClipAudio resolves an R2 key without processing", async () => {
  const { env } = makeEnv();

  const result = await prepareClipAudio(env, "clips/example.webm");

  assert.deepEqual(result, {
    ok: true,
    audioUrl: "https://audio.example.test/clips/example.webm",
  });
});

test("deleteClip removes an R2 object", async () => {
  const { env, deletes } = makeEnv();

  const deleted = await deleteClip(env, "clips/example.webm");

  assert.equal(deleted, true);
  assert.deepEqual(deletes, ["clips/example.webm"]);
});
