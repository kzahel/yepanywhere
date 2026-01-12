#!/usr/bin/env node
import { WebSocket } from 'ws';

const url = process.argv[2] || 'wss://relay.yepanywhere.com/ws';

console.log(`Connecting to: ${url}`);

const ws = new WebSocket(url, {
  // Log all headers for debugging
  headers: {
    'User-Agent': 'test-relay-ws/1.0'
  }
});

ws.on('open', () => {
  console.log('Connected!');

  // Send a test registration
  const msg = {
    type: 'server_register',
    username: 'test-debug',
    installId: 'test-install-123'
  };
  console.log('Sending:', JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  if (err.message.includes('Unexpected server response')) {
    console.error('This means the server returned HTTP instead of upgrading to WebSocket');
  }
});

ws.on('close', (code, reason) => {
  console.log(`Closed: code=${code} reason=${reason.toString()}`);
  process.exit(0);
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log('Timeout - closing');
  ws.close();
  process.exit(1);
}, 10000);
