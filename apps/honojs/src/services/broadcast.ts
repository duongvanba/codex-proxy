export class BroadcastService {
  readonly logClients = new Set<(data: string) => void>();
  private _onReport?: (entry: object) => void;

  /** Wire up livequery report callback (called from services/index.ts to break circular dep). */
  onReport(fn: (entry: object) => void): void {
    this._onReport = fn;
  }

  broadcastLog(entry: object): void {
    this._onReport?.(entry);
    const data = `data: ${JSON.stringify(entry)}\n\n`;
    for (const send of this.logClients) send(data);
  }
}
