import { Miniflare } from 'miniflare';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';
await mkdir('.runtime',{recursive:true,mode:0o700});
let keys:{BRIDGE_TOKEN:string;DATA_KEY_B64:string};
try {keys=JSON.parse(await readFile('.runtime/dev-keys.json','utf8'));}
catch(error) {
  if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
  keys={BRIDGE_TOKEN:Buffer.from(randomBytes(32)).toString('base64'),DATA_KEY_B64:Buffer.from(randomBytes(32)).toString('base64')};
  await writeFile('.runtime/dev-keys.json',JSON.stringify(keys),{mode:0o600,flag:'wx'});
}
const [gateway,client,style]=await Promise.all([
  build({entryPoints:['src/gateway/main.ts'],bundle:true,write:false,format:'esm',platform:'node',target:'node22',packages:'external'}),
  build({entryPoints:['src/admin/client.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',minify:true}),
  readFile('src/admin/styles.css','utf8'),
]);
const worker=await build({entryPoints:['src/worker.ts'],bundle:true,format:'esm',platform:'browser',write:false,
  define:{__BRIDGE_GATEWAY_BUNDLE__:JSON.stringify(gateway.outputFiles[0].text),
    __BRIDGE_ADMIN_CLIENT__:JSON.stringify(client.outputFiles[0].text),__BRIDGE_ADMIN_STYLE__:JSON.stringify(style)}});
const mf=new Miniflare({modules:true,script:worker.outputFiles![0].text,compatibilityDate:'2026-07-28',
  host:'127.0.0.1',port:8787,d1Databases:['DB'],d1Persist:'.runtime/local-d1',r2Buckets:['MEDIA'],r2Persist:'.runtime/local-r2',bindings:{
    BRIDGE_TOKEN:process.env.BRIDGE_TOKEN??keys.BRIDGE_TOKEN,
    DATA_KEY_B64:process.env.DATA_KEY_B64??keys.DATA_KEY_B64,
  }});
const db=await mf.getD1Database('DB');
await db.prepare('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)').run();
for (const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()) {
  if (await db.prepare('SELECT name FROM local_migrations WHERE name=?').bind(file).first()) continue;
  const sql=await readFile('drizzle/'+file,'utf8');
  for (const statement of sql.split('--> statement-breakpoint').filter(s=>s.trim())) await db.prepare(statement).run();
  await db.prepare('INSERT INTO local_migrations(name) VALUES(?)').bind(file).run();
}
console.log('Local MCP endpoint: '+(await mf.ready).href+'mcp');
console.log('Local development accepts identity headers; keep it on loopback.');
const close=async()=>{await mf.dispose();process.exit(0);};
process.on('SIGTERM',close);process.on('SIGINT',close);
