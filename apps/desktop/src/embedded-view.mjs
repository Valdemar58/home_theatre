import { WebContentsView } from "electron";

// Trusted local panels and remote pages share one native window, but never a preload.
export class EmbeddedView {
  constructor(owner, webPreferences, bounds) {
    this.owner=owner;this.view=new WebContentsView({webPreferences});
    this.webContents=this.view.webContents;this.bounds=bounds;this.visible=false;
    this.resize=()=>this.layout();owner.on("resize",this.resize);
    this.view.setBackgroundColor("#111827");this.layout();
  }
  isDestroyed(){return this.webContents.isDestroyed();}
  layout(){if(this.isDestroyed()||this.owner.isDestroyed())return;const {width,height}=this.owner.getContentBounds();this.view.setBounds(this.bounds?this.bounds(width,height):{x:0,y:0,width,height});}
  getBounds(){return this.owner.getBounds();}
  getContentBounds(){return this.owner.getContentBounds();}
  show(){if(this.isDestroyed())return;this.owner.contentView.addChildView(this.view);this.visible=true;this.layout();this.owner.show();}
  hide(){if(this.visible&&!this.owner.isDestroyed())this.owner.contentView.removeChildView(this.view);this.visible=false;}
  focus(){this.owner.focus();this.webContents.focus();}
  restore(){this.owner.restore();}
  loadURL(url){return this.webContents.loadURL(url);}
  setMenu(){}
  setMenuBarVisibility(){}
  setSize(width,height){this.bounds=(w,h)=>({x:10,y:40,width:Math.min(width,w-20),height:Math.min(height,h-50)});this.layout();}
  destroy(){this.hide();this.owner.removeListener("resize",this.resize);if(!this.isDestroyed())this.webContents.close();}
  close(){this.destroy();}
}
