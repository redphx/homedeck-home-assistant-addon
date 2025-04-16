import { defineConfig } from 'vite';
import monacoEditorPlugin from 'vite-plugin-monaco-editor-esm';

export default defineConfig({
    base: './',
    build: {
        rollupOptions: {
            output: {
                manualChunks: {
                    'vendor': ['monaco-editor'],
                },
            },
        },
    },
    plugins: [monacoEditorPlugin({})],
    server: {
        allowedHosts: true,
        host: true, // Accept all hosts (0.0.0.0)
    },
});
