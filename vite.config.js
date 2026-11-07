import { defineConfig } from 'vite';
import { cpSync } from 'node:fs';

// Папка data/ не є "public" для Vite, тому після збірки копіюємо її в dist/data
function copyData() {
  return {
    name: 'copy-data',
    apply: 'build',
    closeBundle() {
      cpSync('data', 'dist/data', { recursive: true });
    },
  };
}

export default defineConfig({
  // Відносні шляхи: працює і в корені домену, і в підпапці (GitHub Pages тощо)
  base: './',
  plugins: [copyData()],
});