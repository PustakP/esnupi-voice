import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const isProduction = mode === 'production';
    
    return {
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        // disable lit dev mode in prod to avoid warnings
        'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
        // explicitly set lit dev mode off
        'process.env.LIT_DISABLE_DEV_MODE': JSON.stringify('true')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      // dev server config to help with cors issues
      server: {
        headers: {
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Opener-Policy': 'same-origin',
        }
      },
      // optimize lit for production
      ...(isProduction && {
        build: {
          minify: true,
          rollupOptions: {
            output: {
              manualChunks: {
                'lit': ['lit']
              }
            }
          }
        }
      })
    };
});
