const http = require('http');
const endpoints = ['/now-playing','/queue','/health'];
const host = 'localhost';
const port = 3000;
const opts = (path) => ({ hostname: host, port, path, method: 'GET', headers: { Authorization: 'Bearer test-token-for-local-validation' } });

(async function(){
  for (const p of endpoints) {
    await new Promise((res) => {
      const req = http.request(opts(p), (r) => {
        let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ console.log('===',p,'STATUS',r.statusCode); try{ console.log(JSON.parse(b)); }catch(e){ console.log(b); } res(); });
      });
      req.on('error', (e)=>{ console.log('ERR',p,e.message); res(); });
      req.end();
    });
  }
})();
