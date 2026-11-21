import {product} from "./product.mjs";

export const clientCapabilities=Object.freeze(["accounts-v1","device-binding-v1","desktop-commands-v1","host-transport-v2"]);
const requiredServerCapabilities=clientCapabilities;
export function assessServer(info){
  if(info?.service!=="home_theater")throw Error("Это другой сервис или сервер ещё не поддерживает desktop.");
  // Explicit compatibility with the deployed, pre-manifest protocol 2 API.
  if(!Object.hasOwn(info,"desktop")){
    if(info.desktopProtocol!==product.protocol)throw Error("Протокол сервера не поддерживается. Обновите сервер или выберите совместимый сервер.");
    return {legacy:true,protocol:product.protocol,name:String(info.name||"").slice(0,80)};
  }
  const d=info.desktop,p=d?.protocol;
  if(d?.manifestVersion!==1||!Number.isSafeInteger(p?.min)||!Number.isSafeInteger(p?.max)||p.min<1||p.max<p.min||!Array.isArray(d.capabilities)||!Array.isArray(d.requiredClientCapabilities)||[...d.capabilities,...d.requiredClientCapabilities].some(x=>typeof x!=="string"||x.length>100))throw Error("Сервер вернул неподдерживаемое описание совместимости. Обновите сервер.");
  if(product.protocol<p.min||product.protocol>p.max)throw Error(`Сервер поддерживает протокол ${p.min}–${p.max}, приложение — ${product.protocol}. Выберите совместимый сервер или канал обновления приложения.`);
  if(requiredServerCapabilities.some(c=>!d.capabilities.includes(c)))throw Error("Сервер не предоставляет обязательные возможности desktop. Обновите сервер.");
  if(d.requiredClientCapabilities.some(c=>!clientCapabilities.includes(c)))throw Error("Сервер требует возможности, которых нет в этой версии desktop. Проверьте канал обновления или используйте совместимый сервер.");
  return {legacy:false,protocol:product.protocol,name:String(info.name||"").slice(0,80)};
}

/** Short-lived, per-origin admission; no persisted success or credential fallback. */
export class ServerCompatibility {
  constructor(fetcher,{ttl=30000,clock=Date.now,onState=()=>{},requestTimeout=45000,getRoute}={}){this.fetcher=fetcher;this.ttl=ttl;this.clock=clock;this.onState=onState;this.requestTimeout=requestTimeout;this.getRoute=getRoute;this.entries=new Map();this.generations=new Map();}
  reject(origin,message){this.generations.set(origin,(this.generations.get(origin)||0)+1);const error=Error(message);this.entries.set(origin,{error});this.onState(origin,{status:"blocked",error:message});return error;}
  async ensure(origin,{force=false}={}){
    if(!origin)throw Error("Сначала выберите сервер");
    if(force){this.generations.set(origin,(this.generations.get(origin)||0)+1);this.entries.delete(origin);}
    const entry=this.entries.get(origin);
    if(entry?.error)throw entry.error;
    if(entry?.pending)return entry.pending;
    if(entry?.result&&this.clock()-entry.at<this.ttl)return entry.result;
    const generation=this.generations.get(origin)||0;
    const current={};this.entries.set(origin,current);this.onState(origin,{status:"checking",phase:"connecting"});
    current.pending=(async()=>{
      let route;
      try{
        const signal=AbortSignal.timeout(this.requestTimeout);
        if(this.getRoute){let timer;try{route=await Promise.race([this.getRoute(origin).catch(()=>undefined),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}}
        if((this.generations.get(origin)||0)!==generation)throw Error("Проверка сервера отменена. Повторите подключение.");
        this.onState(origin,{status:"checking",phase:"connecting",route});
        let response;
        for(let attempt=1;attempt<=2;attempt++){
          signal.throwIfAborted();
          if((this.generations.get(origin)||0)!==generation)throw Error("Проверка сервера отменена. Повторите подключение.");
          try{response=await this.fetcher(origin+"/api/desktop/info",{credentials:"omit",redirect:"error",cache:"no-store",headers:{Accept:"application/json"},signal});break;}
          catch(error){
            // Only an anonymous, read-only handshake may retry. Never repeat a login or command.
            if(attempt===2||signal.aborted||!(error.name==="TypeError"||/^net::ERR_(CONNECTION|PROXY_CONNECTION|TUNNEL_CONNECTION|NAME_NOT_RESOLVED|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT|EMPTY_RESPONSE)/.test(error.message||"")))throw error;
            if((this.generations.get(origin)||0)!==generation)throw error;
            this.onState(origin,{status:"checking",phase:"connecting",route,attempt:2});
            await new Promise(resolve=>setTimeout(resolve,250));
          }
        }
        if(!response.ok)throw Error(response.status===503?"Сервер временно недоступен или обновляется. Повторите проверку позже.":"Сервер не предоставил сведения о совместимости. Проверьте адрес и обновите сервер.");
        if((this.generations.get(origin)||0)!==generation)throw Error("Проверка сервера отменена. Повторите подключение.");
        this.onState(origin,{status:"checking",phase:"validating",route});
        const text=await response.text();if(text.length>65536)throw Error("Некорректное описание сервера");
        const result=assessServer(JSON.parse(text));
        if((this.generations.get(origin)||0)!==generation)throw Error("Проверка сервера отменена. Повторите подключение.");
        this.entries.set(origin,{result,at:this.clock()});this.onState(origin,{status:"ready"});return result;
      }catch(e){
        const timedOut=e.name==="TimeoutError",network=timedOut||e.name==="TypeError"||/^net::ERR_/.test(e.message||"");
        const message=e instanceof SyntaxError?"Сервер вернул некорректное описание совместимости.":network?`Не удалось завершить HTTPS-соединение${route==="proxy"?" через системный прокси":""}. ${timedOut?"Время ожидания истекло. Повторите проверку.":"Проверьте соединение, сертификат и адрес сервера."}`:e.message;
        if((this.generations.get(origin)||0)===generation){const code=timedOut?"SERVER_CONNECTION_TIMEOUT":network?"SERVER_NETWORK_ERROR":"SERVER_CHECK_FAILED";const error=Object.assign(Error(message),{code,cause:e});this.entries.set(origin,{error});this.onState(origin,{status:"blocked",error:message,code,route});throw error;}
        throw e;
      }
    })();return current.pending;
  }
}
