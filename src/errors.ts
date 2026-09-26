export interface ReadwiseAPIErrorResponse {
  error?: string;
  message?: string;
  upgrade_url?: string;
}

export interface ReadwiseSyncError {
  code?: string;
  message: string;
}

export const ACCOUNT_EXPIRED_MESSAGE = "Your Readwise trial has expired. Upgrade or renew your account to continue syncing highlights to Obsidian.";
export const INVALID_TOKEN_MESSAGE = "Your Readwise connection is no longer valid. Please reconnect in the Readwise plugin settings.";
export const SYNC_IN_PROGRESS_MESSAGE = "Sync in progress initiated by different client.";
export const EXPORT_LOCKED_MESSAGE = "Obsidian export is locked. Wait for an hour.";

export async function getJSONErrorFromResponse(response: Response): Promise<ReadwiseAPIErrorResponse | null> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    return await response.clone().json();
  } catch (e) {
    console.log("Readwise Official plugin: failed to parse error response: ", e);
    return null;
  }
}

export async function getErrorDetailsFromResponse(response?: Response): Promise<ReadwiseSyncError> {
  if (!response) {
    return { message: "Can't connect to server" };
  }

  if (response.status === 401) {
    return { code: "invalid_token", message: INVALID_TOKEN_MESSAGE };
  }
  if (response.status === 409) {
    return { message: SYNC_IN_PROGRESS_MESSAGE };
  }
  if (response.status === 417) {
    return { message: EXPORT_LOCKED_MESSAGE };
  }

  const errorResponse = await getJSONErrorFromResponse(response);
  if (errorResponse && errorResponse.error === "account_expired") {
    return {
      code: errorResponse.error,
      message: errorResponse.message || ACCOUNT_EXPIRED_MESSAGE,
    };
  }

  return { message: response.statusText || `Request failed with status ${response.status}` };
}

// Readwise rejected the stored token (HTTP 401, see getErrorDetailsFromResponse),
export function isInvalidTokenError(error: string | ReadwiseSyncError): boolean {
  return typeof error !== "string" && error.code === "invalid_token";
}
