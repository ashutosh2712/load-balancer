import http from "node:http";

const [name, port] = [process.argv[2], Number(process.argv[3])];

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      return res.end("ok");
    }
    res.end(`Hello from backend ${name} (pid ${process.pid}, port ${port})\n`);
  })
  .listen(port, "127.0.0.1", () => console.log(`Backend ${name} on :${port}`));
