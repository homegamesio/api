'use strict';
// Tests the actual deployed game/runtime/API with relay forced in both browsers.
// No shared TURN secret is needed: credentials come from normal invitations.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const site=process.env.TURN_TEST_SITE||'https://homegames.io';
const modes=(process.env.TURN_TEST_MODES||'udp,tcp,tls').split(',');
const soakMs=Number(process.env.TURN_TEST_SOAK_MS||5000);
assert(Number.isInteger(soakMs)&&soakMs>=5000&&soakMs<=60000,'TURN_TEST_SOAK_MS must be 5000–60000');
assert(modes.length&&modes.every(m=>['udp','tcp','tls'].includes(m)),'TURN_TEST_MODES must contain udp,tcp,tls');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'homegames-turn-browser-'));
const report={at:new Date().toISOString(),site,checks:[],errors:[],failures:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const saveReport=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
async function instrument(context,mode){
 context.on('page',p=>{p.setDefaultTimeout(20000);p.on('pageerror',e=>report.errors.push({mode,message:e.message}));});
 await context.addInitScript(mode=>{
  window.turnPeers=[];window.turnLabels=[];window.turnAudio=0;
  const Original=window.RTCPeerConnection;
  window.RTCPeerConnection=class extends Original{
   constructor(config){
    const match=url=>mode==='tls'?/^turns:/.test(url):/^turn:/.test(url)&&(mode==='tcp'?/\?transport=tcp$/.test(url):!url.includes('?')||/\?transport=udp$/.test(url));
    const servers=(config?.iceServers||[]).map(s=>({...s,urls:[].concat(s.urls||[]).filter(match)})).filter(s=>s.urls.length);
    if(!servers.length)throw Error('No TURN '+mode+' URL advertised by the API');
    super({...config,iceServers:servers,iceTransportPolicy:'relay'});window.turnPeers.push(this);
   }
  };
  const clear=CanvasRenderingContext2D.prototype.clearRect,draw=CanvasRenderingContext2D.prototype.fillText,start=AudioBufferSourceNode.prototype.start;
  CanvasRenderingContext2D.prototype.clearRect=function(...a){window.turnLabels=[];return clear.apply(this,a);};
  CanvasRenderingContext2D.prototype.fillText=function(t,...a){window.turnLabels.push(String(t));return draw.call(this,t,...a);};
  AudioBufferSourceNode.prototype.start=function(...a){window.turnAudio++;return start.apply(this,a);};
 },mode);
}
async function gameFrame(page){const end=Date.now()+45000;while(Date.now()<end){for(const frame of page.frames())if(await frame.evaluate(()=>window.turnLabels?.includes('DRUMS')).catch(()=>false))return frame;await sleep(100);}throw Error('House Band did not render');}
async function tap(frame,x,y){const b=await frame.locator('canvas').first().boundingBox();await frame.page().touchscreen.tap(b.x+b.width*x/100,b.y+b.height*y/100);await sleep(150);}
async function stats(page){const peers=[];for(const frame of page.frames())peers.push(...await frame.evaluate(async()=>Promise.all((window.turnPeers||[]).filter(p=>p.connectionState!=='closed').map(async pc=>{
 const values=await pc.getStats(),transport=[...values.values()].find(s=>s.type==='transport'&&s.selectedCandidatePairId),pair=values.get(transport?.selectedCandidatePairId),local=values.get(pair?.localCandidateId),remote=values.get(pair?.remoteCandidateId);
 const channels=[...values.values()].filter(s=>s.type==='data-channel').map(s=>({state:s.state,bytesSent:s.bytesSent,bytesReceived:s.bytesReceived,messagesSent:s.messagesSent,messagesReceived:s.messagesReceived}));
 return{state:pc.connectionState,policy:pc.getConfiguration().iceTransportPolicy,localType:local?.candidateType,remoteType:remote?.candidateType,relayProtocol:local?.relayProtocol,url:local?.url,bytesSent:pair?.bytesSent,bytesReceived:pair?.bytesReceived,channels,dataBytesSent:channels.reduce((n,c)=>n+(c.bytesSent||0),0),dataBytesReceived:channels.reduce((n,c)=>n+(c.bytesReceived||0),0)};
}))).catch(()=>[]));return peers;}
async function diagnostics(page){return !page||page.isClosed()?null:{peers:await stats(page),frames:await Promise.all(page.frames().map(f=>f.evaluate(()=>({labels:window.turnLabels,audio:window.turnAudio,status:document.getElementById('status')?.textContent})).catch(()=>null)))};}
(async()=>{
 console.log('Artifacts:',output);
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=browser.version();
 try{for(const mode of modes){let hostContext,guestContext,host,guest,stage='load host';
  const step=value=>{stage=value;console.log(new Date().toISOString()+' '+mode+': '+value);};
  try{
   step(stage);
   hostContext=await browser.newContext({viewport:{width:1000,height:900},hasTouch:true});guestContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
   await instrument(hostContext,mode);await instrument(guestContext,mode);
   host=await hostContext.newPage();await host.goto(site+'/play.html?game=house-band');const frame=await gameFrame(host);
   // Each device needs its own canvas gesture to unlock browser audio. An
   // invitation-dialog click alone does not unlock the host's audio context.
   step('unlock host audio');await tap(frame,18,19);await frame.waitForFunction(()=>window.turnAudio>5);await tap(frame,18,19);await frame.waitForFunction(()=>window.turnLabels.includes('PLAY'));
   const hostAudioBefore=await frame.evaluate(()=>window.turnAudio);
   step('invite and join');
   await host.getByRole('button',{name:'Invite',exact:true}).click({delay:100});const invite=await frame.getByRole('textbox',{name:'Invitation link'}).inputValue();await frame.getByRole('button',{name:'Done',exact:true}).click();
   guest=await guestContext.newPage();await guest.goto(invite);let remote=await gameFrame(guest);
   step('guest input and both devices audio');await tap(remote,25,8);await remote.waitForFunction(()=>window.turnLabels.includes('SOUND ON'));await tap(remote,18,19);await frame.waitForFunction(before=>window.turnLabels.includes('PAUSE')&&window.turnAudio>before+5,hostAudioBefore);await remote.waitForFunction(()=>window.turnAudio>5);
   step('selected relay pairs and sustained traffic');
   const before=await stats(guest);await sleep(soakMs);const hostPeers=await stats(host),guestPeers=await stats(guest);
   // Candidate-pair counters can reset/change as ICE selects another pair.
   // Data-channel counters establish real application traffic across switches;
   // the selected pair and relay-only policy independently prove the route.
   for(const p of [...hostPeers,...guestPeers]){assert.equal(p.state,'connected');assert.equal(p.policy,'relay');assert.equal(p.localType,'relay');assert.equal(p.remoteType,'relay');assert(p.dataBytesSent>0&&p.dataBytesReceived>0);assert.equal(p.relayProtocol,mode);}
   assert(hostPeers.length>0&&guestPeers.length>0);assert(guestPeers[0].dataBytesReceived>before[0].dataBytesReceived,'Sustained frame traffic');
   step('guest pauses and rejoins');await tap(remote,18,19);await frame.waitForFunction(()=>window.turnLabels.includes('PLAY'));
   await guest.screenshot({path:path.join(output,mode+'-guest.png')});await guest.reload();remote=await gameFrame(guest);
   const rejoin=await stats(guest);assert(rejoin.some(p=>p.state==='connected'&&p.localType==='relay'&&p.remoteType==='relay'));
   step('host closes');await host.close();await guest.locator('#status').filter({hasText:/host disconnected/i}).waitFor();
   report.checks.push({mode,hostPeers,guestPeers,inputAudio:true,sustainedFrames:true,soakMs,rejoin:true,hostClosure:true});console.log('PASS forced TURN:',mode);
  }catch(e){report.failures.push({mode,stage,message:e.message,host:await diagnostics(host),guest:await diagnostics(guest)});console.error('FAIL',mode,stage,e.message);}
  finally{saveReport();await guestContext?.close();await hostContext?.close();}
 }}finally{await browser.close();saveReport();}
 if(report.errors.length||report.failures.length)process.exitCode=1;
 console.log(JSON.stringify({passed:report.checks.map(c=>c.mode),errors:report.errors,failures:report.failures},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
