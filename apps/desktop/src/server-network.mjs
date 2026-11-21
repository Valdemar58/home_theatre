/** Keep server bootstrap, native APIs and its web view on the same session/proxy/TLS pool. */
export class ServerNetwork {
  constructor(sessionFor){this.sessionFor=sessionFor;}
  fetch(url,options){return this.sessionFor(new URL(url).origin).fetch(url,options);}
  async route(origin){
    const route=await this.sessionFor(origin).resolveProxy(origin);
    return /^DIRECT(?:;|$)/.test(route.trim())?"direct":"proxy";
  }
}
