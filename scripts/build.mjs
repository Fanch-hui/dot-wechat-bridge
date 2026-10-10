import { build } from 'esbuild';
import { mkdir, copyFile, readFile, readdir } from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await mkdir('dist/gateway',{recursive:true});
await build({entryPoints:['src/gateway/main.ts'],outfile:'dist/gateway/main.js',bundle:true,format:'esm',platform:'node',target:'node22',packages:'external'});
const gatewayBundle=await readFile('dist/gateway/main.js','utf8');
const client=await build({entryPoints:['src/admin/client.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',minify:true});
const style=await readFile('src/admin/styles.css','utf8');
await build({entryPoints:['src/worker.ts'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',
  define:{__BRIDGE_GATEWAY_BUNDLE__:JSON.stringify(gatewayBundle),
    __BRIDGE_ADMIN_CLIENT__:JSON.stringify(client.outputFiles[0].text),__BRIDGE_ADMIN_STYLE__:JSON.stringify(style)}});
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
await mkdir('dist/drizzle',{recursive:true});
for(const name of await readdir('drizzle')) if(name.endsWith('.sql')) await copyFile('drizzle/'+name,'dist/drizzle/'+name);
