import {EventEmitter} from "node:events";
import {readFile,writeFile,mkdir,rename} from "node:fs/promises";
import {join} from "node:path";
import semver from "semver";

export const updateFeed="https://raw.githubusercontent.com/Valdemar58/home_theatre/desktop-updates/";
export const releasePage="https://github.com/Valdemar58/home_theatre/releases";
export const defaultChannel=version=>semver.prerelease(version)?"preview":"stable";

function userError(error,phase){
  const code=String(error?.code||"");
  if(code==="INSTALL_NOT_COMPLETED")return "Предыдущая попытка установки не завершилась. Повторите обновление или установите последнюю сборку вручную.";
  if(["ERR_CHECKSUM_MISMATCH","ERR_UPDATER_CHECKSUM_MISMATCH","ERR_UPDATER_INVALID_SIGNATURE","ERR_UPDATER_SIGNATURE_UNVERIFIABLE"].includes(code))return "Проверка установщика не пройдена. Пакет не будет запущен. Повторите скачивание.";
  if(code==="INVALID_UPDATE_VERSION")return "Источник обновлений вернул некорректную версию. Подключение к серверу остановлено.";
  if(code==="UPDATE_CHANNEL_MISMATCH")return "В стабильном канале опубликована тестовая сборка. Подключение остановлено.";
  if(code==="INVALID_UPDATE_SETTINGS")return "Не удалось прочитать настройки обновления. Выберите канал заново.";
  return phase==="downloading"?"Не удалось скачать или проверить обновление. Проверьте подключение и свободное место и повторите попытку.":phase==="installing"?"Не удалось запустить установку. Повторите попытку или установите последнюю сборку вручную.":"Не удалось проверить обновления. Проверьте соединение и повторите попытку. Подключение к серверу пока остановлено.";
}

/** Startup barrier: no media/API services are allowed until `ready` resolves. */
export class StartupUpdates extends EventEmitter {
  constructor({directory,version,adapter,packaged=true,checkTimeout=30000,downloadTimeout=60000}){
    super();this.directory=directory;this.file=join(directory,"updates.json");this.version=version;this.adapter=adapter;this.packaged=packaged;
    this.checkTimeout=checkTimeout;this.downloadTimeout=downloadTimeout;this.busy=false;this.loaded=false;this.settings={schema:1,channel:defaultChannel(version),attempt:null};
    this.state={status:"checking",version,channel:this.settings.channel,runtimeReady:false};
    this.ready=new Promise(resolve=>{this.resolveReady=resolve;});
    adapter?.onError?.(e=>{if(this.state.status==="installing")this.fail(e,"installing");});
  }
  snapshot(){return {...this.state};}
  publish(fields){this.state={...this.state,...fields};this.emit("state",this.snapshot());}
  async load(){
    if(this.loaded)return;
    try{const s=JSON.parse(await readFile(this.file,"utf8"));if(s.schema!==1||!["stable","preview"].includes(s.channel))throw Error();this.settings=s;}
    catch(e){if(e.code!=="ENOENT"){const error=Error("Update settings are invalid");error.code="INVALID_UPDATE_SETTINGS";throw error;}}
    this.loaded=true;
  }
  async save(){await mkdir(this.directory,{recursive:true});await writeFile(this.file+".tmp",JSON.stringify(this.settings),{mode:0o600});await rename(this.file+".tmp",this.file);}
  fail(error,phase){this.publish({status:"error",error:userError(error,phase),code:String(error?.code||"UPDATE_FAILED"),progress:undefined});}
  markRuntimeReady(){this.publish({runtimeReady:true});}
  async channel(channel){
    if(!["stable","preview"].includes(channel))throw Error("Неизвестный канал обновлений");
    if(this.busy||this.state.status==="installing")throw Error("Дождитесь завершения обновления");
    if(!this.loaded){this.settings={schema:1,channel,attempt:null};this.loaded=true;}else this.settings.channel=channel;
    await this.save();this.publish({channel,error:null});
    if(!this.state.runtimeReady)void this.run({retry:true});
    return this.snapshot();
  }
  async run({retry=false}={}){
    if(this.busy||this.state.status==="installing")return false;
    if(this.state.runtimeReady)throw Error("Проверка и установка выполняются перед подключением. Перезапустите приложение.");
    this.busy=true;let phase="checking";
    try{
      if(!this.packaged){this.publish({status:"development",error:null});this.resolveReady();return true;}
      await this.load();
      this.publish({status:"checking",channel:this.settings.channel,error:null,progress:undefined});
      await this.adapter.configure(this.settings.channel);
      let info=await this.timed(this.adapter.check(),this.checkTimeout);this.validate(info);
      if(!semver.gt(info.version,this.version)){
        this.settings.attempt=null;await this.save();this.publish({status:"ready",target:undefined});this.resolveReady();return true;
      }
      for(let round=0;;round++){
        if(round>=3)throw Error("Update feed keeps changing");
        this.publish({target:info.version});
        if(!retry&&this.settings.attempt?.from===this.version&&this.settings.attempt?.to===info.version)throw Object.assign(Error("Install did not finish"),{code:"INSTALL_NOT_COMPLETED"});
        phase="downloading";this.publish({status:phase,progress:0,transferred:0,total:0});
        this.abort=new AbortController();let watchdog;
        const reset=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>this.abort.abort(Error("Download stalled")),this.downloadTimeout);};reset();
        try{await this.adapter.download(p=>{reset();this.publish({progress:Math.max(0,Math.min(100,Number(p.percent)||0)),transferred:Math.max(0,Number(p.transferred)||0),total:Math.max(0,Number(p.total)||0)});},this.abort.signal);}finally{clearTimeout(watchdog);this.abort=null;}
        phase="checking";this.publish({status:"checking",detail:"downloaded"});
        const latest=await this.timed(this.adapter.check(),this.checkTimeout);this.validate(latest);
        if(latest.version===info.version&&JSON.stringify(latest.files)===JSON.stringify(info.files))break;
        if(!semver.gt(latest.version,this.version)){
          this.settings.attempt=null;await this.save();this.publish({status:"ready",target:undefined});this.resolveReady();return true;
        }
        info=latest;
      }
      this.settings.attempt={from:this.version,to:info.version,at:Date.now()};await this.save();
      phase="installing";this.publish({status:phase,progress:100});
      await this.adapter.install();
      return false;
    }catch(error){this.fail(error,phase);return false;}finally{this.busy=false;}
  }
  validate(info){
    if(!semver.valid(info?.version))throw Object.assign(Error("Invalid release version"),{code:"INVALID_UPDATE_VERSION"});
    if(!Array.isArray(info.files)||!info.files.length||info.files.some(f=>typeof f.url!=="string"||typeof f.sha512!=="string"||!Number.isFinite(f.size)||f.size<=0))throw Object.assign(Error("Invalid release metadata"),{code:"INVALID_UPDATE_VERSION"});
    if(this.settings.channel==="stable"&&semver.prerelease(info.version))throw Object.assign(Error("Preview in stable channel"),{code:"UPDATE_CHANNEL_MISMATCH"});
  }
  async timed(promise,timeout){let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error("Update check timed out"),{code:"UPDATE_TIMEOUT"})),timeout);})]);}finally{clearTimeout(timer);}}
  cancel(){this.abort?.abort();}
}
