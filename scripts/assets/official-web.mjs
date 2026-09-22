function abs(base, value) {
  try { return new URL(String(value).replace(/&amp;/g, "&"), base).toString(); } catch { return null; }
}
function hostAllowed(url, allowed) {
  try {
    const h=new URL(url).hostname.toLowerCase();
    return allowed.some((d)=>h===d || h.endsWith("." + d));
  } catch { return false; }
}
function collect(html, pageUrl, allowed) {
  const found=[];
  const add=(raw,kind,context="")=>{
    const url=abs(pageUrl,raw);
    if (url && /^https:/.test(url) && hostAllowed(url,allowed) && !found.some(x=>x.url===url)) found.push({url,kind,context:String(context||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()});
  };
  const text=String(html||"").replace(/\\u002F/gi,"/").replace(/\\u0026/gi,"&").replace(/\\u003A/gi,":").replace(/\\\//g,"/");
  for (const m of text.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["'][^>]*>/gi)) add(m[1],"meta");
  for (const m of text.matchAll(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi)) add(m[1],"meta");
  for (const m of text.matchAll(/<(?:img|source)\b[^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi)) add(m[1],"image",m[0]);
  for (const m of text.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const tag=m[0], alt=/\b(?:alt|aria-label|title)=["']([^"']+)["']/i.exec(tag)?.[1]||"";
    for (const a of tag.matchAll(/\b(?:src|data-src|data-lazy-src)=["']([^"']+)["']/gi)) add(a[1],"described-image",alt);
  }
  for (const m of text.matchAll(/<(?:img|source)\b[^>]*(?:srcset|data-srcset)=["']([^"']+)["'][^>]*>/gi))
    for (const part of m[1].split(",")) add(part.trim().split(/\s+/)[0],"srcset");
  for (const m of text.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(m[1],"css");
  for (const m of text.matchAll(/["'](https:\/\/[^"'\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\\]*)?)["']/gi)) add(m[1],"json");
  for (const m of text.matchAll(/(?:src|url|image|desktop|mobile|media)["']?\\s*[:=]\\s*["']([^"']+\.(?:jpe?g|png|webp|avif)(?:\?[^"']*)?)["']/gi)) add(m[1],"structured");
  for (const m of text.matchAll(/https:\/\/[^\\s"'<>\\]+\.(?:jpe?g|png|webp|avif)(?:\?[^\\s"'<>\\]*)?/gi)) add(m[0],"absolute");
  return found;
}
export function createOfficialWebAdapter({ registryEntry, fetchPage, inspectMedia, owner, providerName }) {
  const domains=[...(registryEntry?.domains||[]),...(registryEntry?.cdn_domains||[])].map(x=>x.toLowerCase());
  return {
    name:providerName,
    isEligibleForCoverage(queries){ return registryEntry?.approved===true && queries.some(q=>[...(registryEntry.pages||[]),...(registryEntry.approved_static_assets||[]),...(registryEntry.approved_described_assets||[])].some(p=>String(p.target_entity||"").toLowerCase()===String(q.target_entity||"").toLowerCase())); },
    async search(query){
      const target=String(query.target_entity||"").toLowerCase();
      const pages=(registryEntry?.pages||[]).filter(p=>String(p.target_entity).toLowerCase()===target);
      const staticAssets=(registryEntry?.approved_static_assets||[]).filter(a=>String(a.target_entity||"").toLowerCase()===target);
      const descriptors=(registryEntry?.approved_described_assets||[]).filter(a=>String(a.target_entity||"").toLowerCase()===target);
      const out=[];
      for (const asset of staticAssets) {
        try {
          if (!hostAllowed(asset.asset_url, domains) || !hostAllowed(asset.page_url, domains)) continue;
          const page=await fetchPage(asset.page_url);
          if (!page?.ok || !hostAllowed(page.url,domains)) continue;
          const media=await inspectMedia(asset.asset_url);
          const mime=String(media?.contentType||asset.mime_type||"").split(";",1)[0].trim().toLowerCase();
          if (!media?.ok || !mime.startsWith("image/")) continue;
          out.push({
            provider:String(registryEntry.id),type:"image",
            title:String(query.target_entity)+" verified official hardware",
            description:"Verified first-party official asset for "+String(query.target_entity)+".",
            tags:[String(query.target_entity),"official","console",owner],
            sourceUrl:asset.asset_url,downloadUrl:asset.asset_url,creator:null,license:null,licenseUrl:null,
            attribution:owner+" / "+providerName,width:asset.width||null,height:asset.height||null,mimeType:mime,
            rights_class:"copyrighted_editorial",copyright_owner:owner,
            source_type:asset.source_type||"official_static_asset",provenance_page_url:asset.page_url,
            source_domain:new URL(asset.asset_url).hostname.toLowerCase(),retrieved_at:new Date().toISOString(),
            editorial_use_only:true,license_status:"no_open_license_identified",
            provenance_status:"verified_first_party",official_source_registry_id:registryEntry.id
          });
        } catch {}
      }
      for(const desc of descriptors){
        try{
          const page=await fetchPage(desc.page_url);
          if(!page?.ok || !hostAllowed(page.url,domains)) continue;
          const items=collect(page.text||page.bodyText||page.body||"",desc.page_url,domains);
          const wanted=String(desc.descriptor||"").toLowerCase();
          const matches=items.filter(x=>String(x.context||"").toLowerCase().includes(wanted));
          for(const item of matches.slice(0,2)){
            const media=await inspectMedia(item.url);
            const mime=String(media?.contentType||"").split(";",1)[0].trim().toLowerCase();
            if(!media?.ok || !mime.startsWith("image/")) continue;
            out.push({provider:String(registryEntry.id),type:"image",title:String(query.target_entity)+" verified official hardware",description:desc.descriptor,tags:[String(query.target_entity),"official","console",owner],sourceUrl:item.url,downloadUrl:item.url,creator:null,license:null,licenseUrl:null,attribution:owner+" / "+providerName,width:null,height:null,mimeType:mime,rights_class:"copyrighted_editorial",copyright_owner:owner,source_type:"official_described_asset",provenance_page_url:desc.page_url,source_domain:new URL(item.url).hostname.toLowerCase(),retrieved_at:new Date().toISOString(),editorial_use_only:true,license_status:"no_open_license_identified",provenance_status:"verified_first_party",official_source_registry_id:registryEntry.id});
          }
        }catch{}
      }
      for(const spec of pages){
        try{
          const page=await fetchPage(spec.page_url);
          if(!page?.ok || !hostAllowed(page.url,domains)) continue;
          const html=page.text||page.bodyText||page.body||"";
          for(const item of collect(html,spec.page_url,domains)){
            if(out.length>=6) break;
            const media=await inspectMedia(item.url);
            const mime=String(media?.contentType||"").split(";",1)[0].trim().toLowerCase();
            if(!media?.ok || !mime.startsWith("image/")) continue;
            out.push({
              provider:String(registryEntry.id),type:"image",
              title:String(query.target_entity)+" official hardware",
              description:"First-party official web image for "+String(query.target_entity)+".",
              tags:[String(query.target_entity),"official","console",owner],
              sourceUrl:item.url,downloadUrl:item.url,creator:null,license:null,licenseUrl:null,
              attribution:owner+" / "+providerName,width:null,height:null,mimeType:mime,
              rights_class:"copyrighted_editorial",copyright_owner:owner,
              source_type:"official_web_page",provenance_page_url:spec.page_url,
              source_domain:new URL(item.url).hostname.toLowerCase(),retrieved_at:new Date().toISOString(),
              editorial_use_only:true,license_status:"no_open_license_identified",
              provenance_status:"verified_first_party",official_source_registry_id:registryEntry.id
            });
          }
        }catch{}
      }
      return out;
    }
  };
}
