import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import babel from 'vite-plugin-babel';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves @mediapipe/tasks-vision WASM assets locally at /mediapipe-wasm/*
 * during dev/preview and copies them into dist/mediapipe-wasm during build.
 */
function mediapipeWasmPlugin(): Plugin {
  const wasmSourceDir = path.resolve(
    rootDir,
    'node_modules/@mediapipe/tasks-vision/wasm',
  );
  const urlPrefix = '/mediapipe-wasm/';

  const createMiddleware = () => (req: any, res: any, next: any) => {
    const reqUrl: string | undefined = req.url?.split('?')[0];
    if (!reqUrl || !reqUrl.startsWith(urlPrefix)) {
      return next();
    }
    const relPath = reqUrl.slice(urlPrefix.length);
    const safeName = path.basename(relPath);
    const fullPath = path.join(wasmSourceDir, safeName);
    if (!fs.existsSync(fullPath)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    if (safeName.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    } else if (safeName.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
    fs.createReadStream(fullPath).pipe(res);
  };

  return {
    name: 'mediapipe-wasm-local',
    configureServer(server) {
      server.middlewares.use(createMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createMiddleware());
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(rootDir, 'dist');
      const targetDir = path.join(outDir, 'mediapipe-wasm');
      fs.mkdirSync(targetDir, { recursive: true });
      if (fs.existsSync(wasmSourceDir)) {
        for (const file of fs.readdirSync(wasmSourceDir)) {
          fs.copyFileSync(
            path.join(wasmSourceDir, file),
            path.join(targetDir, file),
          );
        }
      }
    },
  };
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/reactylon-chords/' : '/',
  plugins: [
    mediapipeWasmPlugin(),
    babel({
      include: /\.[jt]sx?$/,
      exclude: /node_modules/,
      babelConfig: {
        presets: [
          '@babel/preset-typescript',
          ['@babel/preset-react', { runtime: 'automatic' }],
        ],
        plugins: ['babel-plugin-reactylon'],
      },
    }),
    react(),
  ],
});
