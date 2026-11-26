/* OMP STORM — CYCLONE v2. Directed handoffs, receiver response, title shimmer. */
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const roots=[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||process.cwd(),__dirname];
const {createCanvas,loadImage,GlobalFonts}=require(require.resolve('@napi-rs/canvas',{paths:roots}));
const sharp=require(require.resolve('sharp',{paths:roots}));
const W=1600,H=600,FPS=30,SECONDS=8,TAU=Math.PI*2;
const OUT=path.join(__dirname,'output');fs.mkdirSync(OUT,{recursive:true});
GlobalFonts.registerFromPath(path.join(__dirname,'assets','NimbusSans-Bold.otf'),'Storm Display');
GlobalFonts.registerFromPath(path.join(__dirname,'assets','NimbusSans-Regular.otf'),'Storm Text');
const canvas=createCanvas(W,H),ctx=canvas.getContext('2d');
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v)),mix=(a,b,t)=>a+(b-a)*t,mod=(v,m)=>(v%m+m)%m;
const smooth=(a,b,x)=>{x=clamp((x-a)/(b-a));return x*x*(3-2*x);};
const rgba=(c,a)=>`rgba(${c[0]},${c[1]},${c[2]},${clamp(a)})`;
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
const random=rng(98524),WHITE=[226,243,244],ICE=[139,204,219],SIGNAL=[170,226,241],REPLY=[192,199,241];
const CX=1090,CY=302,RX=520,RY=300,TILT=-.105;
const brands=['openai','claude','gemini','grok','deepseek','qwen'].map((id,i)=>({id,i,image:null,glow:null}));
const noiseSize=512,noise=new Float32Array(noiseSize*noiseSize);
function noiseGrid(n){let a=new Float32Array(n*n);for(let i=0;i<a.length;i++)a[i]=random();return a;}
const grids=[8,16,32,64,128].map(n=>({n,a:noiseGrid(n)}));
function gridSample(a,n,x,y){let ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy);const x0=mod(ix,n),x1=(x0+1)%n,y0=mod(iy,n),y1=(y0+1)%n;return mix(mix(a[y0*n+x0],a[y0*n+x1],fx),mix(a[y1*n+x0],a[y1*n+x1],fx),fy);}
for(let y=0;y<noiseSize;y++)for(let x=0;x<noiseSize;x++){let value=0,weight=0,amp=1;for(const g of grids){value+=amp*gridSample(g.a,g.n,x*g.n/noiseSize,y*g.n/noiseSize);weight+=amp;amp*=.57;}noise[y*noiseSize+x]=value/weight;}
function sample(x,y){let ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;ix&=511;iy&=511;const nx=(ix+1)&511,ny=(iy+1)&511;return mix(mix(noise[iy*512+ix],noise[iy*512+nx],fx),mix(noise[ny*512+ix],noise[ny*512+nx],fx),fy);}
const CW=800,CH=300,cloudCanvas=createCanvas(CW,CH),cloudCtx=cloudCanvas.getContext('2d');
const cloudPixels=cloudCtx.createImageData(CW,CH),fields=[];
for(let y=0;y<CH;y++)for(let x=0;x<CW;x++){
 const dx=x*2-CX,dy=y*2-CY;
 const xx=(dx*Math.cos(TILT)+dy*Math.sin(TILT))/RX,yy=(-dx*Math.sin(TILT)+dy*Math.cos(TILT))/RY;
 const r=Math.hypot(xx,yy),a=Math.atan2(yy,xx),spiral=a+1.2*Math.log(r+.13);
 const envelope=smooth(.13,.30,r)*(1-smooth(.95,1.50,r))*smooth(535,735,x*2);
 fields.push({r,a,c:Math.cos(spiral),s:Math.sin(spiral),ac:Math.cos(3*a+5.8*Math.log(r+.13)),as:Math.sin(3*a+5.8*Math.log(r+.13)),e:envelope,shade:1.06-.17*yy});
}
const grit=Array.from({length:450},()=>({a:random()*TAU,r:.27+Math.pow(random(),.7)*1.13,w:.4+random()*.85,alpha:.035+random()*.17,turns:random()<.18?2:1,tail:.004+random()*.013}));
const fibers=Array.from({length:58},(_,i)=>({r:.27+random()*.93,a:random()*TAU,len:.4+random()*1.0,width:i%9===0?1.0:.45,alpha:.025+random()*.06,bend:.03+random()*.16}));
function project(r,a){const x=RX*r*Math.cos(a),y=RY*r*Math.sin(a);return{x:CX+x*Math.cos(TILT)-y*Math.sin(TILT),y:CY+x*Math.sin(TILT)+y*Math.cos(TILT)};}
function ringRadius(a,p){return .77+.045*Math.sin(a*3+TAU*p)+.018*Math.cos(a*2-TAU*p);}
function node(i,p){const a=TAU*(p+i/6)-.5,r=ringRadius(a,p),q=project(r,a);return{...q,a,depth:(Math.sin(a)+1)/2};}
function glow(x,y,r,c,a,sy=1){ctx.save();ctx.translate(x,y);ctx.scale(1,sy);const g=ctx.createRadialGradient(0,0,0,0,0,r);g.addColorStop(0,rgba(c,a));g.addColorStop(.20,rgba(c,a*.5));g.addColorStop(1,rgba(c,0));ctx.fillStyle=g;ctx.fillRect(-r,-r,r*2,r*2);ctx.restore();}
function line(points,c,a,width){ctx.beginPath();for(let i=0;i<points.length;i++)i?ctx.lineTo(points[i].x,points[i].y):ctx.moveTo(points[i].x,points[i].y);ctx.strokeStyle=rgba(c,a);ctx.lineWidth=width;ctx.stroke();}
function pulse(p,at,dur){let q=mod(p-at,1);return q<dur?Math.sin(Math.PI*q/dur)**2:0;}
function renderClouds(p){
 const t=TAU*p,co=Math.cos(t),si=Math.sin(t),co2=Math.cos(2*t),si2=Math.sin(2*t);
 const flash=pulse(p,.20,.042)*.08+pulse(p,.715,.035)*.05;
 const data=cloudPixels.data;
 for(let i=0;i<fields.length;i++){
  const f=fields[i],j=i*4;
  if(f.e<.0001){data[j]=4;data[j+1]=8;data[j+2]=12;data[j+3]=255;continue;}
  const rr=f.r*181;
  const n=sample((f.c*co-f.s*si)*rr+256,(f.s*co+f.c*si)*rr+256);
  const detail=sample((f.c*co2+f.s*si2)*rr*2.8+88,(f.s*co2-f.c*si2)*rr*2.8+139);
  const arm=Math.pow(.5+.5*(f.ac*co-f.as*si),2.0);
  const raw=clamp((n*.65+detail*.35-.34)*2.8);
  const ridge=clamp((detail-.47)*4)*Math.pow(raw,1.6);
  const density=(Math.pow(raw,1.55)*(.40+.60*arm)+ridge*.13)*f.e*f.shade;
  const edge=Math.exp(-Math.pow((f.r-.30)/.09,2))*(.35+.65*raw)*f.e;
  const br=clamp(density*1.30+edge*.035+flash*f.e);
  data[j]=4+br*173;data[j+1]=8+br*194;data[j+2]=12+br*203;data[j+3]=255;
 }
 cloudCtx.putImageData(cloudPixels,0,0);ctx.drawImage(cloudCanvas,0,0,W,H);
}
function atmosphere(p){
 ctx.save();ctx.globalCompositeOperation='screen';
 glow(CX-90,CY-90,410,ICE,.07,.52);
 for(const f of fibers){const pts=[];for(let k=0;k<=70;k++){const u=k/70,a=f.a+TAU*p-u*f.len,r=f.r+f.bend*u;pts.push(project(r,a));}line(pts,WHITE,f.alpha,f.width);}
 for(const g of grit){const a=g.a+TAU*p*g.turns,r=g.r+.013*Math.sin(a*3+TAU*p);const q=project(r,a),q0=project(r+.002,a-g.tail);const protect=smooth(555,720,q.x);line([q0,q],g.r<.7?ICE:WHITE,g.alpha*protect,g.w);}
 ctx.restore();
}
function trackPoint(from,to,u,p){
 const a=TAU*(p+from/6)-.5,delta=(to-from)*TAU/6,ang=a+delta*u;
 const r=ringRadius(ang,p)-.12*Math.sin(Math.PI*u);
 return project(r,ang);
}
const TRANSIT=.78;
function flowInfo(p,offset,reverse=false){
 const q=mod(p*6+offset,6),leg=Math.floor(q),part=q-leg;
 const from=reverse?mod(6-leg,6):leg,to=reverse?from-1:from+1;
 const arrival=smooth(TRANSIT-.035,TRANSIT+.012,part)*(1-smooth(TRANSIT+.065,1,part));
 const launch=part<.17?Math.sin(Math.PI*part/.17)**2:0;
 return{from,to,part,u:smooth(0,TRANSIT,part),active:part<TRANSIT,arrival,launch,color:reverse?REPLY:SIGNAL};
}
function workFlows(p){return[flowInfo(p,.02),flowInfo(p,3.02),flowInfo(p,1.2,true)];}
function routePosition(f,u,p){
 // Trim the path at the glyphs' rims, leaving the receiver itself to show arrival.
 return trackPoint(f.from,f.to,mix(.085,.915,u),p);
}
function drawSignalHead(q,before,c,strength){
 const angle=Math.atan2(q.y-before.y,q.x-before.x);
 glow(q.x,q.y,35,c,.38*strength);
 ctx.save();ctx.translate(q.x,q.y);ctx.rotate(angle);
 ctx.fillStyle=rgba(WHITE,strength);
 ctx.beginPath();ctx.ellipse(0,0,5.4,2.9,0,0,TAU);ctx.fill();
 ctx.fillStyle=rgba([255,255,255],strength);ctx.beginPath();ctx.arc(1.6,0,2.25,0,TAU);ctx.fill();
 ctx.restore();
}
function signals(p){
 const flows=workFlows(p);
 ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
 for(const f of flows){
  const pts=[];for(let k=0;k<=70;k++)pts.push(routePosition(f,k/70,p));
  const energy=f.active?smooth(0,.10,f.part):1-smooth(TRANSIT,1,f.part);
  ctx.globalCompositeOperation='source-over';line(pts,[1,6,10],.24*energy,5.8);
  ctx.globalCompositeOperation='screen';
  line(pts,f.color,.10+.15*energy,1.6);
  if(!f.active)continue;
  const power=smooth(0,.055,f.part)*(1-smooth(TRANSIT-.015,TRANSIT+.005,f.part));
  // The tapered wake follows the same curved stream; the bright head has direction.
  for(let k=0;k<28;k++){
   const z=k/27,u0=Math.max(0,f.u-.28+k*.28/28),u1=Math.max(0,f.u-.28+(k+1)*.28/28);
   const seg=[routePosition(f,u0,p),routePosition(f,u1,p)];
   line(seg,f.color,z*.30*power,3.3+z*3.8);
   line(seg,WHITE,Math.pow(z,1.3)*.96*power,.6+z*3.4);
  }
  const q=routePosition(f,f.u,p),before=routePosition(f,Math.max(0,f.u-.018),p);
  drawSignalHead(q,before,f.color,power);
 }
 ctx.restore();return flows;
}
function logos(p,flows){
 const nodes=brands.map(b=>({b,n:node(b.i,p)})).sort((a,b)=>a.n.depth-b.n.depth);
 for(const {b,n} of nodes){
  let hit=0,launch=0,receiveColor=ICE;
  for(const f of flows){
   if(mod(f.to,6)===b.i&&f.arrival>hit){hit=f.arrival;receiveColor=f.color;}
   if(mod(f.from,6)===b.i)launch=Math.max(launch,f.launch);
  }
  const size=(45+17*n.depth)*(1+.075*hit+.025*launch);
  ctx.save();
  glow(n.x,n.y,58,[1,5,8],.77);ctx.globalCompositeOperation='screen';
  glow(n.x,n.y,54+14*hit,receiveColor,.065+.32*hit+.11*launch);
  if(hit>.01){
   // A short wind-shaped afterglow expands into the local current after receipt.
   const arc=[];for(let j=0;j<=34;j++){const u=j/34,ang=n.a-.09+u*.22,rad=ringRadius(ang,p)+.065+.026*(1-hit);arc.push(project(rad,ang));}
   line(arc,receiveColor,hit*.52,1.8);
  }
  ctx.globalAlpha=.79+.21*n.depth;
  ctx.drawImage(b.image,n.x-size/2,n.y-size/2,size,size);
  if(hit>.01||launch>.01){ctx.globalAlpha=hit*.58+launch*.15;ctx.drawImage(b.white,n.x-size/2,n.y-size/2,size,size);}
  ctx.restore();
 }
}
let titleLayer;
function frame(p){ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.clearRect(0,0,W,H);renderClouds(p);atmosphere(p);const flows=signals(p);logos(p,flows);titleLayer.draw(ctx,p);return canvas;}
async function load(){
 for(const b of brands){
  let svg=fs.readFileSync(path.join(__dirname,'assets',b.id+'.svg'),'utf8').replaceAll('1em','256').replaceAll('currentColor','#edf2f4');
  const png=await sharp(Buffer.from(svg)).png().toBuffer();b.image=await loadImage(png);
  const whiteCanvas=createCanvas(256,256),whiteCtx=whiteCanvas.getContext('2d');
  whiteCtx.drawImage(b.image,0,0,256,256);whiteCtx.globalCompositeOperation='source-in';whiteCtx.fillStyle='#effbff';whiteCtx.fillRect(0,0,256,256);b.white=whiteCanvas;
 }
 const{createTitleLayer}=require('./title-effect.cjs');titleLayer=createTitleLayer({createCanvas,width:W,height:H});
}
async function main(){
 await load();
 for(const [i,p]of [0,.08,.16,.25,.32,.41,.58,.75,.85,.96].entries())fs.writeFileSync(path.join(OUT,`frame-${i}.png`),frame(p).toBuffer('image/png'));
 fs.writeFileSync(path.join(OUT,'poster.png'),frame(.32).toBuffer('image/png'));
 // The renderer uses only integer-period trigonometric time: f(0) === f(1).
 const zero=Buffer.from(frame(0).getContext('2d').getImageData(0,0,W,H).data),one=Buffer.from(frame(1).getContext('2d').getImageData(0,0,W,H).data);
 let sum=0,max=0;for(let i=0;i<zero.length;i++){let d=Math.abs(zero[i]-one[i]);sum+=d;max=Math.max(max,d);}
 const validation={loopMeanAbsoluteDifference:sum/zero.length,loopMaximumDifference:max,titleEffect:!!titleLayer};
 fs.writeFileSync(path.join(OUT,'render-validation.json'),JSON.stringify(validation,null,2)+'\n');console.log(JSON.stringify(validation));
 if(process.argv.includes('--preview'))return;
 // --frames <dir> [--fps N]: write one PNG per frame at phase i/count, so a different frame rate
 // samples the loop evenly (no dropped-frame judder) and the last frame still leads into frame 0.
 const fi=process.argv.indexOf('--frames');
 if(fi>0){
  const dir=path.resolve(process.argv[fi+1]),pi=process.argv.indexOf('--fps'),fps=pi>0?Number(process.argv[pi+1]):FPS,count=Math.round(fps*SECONDS);
  if(!(count>0))throw Error('bad --fps');
  fs.mkdirSync(dir,{recursive:true});
  for(let i=0;i<count;i++)fs.writeFileSync(path.join(dir,`f${String(i).padStart(4,'0')}.png`),frame(i/count).toBuffer('image/png'));
  console.log(`CYCLONE wrote ${count} frames at ${fps}fps to ${dir}`);return;
 }
 const ff=spawn('ffmpeg',['-y','-hide_banner','-loglevel','warning','-f','rawvideo','-pixel_format','rgba','-video_size',`${W}x${H}`,'-framerate',String(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','slow','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart','-threads','2',path.join(OUT,'storm-cyclone.mp4')],{stdio:['pipe','inherit','inherit']});
 const done=new Promise((resolve,reject)=>{ff.on('error',reject);ff.on('exit',n=>n===0?resolve():reject(Error(`ffmpeg ${n}`)));});
 for(let i=0;i<FPS*SECONDS;i++){const data=frame(i/(FPS*SECONDS)).getContext('2d').getImageData(0,0,W,H).data;if(!ff.stdin.write(Buffer.from(data.buffer,data.byteOffset,data.byteLength)))await new Promise(resolve=>ff.stdin.once('drain',resolve));if(i%30===0)console.log(`CYCLONE ${i}/${FPS*SECONDS}`);}
 ff.stdin.end();await done;console.log('CYCLONE video ready');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
