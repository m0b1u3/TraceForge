/** Compact fallback; URL credentials and query strings never enter the title. */
export function conversationTitle(text:string):string {
  const readable=text.trim().replace(/https?:\/\/[^\s，。；！？]+/gu,value=>{try{return new URL(value).hostname;}catch{return "网页";}}).split(/[\n。！？；]/u)[0]?.trim()||"新对话";
  const chars=Array.from(readable);
  return chars.length>28?`${chars.slice(0,27).join("")}…`:readable;
}
