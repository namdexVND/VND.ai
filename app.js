const KW=new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
const EV=new Set(['end','nil','true','false']);
const BIN=new Set('and or in then do else elseif end until'.split(' '));
const R={w:/[A-Za-z_][A-Za-z0-9_]*/y,n:/0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y,o:/\.\.\.|\.\.=|\/\/=|[+\-*\/%^]=|\.\.|==|~=|<=|>=|\/\/|::|->|[\s\S]/y};

function lex(s){
  const tk=[],n=s.length;let i=0,ws=false;
  while(i<n){
    const c=s[i];
    if(c===' '||c==='\t'||c==='\n'||c==='\r'){ws=true;i++;continue}
    let j;
    if(c==='-'&&s[i+1]==='-'){
      const m=/^--\[(=*)\[/.exec(s.substr(i,40));
      if(m){const e=']'+m[1]+']';j=s.indexOf(e,i+m[0].length);j=j<0?n:j+e.length}
      else{j=s.indexOf('\n',i);if(j<0)j=n}
      tk.push({t:'c',v:s.slice(i,j),ws});i=j;ws=false;continue}
    if(c==='"'||c==="'"){
      j=i+1;while(j<n&&s[j]!==c){if(s[j]==='\\')j++;j++}j++;
      tk.push({t:'s',v:s.slice(i,j),ws});i=j;ws=false;continue}
    if(c==='['){
      const m=/^\[(=*)\[/.exec(s.substr(i,40));
      if(m){const e=']'+m[1]+']';j=s.indexOf(e,i+m[0].length);j=j<0?n:j+e.length;
        tk.push({t:'s',v:s.slice(i,j),ws});i=j;ws=false;continue}}
    for(const k of ['w','n','o']){
      R[k].lastIndex=i;const m=R[k].exec(s);
      if(m){tk.push({t:k,v:m[0],ws});i+=m[0].length;break}}
    ws=false;
  }
  return tk;
}

function parseStr(v){
  if(v[0]==='['){const m=/^\[(=*)\[/.exec(v);let b=v.slice(m[0].length,v.length-m[0].length);if(b[0]==='\n')b=b.slice(1);return b}
  const body=v.slice(1,-1),by=[],te=new TextEncoder();
  for(let i=0;i<body.length;){
    const c=body[i];
    if(c!=='\\'){const cp=body.codePointAt(i);by.push(...te.encode(String.fromCodePoint(cp)));i+=cp>0xffff?2:1;continue}
    const d=body[i+1];i+=2;
    if(d===undefined)return null;
    if(/\d/.test(d)){let k=d;while(k.length<3&&/\d/.test(body[i]||'')){k+=body[i++]}const x=+k;if(x>255)return null;by.push(x)}
    else if(d==='x'){const x=parseInt(body.substr(i,2),16);if(isNaN(x))return null;by.push(x);i+=2}
    else if(d==='u'){const m=/^\{([0-9a-fA-F]+)\}/.exec(body.slice(i));if(!m)return null;by.push(...te.encode(String.fromCodePoint(parseInt(m[1],16))));i+=m[0].length}
    else if(d==='z'){while(i<body.length&&/\s/.test(body[i]))i++}
    else{const map={n:10,t:9,r:13,a:7,b:8,f:12,v:11,'\\':92,'"':34,"'":39,'\n':10};if(!(d in map))return null;by.push(map[d])}
  }
  try{return new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(by))}catch(e){return null}
}
function quote(s){
  let o='"';
  for(const ch of s){
    const c=ch.codePointAt(0);
    if(ch==='"')o+='\\"';else if(ch==='\\')o+='\\\\';else if(ch==='\n')o+='\\n';else if(ch==='\r')o+='\\r';else if(ch==='\t')o+='\\t';
    else if(c<32||c===127)o+='\\'+String(c).padStart(3,'0');else o+=ch;
  }
  return o+'"';
}
function btl(codes){try{return quote(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(codes)))}catch(e){return null}}

function fold(tk,info){
  for(const x of tk)if(x.t==='s'&&x.v[0]!=='['){
    const p=parseStr(x.v);
    if(p!==null){const q=quote(p);if(q!==x.v){if(x.v.includes('\\'))info.strs++;x.v=q}}
  }
  for(let pass=0;pass<8;pass++){
    let ch=false;const o=[];
    for(let i=0;i<tk.length;i++){
      const a=tk[i],b=tk[i+1],c=tk[i+2],d=tk[i+3],pv=o[o.length-1];
      if(a.v==='string'&&b&&b.v==='.'&&c&&c.v==='char'&&d&&d.v==='('&&!(pv&&(pv.v==='.'||pv.v===':'))){
        let j=i+4;const codes=[];
        while(tk[j]&&tk[j].t==='n'&&/^\d+$/.test(tk[j].v)){codes.push(+tk[j].v);j++;if(tk[j]&&tk[j].v===',')j++;else break}
        if(codes.length&&tk[j]&&tk[j].v===')'&&codes.every(x=>x<256)){
          const s=btl(codes);
          if(s){o.push({t:'s',v:s,ws:a.ws});i=j;ch=true;info.folds++;continue}}
      }
      if(a.t==='s'&&a.v[0]!=='['&&b&&b.v==='..'&&c&&c.t==='s'&&c.v[0]!=='['&&!(d&&['.',':','[','('].includes(d.v))){
        const x=parseStr(a.v),y=parseStr(c.v);
        if(x!==null&&y!==null){o.push({t:'s',v:quote(x+y),ws:a.ws});i+=2;ch=true;info.folds++;continue}
      }
      if(a.t==='n'&&/^0[xX]/.test(a.v)&&Number(a.v)<=9007199254740991){o.push({t:'n',v:String(Number(a.v)),ws:a.ws});ch=true;continue}
      if(a.v==='('&&b&&b.t==='n'&&/^\d+$/.test(b.v)&&c&&['+','-','*'].includes(c.v)&&d&&d.t==='n'&&/^\d+$/.test(d.v)&&tk[i+4]&&tk[i+4].v===')'&&(!pv||(pv.t==='o'&&!')]}'.includes(pv.v)))){
        const x=+b.v,y=+d.v,r=c.v==='+'?x+y:c.v==='-'?x-y:x*y;
        if(Number.isSafeInteger(r)){o.push({t:'n',v:r<0?'('+r+')':String(r),ws:a.ws});i+=4;ch=true;info.folds++;continue}
      }
      o.push(a);
    }
    tk=o;if(!ch)break;
  }
  return tk;
}

function looksLua(s){
  if(s.length<6)return false;
  let p=0;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c===9||c===10||c===13||(c>=32&&c<127))p++}
  return p/s.length>0.9;
}
function wholePayload(tk){
  const a=tk.filter(x=>x.t!=='c');let i=0;
  if(a[0]&&a[0].v==='return')i++;
  if(!a[i]||!['loadstring','load'].includes(a[i].v)||!a[i+1]||a[i+1].v!=='('||!a[i+2]||a[i+2].t!=='s'||!a[i+3]||a[i+3].v!==')')return null;
  let j=i+4;if(a[j]&&a[j].v==='('&&a[j+1]&&a[j+1].v===')')j+=2;
  if(j!==a.length)return null;
  let v=parseStr(a[i+2].v);if(v===null)return null;
  if(/^[A-Za-z0-9+\/=\s]{40,}$/.test(v)){try{const d=atob(v.replace(/\s/g,''));if(looksLua(d))return d}catch(e){}}
  return looksLua(v)?v:null;
}

function detect(s){
  const h=s.slice(0,600);
  if(/ironbrew/i.test(h)||/^\s*(--[^\n]*\n\s*)*return\s*\(\s*function\(a,b,c,d,e,f,g,h,i,j/.test(h))return{n:'IronBrew 1',vm:1};
  if(/luraph/i.test(h)||/LPH[~!$#]/.test(s.slice(0,4000)))return{n:'Luraph',vm:1};
  if(/moonsec/i.test(h))return{n:'MoonSec',vm:1};
  if(/prometheus/i.test(h))return{n:'Prometheus',vm:0};
  if(/wearedevs/i.test(h))return{n:'WeAreDevs',vm:0};
  return{n:'Không rõ',vm:0};
}

function report(tk){
  const urls=new Set(),cnt={};
  const SUS=['loadstring','HttpGet','getfenv','setfenv','require','request','http_request','setclipboard','writefile','Kick','FireServer'];
  for(const x of tk){
    if(x.t==='s'){const s=parseStr(x.v);if(s)(s.match(/https?:\/\/[^\s"'<>]+/g)||[]).forEach(u=>urls.add(u))}
    else if(x.t==='w'&&SUS.includes(x.v))cnt[x.v]=(cnt[x.v]||0)+1;
  }
  return{urls:[...urls].slice(0,25),cnt};
}

const VE=p=>p.t==='n'||p.t==='s'||(p.t==='w'&&(!KW.has(p.v)||EV.has(p.v)))||[')',']','}','...'].includes(p.v);
const STARTERS=new Set(['local','return','break','while','for','repeat']);
const sbreak=(p,t)=>STARTERS.has(t.v)||(VE(p)&&t.t!=='s'&&((t.t==='w'&&!BIN.has(t.v))||t.t==='n'));
const SPO=new Set(['=','==','~=','<=','>=','<','>','..','+','*','/','%','^','+=','-=','*=','/=','..=','//','//=','%=','^=']);
function space(p,t){
  const a=p.v,b=t.v;
  if([',',')',']','}','.',':',';'].includes(b))return '';
  if(['(','[','.',':','#','{','::'].includes(a))return '';
  if(a===',')return ' ';
  if(SPO.has(a)||SPO.has(b))return ' ';
  const wp=p.t==='w'||p.t==='n'||p.t==='s',wt=t.t==='w'||t.t==='n'||t.t==='s';
  if(wp&&wt)return ' ';
  if(p.t==='w'&&KW.has(a)&&!EV.has(a)&&a!=='function'&&['(','{','-','#','['].includes(b))return ' ';
  return t.ws?' ':'';
}
function beautify(tk){
  const L=[];let cur='',ind=0,ci=0,dd=0,hang=0,depth=0,pv=null;
  const out=()=>{if(cur.trim())L.push('\t'.repeat(ci)+cur);cur=''};
  const flush=()=>{out();hang=0;dd=0};
  for(let i=0;i<tk.length;i++){
    const t=tk[i],v=t.v;
    if(t.t==='c'){flush();L.push('\t'.repeat(ind)+v);pv=null;continue}
    if(v===';'&&depth===0){flush();pv=null;continue}
    if(v==='end'||v==='until'){ind=Math.max(0,ind-1);flush()}
    else if(v==='else'||v==='elseif'){flush();dd=1}
    else if(pv&&sbreak(pv,t))flush();
    const sp=cur&&pv?space(pv,t):'';
    if(!cur)ci=Math.max(0,ind-dd)+hang;
    cur+=sp+v;
    if(v==='('||v==='{'||v==='[')depth++;else if(v===')'||v==='}'||v===']')depth=Math.max(0,depth-1);
    if(v==='function'||v==='if'||v==='repeat'||v==='do')ind++;
    if(v==='do'||v==='then'||v==='repeat'||v==='else')flush();
    else if(v==='end'){
      const n=tk[i+1];
      if(!n||!/^(\)|,|\}|\]|\.|:|\(|\[|==|~=|<|>|\+|-|\*|\/|\.\.|and|or|end|until|else|elseif)$/.test(n.v))flush();
    }
    if(v===','&&depth>0&&cur.length>110){out();hang=1}
    pv=t;
  }
  flush();
  return L.join('\n');
}

function run(src){
  const info={layers:0,strs:0,folds:0};
  const det=detect(src);
  let tk;
  for(let l=0;l<6;l++){
    tk=fold(lex(src),info);
    const p=wholePayload(tk);
    if(p===null)break;
    info.layers++;src=p;
  }
  const head='-- Giải mã bằng Lua Deobfuscator (web)\n-- Phát hiện: '+det.n+' | lớp loadstring đã gỡ: '+info.layers+' | chuỗi đã giải mã: '+info.strs+'\n\n';
  return{text:head+beautify(tk),det,info,rep:report(tk),inLen:src.length};
}

const $=id=>document.getElementById(id);
let outText='',baseName='script';

function chip(k,v){const d=document.createElement('div');d.className='chip';const b=document.createElement('b');b.textContent=k;d.append(b,String(v));return d}
function show(r,size){
  outText=r.text;$('out').value=outText;
  const chips=r.chips||[['Engine','Trình duyệt (tĩnh)'],['Obfuscator',r.det.n],['Kích thước vào',size+' B'],['Kích thước ra',outText.length+' B'],['Lớp loadstring gỡ',r.info.layers],['Chuỗi giải mã',r.info.strs],['Biểu thức rút gọn',r.info.folds]];
  $('stats').replaceChildren(...chips.map(c=>chip(c[0],c[1])));
  $('log').hidden=!r.log;$('logt').textContent=r.log||'';
  const w=$('warn');
  if(r.det.vm){w.hidden=false;w.textContent='Đây là obfuscator dùng máy ảo (VM). Trang này chỉ gỡ được lớp bề mặt (chuỗi, hằng số, định dạng lại code). Để khôi phục logic gốc, hãy dùng chế độ máy chủ (engine Luau VM chạy deob.py).'}
  else w.hidden=true;
  const ul=$('rep');ul.replaceChildren();
  const add=t=>{const li=document.createElement('li');li.textContent=t;ul.append(li)};
  r.rep.urls.forEach(u=>add((/discord(app)?\.com\/api\/webhooks/.test(u)?'[Webhook Discord] ':'URL: ')+u));
  Object.entries(r.rep.cnt).forEach(([k,v])=>add('Gọi '+k+' × '+v));
  if(!ul.children.length)add('Không thấy URL hay lệnh đáng ngờ rõ ràng.');
  $('res').hidden=false;$('res').scrollIntoView({behavior:'smooth'});
}
let serverOk=false;
const MAXUP=4000000;
fetch('/api/deob').then(r=>r.json()).then(d=>{serverOk=!!d.luau;$('eng').textContent=serverOk?'Engine máy chủ: sẵn sàng (Luau VM)':'Engine máy chủ: chưa có luau, chỉ dùng trình duyệt'}).catch(()=>{$('eng').textContent='Không có máy chủ: chỉ dùng trình duyệt'});
async function viaServer(src,mode){
  const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),295000);
  try{
    const r=await fetch('/api/deob?mode='+mode,{method:'POST',body:src,signal:ac.signal,headers:{'Content-Type':'text/plain'}});
    const d=await r.json().catch(()=>({error:'Phản hồi không hợp lệ ('+r.status+')'}));
    if(!r.ok||!d.ok){const e=new Error(d.error||('HTTP '+r.status));e.log=d.log;throw e}
    return d;
  }finally{clearTimeout(tm)}
}
function process(src,name){
  baseName=(name||'script').replace(/\.[^.]*$/,'')||'script';
  const mode=$('mode').value,msg=$('msg');
  setTimeout(async()=>{
    let note='';
    try{
      if(mode!=='local'&&serverOk&&src.length<MAXUP){
        msg.textContent='Đang chạy engine Luau trên máy chủ (có thể mất vài chục giây đến vài phút)...';
        try{
          const d=await viaServer(src,mode==='fast'?'fast':'full');
          const obf=d.obfuscator||'không rõ';
          show({text:d.text,det:{n:obf,vm:0},rep:report(lex(d.text)),log:d.log,
            chips:[['Engine','Server · Luau VM'],['Obfuscator',obf],['Thời gian',(d.ms/1000).toFixed(1)+' s'],['Kích thước vào',src.length+' B'],['Kích thước ra',d.text.length+' B']]},src.length);
          msg.textContent='';return;
        }catch(e){note='Server lỗi: '+e.message+'. Đã chuyển sang chế độ trình duyệt.'}
      }else if(mode!=='local'&&src.length>=MAXUP)note='File lớn hơn 4 MB nên dùng chế độ trình duyệt.';
      show(run(src),src.length);
      msg.textContent=note;
    }catch(e){msg.textContent='Lỗi khi xử lý: '+e.message}
  },30);
}
async function loadFile(file){if(file)process(await file.text(),file.name)}
$('f').onchange=e=>loadFile(e.target.files[0]);
const dz=$('drop');
['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('on')}));
['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('on')}));
dz.addEventListener('drop',e=>loadFile(e.dataTransfer.files[0]));
$('go').onclick=()=>{const s=$('in').value;if(s.trim())process(s,'script');else $('msg').textContent='Hãy dán code trước.'};
$('dl').onclick=()=>{
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([outText],{type:'text/plain;charset=utf-8'}));
  a.download=baseName+'.deobf.lua';
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
};
$('cp').onclick=async()=>{
  try{await navigator.clipboard.writeText(outText)}
  catch(e){const o=$('out');o.select();document.execCommand('copy')}
  $('cp').textContent='Đã sao chép';setTimeout(()=>{$('cp').textContent='Sao chép'},1500);
};
