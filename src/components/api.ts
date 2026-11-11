import type { SessionView } from "@/lib/pact";

export type { SessionView };

/** An API error with the server's machine-readable code (e.g. AI_UNAVAILABLE). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null,
  ) {
    super(message);
  }
}

export async function post<T = SessionView>(url: string, data: unknown = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {
    throw new ApiError("Couldn't reach the PACT server. Check your connection and try again.", 0, "NETWORK");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status, json.code ?? null);
  return json as T;
}

export const sessionAction = <T = SessionView>(id: string, action: string, data: unknown = {}) =>
  post<T>(`/api/session/${id}/${action}`, data);
