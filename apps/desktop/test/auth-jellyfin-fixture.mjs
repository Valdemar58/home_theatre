import { createServer } from 'node:http';
createServer(async (req,res)=>{
 let body=''; for await(const chunk of req) body+=chunk;
 if(req.url==='/Users/AuthenticateByName' && req.method==='POST'){
  const b=JSON.parse(body||'{}');
  if(['desktop-fixture','viewer-fixture'].includes(b.Username) && b.Pw==='fixture-only-password'){
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({User:{Id:b.Username==='desktop-fixture'?'desktop-auth-fixture':'viewer-auth-fixture',Name:b.Username,Policy:{IsAdministrator:false}}}));return;
  }
  res.writeHead(401);res.end();return;
 }
 res.writeHead(404);res.end('{}');
}).listen(8096,'0.0.0.0');
