import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    server: {
      port: Number(process.env.CCC_TEST_PORT || 3000),
      open: true,
      proxy: {
        '/api/gemini': {
          target: 'https://generativelanguage.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/gemini/, ''),
          secure: true
        },
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
          secure: true,
          headers: {
            'anthropic-dangerous-direct-browser-access': 'true'
          }
        },
        '/api/openai': {
          target: 'https://api.openai.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/openai/, ''),
          secure: true
        },
        // Same-origin route to the class-provisioning runner: its CORS
        // allowlist only admits the production site, so dev traffic must be
        // proxied through this server instead of sent cross-origin.
        '/api/ffai-runner': {
          target: 'https://ccc-ffai-runner-y5cyj3473a-uw.a.run.app',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/ffai-runner/, ''),
          secure: true
        }
      }
    },
    define: {
      'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(env.VITE_GEMINI_API_KEY || ''),
      'import.meta.env.VITE_PUBLIC_POSTHOG_KEY': JSON.stringify(env.VITE_PUBLIC_POSTHOG_KEY || ''),
      'import.meta.env.VITE_PUBLIC_POSTHOG_HOST': JSON.stringify(env.VITE_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com')
    }
  };
});
