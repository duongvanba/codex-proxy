import { addReport } from "./livequery";

export const logClients = new Set<(data: string) => void>();

export function broadcastLog(entry: object) {
  addReport(entry as any);
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const send of logClients) send(data);
}
