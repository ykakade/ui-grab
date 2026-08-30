import { defineConfig } from 'vite';
import uiGrab from '../../src/index.js';

export default defineConfig({
  plugins: [uiGrab()],
});
