'use strict';
// Wrapper: starts server.js bound strictly to 127.0.0.1
// This file is temporary and must be deleted after use.
process.env.PORT = process.env.PORT || '3001';

const http = require('http');
const app = require('./server.js');

// server.js only calls app.listen when require.main === module,
// which is false here — so we control the bind ourselves.
const PORT = parseInt(process.env.PORT, 10);
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[PayVault] Listening on 127.0.0.1:${PORT} (sandbox, localhost-only)`);
});

server.on('error', (e) => {
  console.error('[PayVault] Server error:', e.message);
  process.exit(1);
});
