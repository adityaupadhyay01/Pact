import type { SessionView } from "@/lib/pact";

export type { SessionView };

export async function post<T = SessionView>(url: string, data: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export const sessionAction = <T = SessionView>(id: string, action: string, data: unknown = {}) =>
  post<T>(`/api/session/${id}/${action}`, data);
