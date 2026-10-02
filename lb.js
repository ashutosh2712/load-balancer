// ---------- Step 1: Backend ----------
export class Backend {
  constructor(host, port, weight = 1) {
    this.host = host;
    this.port = port;
    this.weight = weight;
    this.healthy = true;
    this.active = 0; // in-flight requests
    this.current = 0; // used by smooth weighted round robin
  }
  get addr() {
    return `${this.host}:${this.port}`;
  }
}
