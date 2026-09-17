import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "DATABASE_URL")),
});

let buffer = "";
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  }
});

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout esperando ${method}`));
    }, 4000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "marketplace-control-smoke", version: "0.1.0" },
  });

  if (initialized.error) throw new Error("initialize devolvió error");

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const listed = await request(2, "tools/list");
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  const required = [
    "search_providers",
    "get_provider",
    "pipeline_stats",
    "list_registration_submissions",
  ];

  if (!required.every((name) => names.includes(name))) {
    throw new Error(`Herramientas MCP incompletas: ${names.join(", ")}`);
  }

  const missingDatabase = await request(3, "tools/call", {
    name: "pipeline_stats",
    arguments: {},
  });
  const errorText = missingDatabase.result?.content?.[0]?.text ?? "";
  if (!missingDatabase.result?.isError || !errorText.includes("DATABASE_URL")) {
    throw new Error("La ausencia de DATABASE_URL no fue manejada de forma segura");
  }

  console.log(`smoke OK: ${required.join(", ")} + guard DATABASE_URL`);
} finally {
  child.kill();
}
