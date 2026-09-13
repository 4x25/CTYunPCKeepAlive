/**
 * 打包客户端 JSX：用 esbuild 把 `@hono/hono/jsx/dom` 打成单文件。
 *
 * 必须走 automatic JSX transform 并指向 `jsx/dom` 子路径 —— 手动
 * `jsxFactory` 会去找顶层 `hono/jsx` 的 `jsx` 导出，而 dom 版本的
 * 渲染入口在 `jsx/dom`，两者不通用。
 */
import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@^0.10.3";

await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: ["./src/client/app.tsx"],
  outfile: "./assets/client.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "jsr:@hono/hono/jsx/dom",
  logLevel: "warning",
});

const size = (await Deno.stat("./assets/client.js")).size;
console.log(`✅ 客户端打包完成：assets/client.js（${(size / 1024).toFixed(1)} KB）`);

esbuild.stop();
