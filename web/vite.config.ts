import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
        sound: resolve(__dirname, 'sound.html'),
        viewer: resolve(__dirname, 'viewer.html'),
        native: resolve(__dirname, 'native.html'),
        battledev: resolve(__dirname, 'battle-dev.html'),
        editor: resolve(__dirname, 'editor.html'),
      },
    },
  },
});
