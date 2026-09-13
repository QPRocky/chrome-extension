import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

/** Small fake backend so the playground produces varied network traffic. */
function mockApi(): Plugin {
  const todos = [
    { id: 1, title: 'Record network requests', done: true },
    { id: 2, title: 'Inspect Redux state', done: false },
  ];
  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };

        if (url.pathname === '/todos' && req.method === 'GET') return json(200, todos);
        if (url.pathname === '/todos' && req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const todo = { id: Date.now(), done: false, ...JSON.parse(raw || '{}') };
          todos.push(todo);
          return json(201, todo);
        }
        if (url.pathname === '/slow') {
          await new Promise((r) => setTimeout(r, 1500));
          return json(200, { waited: 1500 });
        }
        if (url.pathname === '/error') return json(500, { error: 'Something broke', code: 'E_BROKEN' });
        if (url.pathname === '/pixel.png') {
          res.setHeader('Content-Type', 'image/png');
          return res.end(PIXEL_PNG);
        }
        if (url.pathname === '/text') {
          res.setHeader('Content-Type', 'text/plain');
          return res.end('Plain text response\nline 2');
        }
        json(404, { error: 'Not found' });
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), mockApi()],
  server: { port: 5174 },
});
