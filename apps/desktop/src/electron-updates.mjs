import electronUpdater from "electron-updater";
import {createRequire} from "node:module";
import {access,stat,statfs} from "node:fs/promises";
import {constants} from "node:fs";
import {dirname} from "node:path";
const require=createRequire(import.meta.url);
const {CancellationToken}=createRequire(require.resolve("electron-updater"))("builder-util-runtime");

export class ElectronUpdates {
  constructor(engine=electronUpdater.autoUpdater){
    this.engine=engine;engine.autoDownload=false;engine.autoInstallOnAppQuit=false;
    engine.disableDifferentialDownload=true;engine.disableWebInstaller=true;
    engine.logger={info(){},warn(){},error(){},debug(){}};
    engine.on("error",e=>this.errorHandler?.(e));
  }
  onError(callback){this.errorHandler=callback;}
  async configure(channel){this.engine.channel=channel==="preview"?"preview":"latest";this.engine.allowPrerelease=channel==="preview";this.engine.allowDowngrade=false;}
  async check(){
    // A timed-out check must finish before another channel starts a fresh request.
    if(this.checking)await this.checking.catch(()=>{});
    const pending=this.engine.checkForUpdates();this.checking=pending;
    try{const result=await pending;if(!result?.updateInfo)throw Error("No update information");return result.updateInfo;}finally{if(this.checking===pending)this.checking=null;}
  }
  async download(progress,signal){
    const token=new CancellationToken(),cancel=()=>token.cancel();signal.addEventListener("abort",cancel,{once:true});
    const listener=p=>progress(p);this.engine.on("download-progress",listener);
    try{if(signal.aborted)token.cancel();return await this.engine.downloadUpdate(token);}finally{signal.removeEventListener("abort",cancel);this.engine.removeListener("download-progress",listener);}
  }
  async install(){
    if(process.platform==="linux"){
      const file=process.env.APPIMAGE;if(!file)throw Error("Run the installed AppImage to update");
      await access(dirname(file),constants.W_OK);
      const [current,download]=await Promise.all([stat(file),stat(this.engine.installerPath)]);
      if(current.dev!==download.dev){const disk=await statfs(dirname(file));if(disk.bavail*disk.bsize<download.size)throw Error("Not enough room to install AppImage");}
    }
    this.engine.quitAndInstall(true,true);
  }
}
