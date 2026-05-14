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

  if (response.status === 409) {
    return { message: "Sync in progress initiated by different client" };
  }
  if (response.status === 417) {
    return { message: "Obsidian export is locked. Wait for an hour." };
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
