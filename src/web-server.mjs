import { spawn } from "node:child_process";

const processes = [
    spawn(process.execPath, ["src/http-server.mjs"], { stdio: "inherit" }),
    spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5599"], {
        stdio: "inherit",
    }),
];

let stopping = false;

function stop(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of processes) child.kill("SIGTERM");
    setTimeout(() => process.exit(exitCode), 1_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());

for (const child of processes) {
    child.on("exit", (code) => {
        if (!stopping) stop(code || 1);
    });
}
