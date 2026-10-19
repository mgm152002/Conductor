/** Renderer navigation stays on its exact application document or development origin. */
export function isApplicationUrl(candidate:string,applicationUrl:string):boolean {
  try {
    const target=new URL(candidate);const application=new URL(applicationUrl);
    if (application.protocol==='file:') return target.protocol==='file:' && target.host===application.host && target.pathname===application.pathname && target.search===application.search;
    return ['http:','https:'].includes(application.protocol) && target.origin===application.origin;
  }catch{return false;}
}
