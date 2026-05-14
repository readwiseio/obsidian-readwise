const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ACCOUNT_EXPIRED_MESSAGE,
  getErrorDetailsFromResponse,
} = require("../.test-build/src/errors");

function jsonResponse(body, status = 403, statusText = "Forbidden") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

test("getErrorDetailsFromResponse uses structured account expired messages", async () => {
  const message = "Your Readwise trial has expired. Upgrade to continue syncing.";
  const error = await getErrorDetailsFromResponse(jsonResponse({
    error: "account_expired",
    message,
    upgrade_url: "https://readwise.io/upgrade?ref=obsidian",
  }));

  assert.deepEqual(error, {
    code: "account_expired",
    message,
  });
});

test("getErrorDetailsFromResponse falls back when account expired message is missing", async () => {
  const error = await getErrorDetailsFromResponse(jsonResponse({
    error: "account_expired",
  }));

  assert.deepEqual(error, {
    code: "account_expired",
    message: ACCOUNT_EXPIRED_MESSAGE,
  });
});

test("getErrorDetailsFromResponse ignores plain expired account text responses", async () => {
  const error = await getErrorDetailsFromResponse(new Response(
    "Your Readwise account has expired",
    {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "text/plain" },
    },
  ));

  assert.deepEqual(error, {
    message: "Forbidden",
  });
});

test("getErrorDetailsFromResponse preserves existing lock and conflict messages", async () => {
  assert.deepEqual(
    await getErrorDetailsFromResponse(new Response("", { status: 409 })),
    { message: "Sync in progress initiated by different client" },
  );
  assert.deepEqual(
    await getErrorDetailsFromResponse(new Response("", { status: 417 })),
    { message: "Obsidian export is locked. Wait for an hour." },
  );
});
