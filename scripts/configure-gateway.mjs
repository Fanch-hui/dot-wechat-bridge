import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// Configuration arrives on hidden stdin so secrets never enter argv or history.
const input=await new Promise((resolveInput,reject)=>{
  let value='';
  const finish=()=>{process.stdin.off('data',onData);if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();resolveInput(value);};
  const onData=chunk=>{
    value+=chunk;
    if(value.length>65536 || value.includes('\u0003')) {reject(new Error('Configuration input cancelled'));process.stdin.destroy();return;}
    if(value.includes('\n'))finish();
  };
  if(process.stdin.isTTY) {process.stdin.setRawMode(true);process.stderr.write('Ready for gateway configuration on hidden stdin.\n');}
  process.stdin.setEncoding('utf8');process.stdin.on('data',onData);process.stdin.once('end',finish);process.stdin.resume();
});
const config=JSON.parse(input);
if(!config.bridgeUrl || !config.bridgeToken)throw new Error('bridgeUrl and bridgeToken required');
const directory=resolve('.runtime');
await mkdir(directory,{recursive:true,mode:0o700});
await writeFile(resolve(directory,'gateway.json'),JSON.stringify({...config,runtimeDir:directory},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log('Gateway configuration saved with private file permissions.');
