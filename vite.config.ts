import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 3000
	},
	build: {
		// Ensure assets are properly referenced
		assetsDir: 'assets',
		// Optimize for GitHub Pages
		rollupOptions: {
			output: {
				// Ensure consistent file naming
				entryFileNames: 'assets/[name]-[hash].js',
				chunkFileNames: 'assets/[name]-[hash].js',
				assetFileNames: 'assets/[name]-[hash].[ext]'
			}
		}
	}
});
