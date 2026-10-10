import { build } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.resolve(root, ".tmp-pkg-test");
fs.mkdirSync(tmp, { recursive: true });

const pkg = path.join(tmp, "node_modules/mylib");
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(
  path.join(tmp, "node_modules/mylib/package.json"),
  JSON.stringify({ name: "mylib", version: "1.0.0", main: "index.mjs" }),
);
fs.writeFileSync(
  path.join(tmp, "node_modules/mylib/index.mjs"),
  "'use client';\nexport const x = 1;\n",
);

const entry = path.join(tmp, "entry.tsx");
fs.writeFileSync(entry, "export const y = 1;\n");

for (const [label, opts] of [
  ["default", {}],
  ["target es2015", { target: "es2015" }],
  ["target es2022", { target: "es2022" }],
  ["jsxRuntime classic", { jsxRuntime: "classic" }],
]) {
  console.log("########## " + label + " ##########");
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react(opts)],
    build: {
      write: false,
      rollupOptions: {
        input: [entry],
        onwarn(warn) {
          if (warn.code === "EMPTY_BUNDLE") return;
          console.log("[" + warn.code + "] " + warn.message);
        },
      },
    },
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
