import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Marque les peers comme externes — ne pas les bundle.
  external: [
    'react',
    'react-native',
    'react-native-view-shot',
    'expo-application',
    'expo-device',
    'expo-updates',
    'expo-constants',
    '@react-native-async-storage/async-storage',
  ],
  // RN runtime → JS lisible, pas de minification
  minify: false,
  target: 'es2020',
});
