export class Presence {
  private connected: boolean = false;

  trackConnected(): void {
    this.connected = true;
  }

  trackDisconnected(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
