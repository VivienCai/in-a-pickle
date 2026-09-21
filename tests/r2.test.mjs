import assert from "node:assert/strict";
import test from "node:test";

import { deleteClip, uploadClip } from "../src/r2.ts";

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

test("uploadClip stores playable audio with an immutable unique URL", async () => {
  const { env, puts } = makeEnv();
  const clip = new Blob(["audio"], { type: "audio/webm;codecs=opus" });

  const result = await uploadClip(env, clip, "ABCD", "player-1", "death");

  assert.equal(result.ok, true);
  assert.match(result.key, /^rooms\/ABCD\/player-1\/death-[0-9a-f-]+\.webm$/);
  assert.equal(result.url, `https://audio.example.test/${result.key}`);
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], result.key);
  assert.equal(puts[0][1], clip);
  assert.deepEqual(puts[0][2], {
    httpMetadata: {
      contentType: "audio/webm;codecs=opus",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
});

test("deleteClip removes an R2 object by key", async () => {
  const { env, deletes } = makeEnv();

  await deleteClip(env, "rooms/ABCD/player-1/death-test.webm");

  assert.deepEqual(deletes, ["rooms/ABCD/player-1/death-test.webm"]);
});
