/* ===== MODULES ===== */
const WebSocket = require("ws");
const fs = require("fs");
const https = require("https");
const mysql = require("mysql2/promise");
const express = require("express");
const http = require("http");
const socket = require("socket.io");

/* ===== DB CONFIG ===== */
const DB = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

let db;
let history = [];
let lastSum = 0;

/* ===== DATABASE INIT ===== */
async function dbInit(){
  db = await mysql.createPool(DB);

  await db.query(`
    CREATE TABLE IF NOT EXISTS iwin_v3_patterns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy VARCHAR(50),
      pkey VARCHAR(160),
      total INT DEFAULT 0,
      winT INT DEFAULT 0,
      winX INT DEFAULT 0,
      weight FLOAT DEFAULT 1,
      power FLOAT DEFAULT 1,
      last_update INT,
      INDEX(strategy),
      INDEX(pkey)
    )
  `);

  setInterval(()=>db.query("SELECT 1").catch(()=>{}),60000);
  console.log("DB READY");
}

/* ===== PATTERN ENGINE V3 ===== */
function buildV3Keys(history,sum,d1,d2,d3){
  const dice=[d1,d2,d3].sort((a,b)=>a-b).join("-");
  const last = history.at(-1)?.rs ?? null;

  const keys = [
    {s:"sum",k:`SUM:${sum}`},
    {s:"range",k:`R:${sum<=10?"LOW":"HIGH"}`},
    {s:"parity",k:`P:${sum%2}`},
    {s:"dice",k:`D:${dice}`}
  ];

  if(history.length>=6){
    const t=history.slice(-6).filter(x=>x.rs==="T").length;
    keys.push({s:"trend6",k:`T6:${t>=4?"T":"X"}`});
  }

  if(last){
    let len=1;
    for(let i=history.length-2;i>=0;i--){
      if(history[i].rs!==last) break;
      len++;
    }
    keys.push({s:"streakV3",k:`SV3:${last}:${len}`});
    keys.push({s:"hcombo",k:`HC:${last}:${sum%2}`});
  }

  return keys;
}

/* ===== LEARNING ENGINE ===== */
async function learnV3(history,sum,rs,d1,d2,d3){

  const keys=buildV3Keys(history,sum,d1,d2,d3);
  const isT=rs==="T"?1:0;
  const isX=rs==="X"?1:0;
  const now=Math.floor(Date.now()/1000);

  for(const f of keys){

    const [rows]=await db.query(
      `SELECT * FROM iwin_v3_patterns WHERE strategy=? AND pkey=?`,
      [f.s,f.k]
    );

    if(!rows.length){
      await db.query(`
        INSERT INTO iwin_v3_patterns(strategy,pkey,total,winT,winX,weight,power,last_update)
        VALUES (?,?,?,?,?,?,?,?)
      `,[f.s,f.k,1,isT,isX,1,1,now]);
    }
    else{
      const r=rows[0];

      const correct =
        (isT && r.winT>=r.winX) ||
        (isX && r.winX>=r.winT);

      let weight=r.weight*0.9 + (correct?0.5:-0.25);
      let power =r.power*0.94+ (correct?0.35:-0.2);

      await db.query(`
        UPDATE iwin_v3_patterns
        SET total=total+1,
            winT=winT+?,
            winX=winX+?,
            weight=GREATEST(0.1,?),
            power=GREATEST(0.1,?),
            last_update=?
        WHERE id=?
      `,[isT,isX,weight,power,now,r.id]);
    }
  }
}

/* ===== PREDICT ENGINE ===== */
async function predictV3(history,sum){

  const keys=buildV3Keys(history,sum,0,0,0);
  const votes=[];
  let risk=0;

  for(const f of keys){

    const [rows]=await db.query(`
      SELECT total,winT,winX,weight,power,
             winT/total AS rt,
             winX/total AS rx
      FROM iwin_v3_patterns
      WHERE strategy=? AND pkey=?`,
      [f.s,f.k]
    );

    if(!rows.length || rows[0].total<5) continue;

    const r=rows[0];
    const pick=r.rt>=r.rx?"T":"X";
    const conf=Math.max(r.rt,r.rx);

    const score = conf * r.weight * r.power;

    votes.push({pick,conf,score});

    if(conf<0.55) risk++;
  }

  if(!votes.length)
    return {pick:"T",conf:0.5,mode:"cold"};

  if(risk>=3)
    return {pick:"SKIP",conf:0,mode:"danger"};

  const sumScore=votes.reduce((m,v)=>(
    m[v.pick]=(m[v.pick]||0)+v.score,m),{});

  const best=Object.entries(sumScore).sort((a,b)=>b[1]-a[1])[0];
  const winner=best[0];

  const confAvg =
    votes.filter(v=>v.pick===winner)
         .reduce((t,v)=>t+v.conf,0)
    / votes.filter(v=>v.pick===winner).length;

  return {pick:winner,conf:confAvg,mode:"iwinV3"};
}

/* ===== WEB UI (NEON) ===== */
const app = express();
const server = http.createServer(app);
const io = socket(server);

app.get("/",(req,res)=>{
  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>IWIN MODEL V3 Dashboard</title>
<style>
*{box-sizing:border-box}
body{background:#030712;color:#c7f5ff;font-family:Segoe UI,Roboto,monospace;padding:20px}
h2{color:#7df9ff;margin-bottom:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{border:1px solid #1f3b52;background:linear-gradient(145deg,#071523,#04101a);border-radius:12px;padding:14px;box-shadow:0 0 14px #0b2b44 inset}
#predict{font-size:18px}
.badge{padding:4px 8px;border-radius:6px;font-weight:600}
.tai{background:#0c2f1d;color:#5dff9e}
.xiu{background:#2b0c17;color:#ffa4c4}
.skip{background:#332600;color:#ffec8a}
#log{max-height:520px;overflow-y:auto;line-height:1.45em}
.row{border-bottom:1px dashed #1c3444;padding:6px 0}
.sum{color:#9afcff}
.rsT{color:#5dff9e}
.rsX{color:#ff8aa8}
.time{color:#6b92aa}
</style>
</head>

<body>
<h2>IWIN MODEL V3 — Real-Time Dashboard</h2>

<div class="grid">
  <div class="card"><div id="predict">Đang chờ dữ liệu…</div></div>
  <div class="card"><div id="log"></div></div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const s = io();
s.on("predict", d=>{
  let cls = d.pick==="T"?"tai":(d.pick==="X"?"xiu":"skip");
  document.getElementById("predict").innerHTML =
    'Dự đoán: <span class="badge '+cls+'">'+d.pick+'</span> — '+
    (d.conf*100).toFixed(1)+'%';
});
s.on("round", r=>{
  let log=document.getElementById("log");
  let t=new Date().toLocaleTimeString('vi-VN',{hour12:false});
  log.innerHTML =
    '<div class="row"><span class="time">'+t+
    '</span> — <span class="sum">SUM:'+r.sum+
    '</span> — <span class="'+(r.rs==="T"?"rsT":"rsX")+'">'+r.rs+
    '</span></div>'+log.innerHTML;
});
</script>
</body>
</html>
  `);
});

function pushUI(e,d){ io.emit(e,d); }

/* ===== TOKEN / LOGIN ===== */
const TOKEN_FILE="token.txt";
function loadToken(){return fs.existsSync(TOKEN_FILE)?fs.readFileSync(TOKEN_FILE,"utf8").trim():null;}
function saveToken(t){fs.writeFileSync(TOKEN_FILE,t);}
function clearToken(){try{fs.unlinkSync(TOKEN_FILE);}catch{}}

/* ===== LOGIN API ===== */
const LOGIN_DATA = {
  username: process.env.DATALOGIN_USER,
  password: process.env.DATALOGIN_PASS,
  app_id: "iwin.club",
  os: "iOS",
  device: "Phone",
  browser: "App",
  fg: "9D747A41-763C-4811-BA92-688AA38A8AAC",
  aff_id: "iwin",
  bundleid: "com.sunny.eclipselight",
  version: "2.39.8"
};

function loginGetToken(){
  return new Promise(resolve=>{
    const cached = loadToken();
    if(cached){
      console.log("DÙNG TOKEN ĐÃ LƯU");
      return resolve(cached);
    }

    const data = JSON.stringify(LOGIN_DATA);

    const req = https.request({
      hostname:"getquayaybiai.gwyqinbg.com",
      path:"/user/login.aspx",
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Content-Length":Buffer.byteLength(data)
      }
    },res=>{
      let body="";
      res.on("data",c=>body+=c);
      res.on("end",()=>{
        try{
          const j=JSON.parse(body);
          if(j.status==="OK" && j.data?.[0]?.token){
            const t=j.data[0].token;
            saveToken(t);
            console.log("LOGIN THÀNH CÔNG");
            return resolve(t);
          }
        }catch(e){}
        console.log("LOGIN FAIL");
        resolve(null);
      });
    });

    req.on("error",()=>resolve(null));
    req.write(data);
    req.end();
  });
}

/* ===== WS CORE ===== */
const WS_URL="wss://minysgwpry.ywinsockec.com/websocket";
const ORIGIN="https://minysgwpry.ywinsockec.com";

let ws,TOKEN=null,sessionCount=0,roundId=0;

function tokenFail(pkt){
  return Array.isArray(pkt)&&pkt[0]===1&&pkt[1]===false&&pkt[2]===100;
}

/* ===== CONNECT WS ===== */
async function connect(){

  if(!TOKEN){
    TOKEN = await loginGetToken();
    if(!TOKEN){
      console.log("LOGIN ERROR — RETRY");
      return setTimeout(connect,3000);
    }
  }

  console.log("CONNECT WS…");
  ws=new WebSocket(WS_URL,{headers:{Origin:ORIGIN}});

  ws.on("open",()=>{
    ws.send(JSON.stringify([1,"MiniGame","","",{agentId:"1",accessToken:TOKEN,reconnect:true}]));
  });

  ws.on("message",handleMsg);
  ws.on("close",()=>setTimeout(connect,2000));
}

/* ===== HANDLE DATA ===== */
async function handleMsg(data){
  let pkt; try{pkt=JSON.parse(data.toString());}catch{return;}

  if(tokenFail(pkt)){
    console.log("TOKEN HẾT HẠN — LOGIN LẠI");
    clearToken();TOKEN=null;ws.close();
    return;
  }

  if(pkt[0]!==5) return;
  const p=pkt[1];

  if(p.cmd===6005){
    const pred=await predictV3(history,lastSum);
    pushUI("predict",pred);
    return;
  }

  if(p.cmd===1015 && p.d?.cmd===6006){

    const d=p.d;
    const sum=d.d1+d.d2+d.d3;
    const rs=sum>=11?"T":"X";

    lastSum=sum;
    roundId++;

    history.push({rs,sum});
    if(history.length>200) history.shift();

    await learnV3(history,sum,rs,d.d1,d.d2,d.d3);

    pushUI("round",{id:roundId,sum,rs});

    if(sessionCount++>=6){
      sessionCount=0;
      ws.close();
    }
  }
}

/* ===== START APP ===== */
(async()=>{
  await dbInit();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT,()=>console.log("WEB RUNNING ON PORT",PORT));
  connect();
})();
