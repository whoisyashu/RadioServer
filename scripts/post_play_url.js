const http = require('http');
const data = JSON.stringify({ query: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
const options = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Authorization': 'Bearer test-token-for-local-validation'
  }
};
const req = http.request('http://localhost:3000/play', options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    try { console.log('STATUS', res.statusCode); console.log(JSON.parse(body)); }
    catch(e){ console.log('RAW', body); }
  });
});
req.on('error', (err) => console.error('ERR', err));
req.write(data);
req.end();
