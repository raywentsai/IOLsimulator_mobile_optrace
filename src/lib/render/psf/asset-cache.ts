// Byte-accounted LRU. Active render assets can be pinned while yielding to messages.
export class AssetCache<T> {
  private items=new Map<string,{value:T;bytes:number}>();
  private used=0;
  readonly pinned=new Set<string>();
  readonly budget:number;
  private release?:(value:T)=>void;
  constructor(budget:number,release?:(value:T)=>void) {this.budget=budget;this.release=release;}
  get(key:string):T|undefined {
    const item=this.items.get(key);
    if(item){this.items.delete(key);this.items.set(key,item);}
    return item?.value;
  }
  set(key:string,value:T,bytes:number,retained:readonly string[]=[]):void {
    if(bytes>this.budget||bytes<0)throw new Error('Asset exceeds memory budget');
    const old=this.items.get(key);
    const protectedKey=(candidate:string)=>this.pinned.has(candidate)||retained.includes(candidate);
    const protectedBytes=[...this.items].reduce((n,[k,v])=>n+(k!==key&&protectedKey(k)?v.bytes:0),0);
    if(protectedBytes+bytes>this.budget)throw new Error('Active assets exceed memory budget');
    if(old)this.delete(key);
    while(this.used+bytes>this.budget){
      const oldest=[...this.items.keys()].find(k=>!protectedKey(k))!;
      this.delete(oldest);
    }
    this.items.set(key,{value,bytes});this.used+=bytes;
  }
  delete(key:string):boolean {
    const item=this.items.get(key);
    if(!item)return false;
    this.items.delete(key);this.used-=item.bytes;this.release?.(item.value);return true;
  }
  clear():void {for(const key of this.items.keys())this.delete(key);this.pinned.clear();}
  info():{keys:string[];bytes:number} {return {keys:[...this.items.keys()],bytes:this.used};}
}
